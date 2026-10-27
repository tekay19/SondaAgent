// Sonda orkestratörü: yönetici (Claude) keşfeder ve planı onaylar → Claude mühendis planlar → ajan kodlar (isteğe
// bağlı TDD) → Sonda doğrular → bağımsız inceleme → faz kapılarında Claude derin inceleme + uzman paneli +
// güvenlik → gerekirse ajan düzeltir → son test (tarayıcı + ekran görüntüsü) → rapor.
// Bu dosya çekirdektir (durum, günlük, commit, ajan/yönetici çağrıları, iptal). Diğer yöntemler sorumluluklarına
// göre aynı klasördeki parçalarda tanımlıdır ve sınıfa eklenir: planning, maintenance, pipeline, task, review, findings.
const settings = require('../settings');
const anthropic = require('../anthropic');
const claudecli = require('../claudecli');
const opencodecli = require('../opencodecli');
const localllm = require('../localllm');
const agents = require('../agents');
const project = require('../project');
const jobs = require('../jobs');
const procs = require('../procs');
const secrets = require('../secrets');
const envfile = require('../envfile');
const net = require('../net');
const P = require('../prompts');
const { claudeModelOf, claudeModelLabel, briefModelOf, roleModelOf, codexModelFor } = require('../models');
const { ACTIVE_TASK, guessLang, mixin } = require('./shared');

// Bir adımda bağlantı kesintisi nedeniyle en çok kaç kez yeniden denenir (her deneme bağlantının gelmesini bekler).
const MAX_OFFLINE_RETRIES = 6;
// Doğrulama komutunun çıktısında bağlantı kesintisi imzası: ad çözülemiyor / paket deposuna ulaşılamıyor.
// (ECONNREFUSED ve ETIMEDOUT yok: yerel bir servisin kapalı olması internet kesintisi değildir.)
const OFFLINE_OUTPUT = /ENOTFOUND|EAI_AGAIN|getaddrinfo|ENETUNREACH|ENETDOWN|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|could not resolve host|temporary failure in name resolution|network is unreachable|npm (error|ERR!) network/i;

class Orchestrator {
  constructor({ emit }) {
    this.emit = emit;
    this.job = null;
    this.ctrl = null;
    this.running = false;
    this.crash = null;
    this.useGit = false;
    this.netWait = null; // süren bağlantı beklemesi (paralel adımlar ortak bekler)
    // main.js ayarlar: kullanıcı "Uygulamayı çalıştır" ile bu klasörde sunucu açtıysa ona dokunma.
    this.appRunningFor = () => false;
  }

  // Ajanların proje klasöründe açık bıraktığı geliştirme süreçlerini (ör. dev sunucusu) kapatır.
  async cleanupOrphans(when) {
    const dir = this.job?.projectDir;
    if (!dir || this.appRunningFor(dir)) return;
    try {
      const killed = await procs.killOrphans(dir);
      if (killed.length) this.log('system', 'warn', `${when}: ajanın açık bıraktığı ${killed.length} süreç kapatıldı (${[...new Set(killed.map((p) => p.name))].join(', ')}).`);
    } catch {
      /* en iyi çaba */
    }
  }

  // ---------- genel ----------
  snapshot() {
    return this.job ? { ...this.job } : null;
  }

  update(patch = {}) {
    Object.assign(this.job, patch);
    jobs.save(this.job);
    this.emit({ type: 'job', job: this.snapshot() });
  }

  // Yeni iş: kayıt hemen diske yazılır (arayüz işi açtığında dosya hazır olsun), sonra duyurulur.
  created() {
    jobs.save(this.job, { immediate: true });
    this.emit({ type: 'job', job: this.snapshot() });
  }

  setTask(task, patch) {
    Object.assign(task, patch);
    this.update();
  }

  log(src, lvl, text) {
    if (!this.job || text == null) return;
    let line = String(text);
    const entry = { t: Date.now(), src, lvl, text: this.redactor()(line) };
    jobs.appendLog(this.job.id, entry);
    this.emit({ type: 'log', jobId: this.job.id, entry });
  }

  get signal() {
    return this.ctrl?.signal;
  }

  checkAbort() {
    if (this.signal?.aborted) throw new Error('Durduruldu');
  }

  // ---------- .env değerleri ----------
  redactor() {
    const dir = this.job?.projectDir;
    const key = `${dir}:${secrets.version()}`;
    if (this._redKey !== key) {
      this._redKey = key;
      this._red = envfile.makeRedactor(dir ? secrets.sensitive(dir) : {});
    }
    return this._red;
  }

  // Doğrulama kapısı servisleri (docker compose, veritabanı) kurar; bunlar .env ister. Yoksa ya da eksikse .env.example'dan
  // tamamlanır (var olan satırlara dokunulmaz). Değerler günlüğe yazılmaz.
  localEnv() {
    const job = this.job;
    if (!job) return;
    try {
      const r = secrets.ensureLocalEnv(job.projectDir);
      if (!r || (!r.created && !r.added.length)) return;
      const gen = r.generated.length ? `; ${r.generated.join(', ')} rastgele üretildi (yalnızca yerel geliştirme için)` : '';
      this.log('system', 'info', r.created ? `.env oluşturuldu (.env.example'dan${gen}).` : `.env'ye ${r.added.length} eksik değişken eklendi (${r.added.join(', ')}${gen}).`);
    } catch (e) {
      this.log('system', 'warn', `.env tamamlanamadı: ${e.message}`);
    }
  }

  // Kullanıcının girdiği değerleri projenin .env dosyasına yazar (ajan dosyayı ezmiş olsa bile geri koyar)
  // ve ajanların / yöneticinin göreceği ad listesini günceller. Değerler hiçbir isteme girmez.
  syncEnv() {
    const job = this.job;
    if (!job) return;
    try {
      const written = secrets.sync(job.projectDir);
      const sum = secrets.summary(job.projectDir);
      const prev = job.env || {};
      job.env = sum;
      if (written.length && sum.names.join() !== (this._envLogged || '')) {
        this._envLogged = sum.names.join();
        this.log('system', 'info', `🔑 .env güncellendi: ${sum.names.length} değer (${sum.names.join(', ')}). Ajanlar yalnızca adları görür.`);
      }
      if (sum.missing.length && sum.missing.join() !== (prev.missing || []).join()) {
        this.log('system', 'warn', `Projenin istediği ama girilmemiş anahtarlar: ${sum.missing.join(', ')}. "Anahtarlar (.env)" bölümünden ekleyebilirsiniz.`);
      }
    } catch (e) {
      this.log('system', 'warn', `.env yazılamadı: ${e.message}`);
    }
  }

  // Commit: gizli bir değer koda karışmışsa o dosyalar commit dışında kalır ve ajana düzeltme notu düşülür.
  // `owner`: commit'in sahibi (görev kimliği, "gate", "final"). Bir görevin tabanından sonra BAŞKA bir sahibin commit'i
  // varsa o taban eskimiştir (bkz. runTask); başlangıçtaki "şartname" commit'i sahipsizdir — yarım kalan işi süpürür.
  async commit(dir, message, owner) {
    const hash = await this.commitRaw(dir, message);
    if (hash && owner) this.job.lastCommit = { owner, at: Date.now() };
    return hash;
  }

  commitRaw(dir, message) {
    return project.commitAll(dir, message, {
      secretNeedles: secrets.needles(dir),
      onLeak: (files) => {
        this.log('system', 'warn', `Gizli değer içeren dosya commit dışında bırakıldı: ${files.join(', ')}. Ajan bir anahtarı koda yazmış; sonraki adımda ortam değişkenine taşıması istenecek.`);
        const note = `Files ${files.join(', ')} contain a literal secret value that belongs in .env. Replace it with the environment variable (e.g. process.env.NAME); never hardcode secrets.`;
        this.job.carryOver = [...new Set([...(this.job.carryOver || []), note])].slice(-30);
      },
      onScanFail: () => this.log('system', 'warn', 'Gizli değer taraması tamamlanamadı (git hatası ya da zaman aşımı); güvenlik için bu commit atlandı. Değişiklikler çalışma klasöründe duruyor, bir sonraki commit\'e girecek.'),
    });
  }

  guarded(fn) {
    this.running = true;
    this.crash = null;
    const ctrl = (this.ctrl = new AbortController());
    this.emit({ type: 'busy', busy: true });
    let work;
    try {
      work = Promise.resolve(fn());
    } catch (err) {
      work = Promise.reject(err);
    }
    work
      .catch((err) => this.fail(err))
      .finally(() => {
        // Bu çalışmaya ait hiçbir süreç (paralel inceleme oturumu, komut, istek) arkada kalmasın.
        ctrl.abort();
        this.running = false;
        if (this.ctrl === ctrl) this.ctrl = null;
        if (this.job) jobs.save(this.job, { immediate: true });
        this.emit({ type: 'busy', busy: false });
      })
      // Hata yolunun kendisi (kayıt, bildirim) hata verse bile işlenmemiş bir Promise reddi ana süreci düşürmesin.
      .catch((err) => console.error('[sonda] iş zinciri:', err));
  }

  // İnceleme önerileri her kapı ve son kabul istemine girer: tekrarlar atılır, en yeni 60 öneri tutulur.
  addSuggestions(list) {
    const all = [...(this.job.suggestions || []), ...(list || [])].filter((x) => typeof x === 'string' && x.trim());
    this.job.suggestions = [...new Set(all.reverse())].reverse().slice(-60);
  }

  /**
   * Paralel adımlar (yönetici incelemesi + Claude derin inceleme + uzman paneli…). Biri beklenmedik bir hata
   * verirse diğerleri arkada çalışmaya devam ETMEZ: hepsi durdurulur, bitmeleri beklenir ve ilk hata yukarı
   * taşınır. Aksi halde iş "hata" durumuna geçtikten sonra da ajan oturumları sürer ve "Sürdür" ile başlayan
   * yeni çalışmanın dosyalarına dokunabilirdi.
   */
  async together(steps) {
    const results = await Promise.allSettled(
      steps.map((step) =>
        Promise.resolve(step).catch((err) => {
          if (!this.signal?.aborted) {
            this.crash = this.crash || err;
            this.ctrl?.abort();
          }
          throw err;
        })
      )
    );
    const bad = results.find((r) => r.status === 'rejected');
    if (bad) throw this.crash || bad.reason;
    return results.map((r) => r.value);
  }

  fail(err) {
    if (!this.job) return;
    // Kullanıcı durdurduysa "durduruldu"; paralel bir adımın hatası yüzünden durdurulduysa gerçek hata gösterilir.
    const error = this.crash || err;
    const aborted = this.signal?.aborted && !this.crash;
    for (const t of this.job.tasks) if (ACTIVE_TASK.has(t.status)) t.status = aborted ? 'pending' : 'failed';
    if (aborted) {
      this.log('system', 'warn', 'İş durduruldu.');
      this.update({ phase: 'stopped', currentTaskId: null, waitUntil: null });
    } else {
      const message = error?.message || String(error);
      this.log('system', 'error', message);
      // Oturum sorunu: arayüz "Giriş yap" düğmesini doğrudan hata kutusunda gösterir.
      this.update({ phase: 'failed', error: message, errorKind: agents.AUTH_ERROR.test(message) ? 'auth' : null, currentTaskId: null, waitUntil: null });
    }
  }

  // Uygulama kapanırken: süreçleri durdur ve işi eşzamanlı olarak "durduruldu" kaydet.
  interrupt() {
    if (!this.running || !this.job) return;
    this.ctrl?.abort();
    for (const t of this.job.tasks) if (ACTIVE_TASK.has(t.status)) t.status = 'pending';
    this.job.phase = 'stopped';
    this.job.currentTaskId = null;
    this.job.waitUntil = null;
    this.job.waitKind = null;
    this.job.error = 'Uygulama kapatıldığı için iş durdu. "Sürdür" ile kaldığı yerden devam edebilirsiniz.';
    jobs.save(this.job, { immediate: true });
  }

  stop() {
    if (this.running) this.ctrl?.abort();
    else if (['awaiting_approval', 'awaiting_answers'].includes(this.job?.phase)) this.update({ phase: 'cancelled' });
  }

  // Çalışma sırasında (veya onaydan önce) kullanıcının verdiği ek talimat.
  // Sonraki tüm ajan istemlerine ve yönetici incelemelerine eklenir.
  addNote(text) {
    const note = String(text || '').trim();
    if (!note || !this.job) throw new Error('Talimat boş.');
    this.job.userNotes = [...(this.job.userNotes || []), note];
    this.log('system', 'info', `Kullanıcı talimatı eklendi: ${note}${this.running ? ' (bir sonraki ajan adımında uygulanacak)' : ''}`);
    this.update();
  }

  adopt(job) {
    if (this.running) return;
    this.job = job;
  }

  /**
   * Bağlantı kesintisi (internet / DNS yok, sunucuya ulaşılamıyor): hata ajanın ya da kodun değildir. Kısa bir
   * aradan sonra bağlantı gelene kadar beklenir (en fazla 6 saat); çağıran aynı adımı yeniden dener. Bağlantı
   * gelmezse iş açık bir hatayla durur ve "Sürdür" ile kaldığı yerden devam edilebilir.
   */
  awaitNetwork(who, host, error, attempt = 1) {
    // Paralel oturumlar (uzman paneli, derin inceleme…) aynı kesintiyi birlikte bekler: tek uyarı, tek yoklama.
    if (!this.netWait) {
      this.netWait = this.waitForNetwork(who, host, error, attempt).finally(() => {
        this.netWait = null;
      });
    }
    return this.netWait;
  }

  async waitForNetwork(who, host, error, attempt) {
    const backoff = Math.min(15000 * 2 ** (attempt - 1), 300000);
    this.log('system', 'warn', `${who} sunucusuna ulaşılamadı (${String(error || '').split('\n')[0].slice(0, 160)}). Bağlantı gelince kaldığı yerden devam edilecek — adım başarısız sayılmadı, uygulamayı açık bırakın.`);
    this.update({ waitUntil: Date.now() + backoff, waitKind: 'network' });
    try {
      await this.sleep(backoff);
      const t0 = Date.now();
      if (!(await net.waitOnline(host, { signal: this.signal }))) {
        const err = new Error(`İnternet bağlantısı ${Math.max(1, Math.round((Date.now() - t0) / 3600000))} saattir yok; iş durduruldu. Bağlantı gelince "Sürdür" ile kaldığı yerden devam edebilirsiniz.`);
        // Paralel adımlar ve yedek yollar bu hatayı yutmasın: iş bu nedenle durur.
        this.crash = this.crash || err;
        this.ctrl?.abort();
        throw err;
      }
      this.log('system', 'info', 'Bağlantı var; devam ediliyor.');
    } finally {
      if (this.job) this.update({ waitUntil: null, waitKind: null });
    }
  }

  /**
   * Doğrulama komutlarını çalıştırır (`run` → sonuç listesi ya da tek sonuç). Bir komut internet kesintisi yüzünden
   * başarısız olduysa (ör. bağımlılık kurulumu paket deposuna ulaşamadı) bu kod hatası değildir: bağlantı beklenir
   * ve komutlar yeniden çalıştırılır; aksi halde ajan var olmayan bir hatayı "düzeltmeye" gönderilirdi.
   */
  async checksOnline(run) {
    for (let attempt = 1; ; attempt++) {
      const out = await run();
      const off = [].concat(out || []).find((c) => !c.ok && !c.env && !c.expectFail && OFFLINE_OUTPUT.test(c.output || ''));
      if (!off || attempt > 3 || this.signal?.aborted) return out;
      const host = /\b(pip3?|uv|poetry|python3?)\b/.test(off.cmd || '') ? 'pypi.org' : 'registry.npmjs.org';
      // Depoya şu an ulaşılabiliyorsa hata gerçekten komutundur.
      if (await net.reachable(host)) return out;
      await this.awaitNetwork('Paket deposu', host, `${off.name}: bağlantı yok`, attempt);
      this.log('test', 'step', 'Doğrulama komutları bağlantı geldikten sonra yeniden çalıştırılıyor…');
    }
  }

  async gem({ system, parts, schema, temperature, maxOutputTokens, progressLabel }) {
    const s = this.cfg();
    let lastLog = 0;
    // Kullanıcının gizli değerleri (diff, dosya içeriği, test çıktısı içinde olsa bile) yöneticiye gitmez.
    const red = this.redactor();
    // Yönetici sağlayıcıları aynı sözleşmeyi taşır; yalnızca istemci, kimlik (CLI oturumu / anahtar / adres) ve model
    // değişir (bkz. managerTarget). Şemalar standart JSON Schema'dır.
    const { client, apiKey, baseUrl, model, host } = this.managerTarget(s);
    const who = settings.managerLabel(s);
    const args = {
      apiKey,
      baseUrl,
      model,
      settings: s,
      system: system && red(system),
      parts: (parts || []).map((p) => (typeof p?.text === 'string' ? { ...p, text: red(p.text) } : p)),
      schema: schema ? P.toJsonSchema(schema) : schema,
      temperature,
      maxOutputTokens,
      signal: this.signal,
      onUsage: (u) => {
        this.job.stats.managerTokens = (this.job.stats.managerTokens || 0) + (u.totalTokenCount || 0);
      },
      onProgress: (chars) => {
        if (!progressLabel || Date.now() - lastLog < 8000) return;
        lastLog = Date.now();
        this.log('manager', 'dim', `${progressLabel}… ${Math.round(chars / 1000)}K karakter`);
      },
    };
    // İstemcinin kendi yeniden denemeleri (~4 dk) bağlantı kesintisine yetmediyse bağlantı beklenir.
    // Claude CLI kullanım limitine takılırsa (abonelik) sıfırlanma saatine kadar beklenir ve aynı çağrı yinelenir.
    for (let offline = 1, waits = 0; ; ) {
      try {
        return await client.generate(args);
      } catch (e) {
        if (this.signal?.aborted) throw e;
        if (e?.limited && waits < 12) {
          waits += 1;
          const until = Math.max(e.resetAt || 0, Date.now() + 60000) + 60000;
          const hhmm = new Date(until).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
          this.log('system', 'warn', `${who} kullanım limitine takıldı (${String(e.message).split('\n')[0].slice(0, 160)}). ${hhmm}'de otomatik devam edilecek — uygulamayı açık bırakın.`);
          this.update({ waitUntil: until });
          await this.sleep(until - Date.now());
          this.update({ waitUntil: null });
          continue;
        }
        if (offline > MAX_OFFLINE_RETRIES || !client.isNetworkError(e)) throw e;
        if (!host) throw e; // yerel sunucu: internet beklemek anlamsız, hata olduğu gibi bildirilir
        await this.awaitNetwork(who, host, e.message, offline);
        offline += 1;
      }
    }
  }

  // Yönetici hedefi: seçime göre istemci, kimlik, model ve bağlantı yoklaması için sunucu (yerel sunucuda yok). Yerel model
  // ve NVIDIA NIM aynı (OpenAI uyumlu) istemciyi kullanır; OpenCode kendi sağlayıcı anahtarlarıyla CLI üzerinden çalışır.
  managerTarget(s) {
    const targets = {
      claudecli: () => ({ client: claudecli, model: settings.managerClaudeModelOf(s), host: net.HOSTS.claude }),
      anthropic: () => ({ client: anthropic, apiKey: s.anthropicKey, model: s.anthropicModel, host: net.HOSTS.claude }),
      local: () => ({ client: localllm, apiKey: s.localApiKey, baseUrl: s.localBaseUrl, model: s.localModel, host: null }),
      nim: () => ({ client: localllm, apiKey: s.nimApiKey, baseUrl: s.nimBaseUrl, model: s.nimModel, host: net.hostOf(s.nimBaseUrl) }),
      opencode: () => ({ client: opencodecli, model: opencodecli.managerModelOf(s), host: net.HOSTS.opencode }),
    };
    return targets[settings.managerBy(s)]();
  }

  // Kodlayan ya da inceleyen ajanı çalıştırır. mode: 'code' (yazma yetkili) | 'review' (salt okunur).
  // `model`: yalnızca bu oturum için Claude modeli (ör. teknik brif için Fable 5.1). Verilmezse oturumun rolüne göre
  // Ayarlar'daki model: `role` ('planner' | 'coder' | 'reviewer' | 'brief'); rol verilmezse yazma yetkili oturum kodlayıcı,
  // salt okunur oturum inceleyicidir.
  async runAgent(prompt, { resumeId, label, mode = 'code', schema, agentId, src = 'agent', timeoutMin, effort, model, role, quiet = false } = {}) {
    const job = this.job;
    const id = agentId || job.agent;
    const adapter = agents.ADAPTERS[id];
    const roleOf = role || (mode === 'review' ? 'reviewer' : 'coder');
    let currentPrompt = prompt;
    let currentResume = resumeId;
    let offline = 0;
    for (let waits = 0; ; waits++) {
      const s = this.cfg();
      job.stats.agentRuns += 1;
      if (mode === 'code') this.syncEnv();
      this.log('system', 'info', `${adapter.label} ${mode === 'review' ? 'inceliyor (salt okunur)' : 'çalışıyor'}${label ? ` · ${label}` : ''}…`);
      const res = await agents.runAgent({
        agentId: id,
        settings: { ...s, ...(timeoutMin ? { agentTimeoutMin: Math.min(s.agentTimeoutMin, timeoutMin) } : {}), ...(effort !== undefined ? { claudeEffort: effort } : {}), claudeModel: model || (id === 'claude' ? roleModelOf(s, roleOf) : s.claudeModel), codexModel: id === 'codex' ? this.codexModelFor(s, roleOf) : s.codexModel },
        cwd: job.projectDir,
        prompt: currentPrompt,
        resumeId: currentResume,
        mode,
        schema,
        // Kullanıcı bu projeye gerçek anahtar girdiyse kodlayan ajan .env dosyasını okuyamaz (inceleyiciler hiçbir zaman okuyamaz).
        protectEnv: mode === 'code' && (job.env?.names || []).length > 0,
        signal: this.signal,
        // Paralel panel oturumlarında araç adımları akışı boğmasın; yalnızca sonuç ve uyarılar görünsün.
        onLog: (l) => {
          if (!quiet || ['ok', 'warn', 'error'].includes(l.lvl)) this.log(src, l.lvl, l.text);
        },
      });
      job.stats.costUsd += res.costUsd || 0;
      this.update();
      if (mode === 'code') {
        await this.cleanupOrphans('Ajan oturumu sonrası');
        this.syncEnv();
      }
      if (res.aborted) throw new Error('Durduruldu');

      // Kullanım limiti: sıfırlanma saatine kadar bekle, sonra aynı oturumdan devam et.
      if (res.limited && waits < 12) {
        const until = Math.max(res.resetAt, Date.now() + 60000) + 60000;
        const hhmm = new Date(until).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
        this.log('system', 'warn', `${adapter.label} kullanım limitine takıldı (${res.error.split('\n')[0]}). ${hhmm}'de otomatik devam edilecek — uygulamayı açık bırakın.`);
        this.update({ waitUntil: until });
        await this.sleep(until - Date.now());
        this.update({ waitUntil: null });
        if (adapter.supportsResume && res.sessionId && mode === 'code') {
          currentResume = res.sessionId;
          currentPrompt = 'You were interrupted by a usage limit. Continue exactly where you left off and finish the task completely, then give your final summary.';
        }
        continue;
      }
      // Bağlantı kesintisi: bağlantı gelene kadar bekle, sonra aynı oturumdan devam et (salt okunur oturumlar da:
      // yapılan araştırma kaybolmaz). Adım başarısız sayılmaz; yedek yola (ör. yönetici planlayıcı) düşülmez.
      if (res.offline && offline < MAX_OFFLINE_RETRIES) {
        offline += 1;
        await this.awaitNetwork(adapter.label, net.HOSTS[id] || net.HOSTS.claude, res.error, offline);
        if (adapter.supportsResume && res.sessionId) {
          currentResume = res.sessionId;
          currentPrompt = mode === 'code'
            ? 'Your session was interrupted by a network outage. Continue exactly where you left off and finish the task completely, then give your final summary.'
            : 'Your session was interrupted by a network outage. Continue exactly where you left off and finish; your final output must still have the form your instructions require.';
        }
        continue;
      }
      if (!res.ok) {
        if (res.fatal || res.limited || res.offline) throw new Error(res.error);
        this.log(src, 'error', res.error);
      }
      return res;
    }
  }

  // İnceleyici sonucu şemaya uygun teslim etmediyse (zayıf model, araç çağrılmadı) analizi kaybetme:
  // yazdığı metni yönetici şemaya dönüştürür.
  async structuredFrom(res, schema, what) {
    if (res?.structured) return res.structured;
    if (!res?.ok || !res.transcript?.trim()) return null;
    this.log('review', 'dim', `${what}: sonuç yapılandırılmış gelmedi; yönetici inceleyicinin yazdıklarını şemaya dönüştürüyor…`);
    try {
      return await this.gem({
        system: 'Convert the reviewer\'s written analysis below into the given JSON schema faithfully. Do not invent findings; keep every concrete finding, severity, file and fix it states. Keep the language of each field as written.',
        parts: [{ text: res.transcript }],
        schema,
        temperature: 0,
      });
    } catch (e) {
      this.checkAbort();
      this.log('review', 'warn', `Dönüştürme başarısız: ${e.message}`);
      return null;
    }
  }

  /**
   * Salt okunur inceleyiciler çalışma ağacını değiştirmemelidir. Ağaç başlamadan önce temizse (her şey
   * commit'li), inceleyicilerin HEPSİ bittikten sonra bir kez denetlenir ve kalan değişiklik geri alınır.
   * Denetim inceleyicilerin içinde değil burada yapılır: paralel çalışan biri bitince yapılan geri alma,
   * hâlâ test çalıştıran diğerinin dosyalarını silebilirdi.
   */
  async withCleanTree(run) {
    const dir = this.job.projectDir;
    const cleanBefore = this.useGit && (await project.isClean(dir));
    try {
      return await run();
    } finally {
      if (cleanBefore && !this.signal?.aborted && !(await project.isClean(dir))) {
        await project.discardChanges(dir);
        this.log('review', 'warn', 'İnceleyiciler çalışırken dosyalar değişti; değişiklikler geri alındı.');
      }
    }
  }

  // Yönetici ve modeli (günlükte açıkça görünsün): "Claude CLI (abonelik): <model>", "Claude API: <model>" ya da "Yerel model: <model>".
  managerNote(s) {
    const by = settings.managerBy(s);
    if (by === 'anthropic') return `Claude API: ${s.anthropicModel}`;
    if (by === 'local') return `Yerel model: ${s.localModel || '(model seçilmedi)'} @ ${s.localBaseUrl}`;
    if (by === 'nim') return `NVIDIA NIM: ${s.nimModel || '(model seçilmedi)'}`;
    if (by === 'opencode') return `OpenCode: ${opencodecli.managerModelOf(s) || '(OpenCode varsayılanı)'}`;
    return `Claude CLI (abonelik): ${claudeModelLabel(settings.managerClaudeModelOf(s))}`;
  }

  // Kullanılan Claude modeli ve düşünme seviyesi (günlükte açıkça görünsün).
  modelNote(s) {
    if (this.job.agent === 'opencode') {
      const oc = ` · OpenCode: kodlayıcı ${s.opencodeModel || '(varsayılan)'} · inceleyici ${s.opencodeReviewModel || s.opencodeModel || '(varsayılan)'}`;
      return this.reviewerId() === 'claude' ? `${oc} · inceleme: Claude ${claudeModelLabel(roleModelOf(s, 'reviewer'))}` : oc;
    }
    if (this.job.agent === 'codex' && s.codexProvider === 'nim') {
      const r = (role) => this.codexModelFor(s, role) || '(model yok)';
      const nim = ` · Codex/NIM: planlayıcı ${r('planner')} · kodlayıcı ${r('coder')} · inceleyici ${r('reviewer')}`;
      if (this.reviewerId() !== 'claude') return nim;
      return `${nim} · inceleme: Claude ${claudeModelLabel(roleModelOf(s, 'reviewer'))}`;
    }
    if (this.job.agent !== 'claude' && this.reviewerId() !== 'claude') return '';
    const id = claudeModelOf(s);
    const brief = s.taskBriefing ? briefModelOf(s) : null;
    const briefNote = !s.taskBriefing ? '' : brief && agents.resolveBin('claude', s) ? ` · brif: ${claudeModelLabel(brief)}` : ' · brif: yönetici';
    // Genel modelden ayrılan roller ayrıca yazılır (planlayıcı / kodlayıcı / inceleyici).
    const names = { planner: 'planlayıcı', coder: 'kodlayıcı', reviewer: 'inceleyici' };
    const roles = Object.entries(names).filter(([r]) => roleModelOf(s, r) !== id).map(([r, n]) => ` · ${n}: ${claudeModelLabel(roleModelOf(s, r))}`).join('');
    return ` · Claude modeli: ${claudeModelLabel(id)}${claudeModelLabel(id) === id ? '' : ` (${id})`}${roles}${s.claudeEffort ? ` · düşünme: ${s.claudeEffort}` : ''}${briefNote}`;
  }

  // Codex'in bu oturumda kullanacağı model (bkz. models.codexModelFor): NIM'de rol başına NIM modeli, diğerlerinde Codex model alanı.
  codexModelFor(s, role) {
    return codexModelFor(s, role);
  }

  // Kodlayan / inceleyen ajanın bu rolde kullandığı model adı (günlük ve brif etiketi için).
  agentModelFor(s, id, role) {
    if (id === 'codex') return this.codexModelFor(s, role);
    if (id === 'opencode') return (role === 'coder' ? s.opencodeModel : s.opencodeReviewModel || s.opencodeModel) || '';
    return '';
  }

  // İşin kadrosuyla (job.stack: yönetici / kodlayıcı / inceleyici) ezilmiş ayarlar. İş kendi kadrosunu taşır: iş sürerken
  // ya da sürdürülürken Ayarlar değişse de roller değişmez. Kadrosu olmayan eski işlerde Ayarlar olduğu gibi geçerlidir.
  cfg() {
    return settings.withStack(settings.get(), this.job?.stack);
  }

  // Anahtarsız sürümü: anahtar gerektirmeyen sık çağrılar için (bkz. settings.peek).
  cfgPeek() {
    return settings.withStack(settings.peek(), this.job?.stack);
  }

  // Yönetici rolü "manager" iken (varsayılan) yapım döngüsünü (görev incelemesi, hafıza, faz kapısı) ajanlar yürütür.
  agentsLead(s = this.cfg()) {
    return s.managerRole !== 'full' && !!this.reviewerId();
  }

  // Bağımsız inceleyici: Claude kuruluysa her zaman Claude (Codex ile kodlanıyorsa çapraz model);
  // değilse kodlayan ajanın salt-okunur modu.
  // Salt okunur oturumların ajanı: varsayılan Claude (kuruluysa; Codex ile kodlanan işte çapraz model incelemesi). Ayarlar'da
  // "kodlayan ajan" seçildiyse (Claude'suz çalışma) her zaman kodlayan ajan; o da yoksa null (yalnızca yönetici / kontroller).
  reviewerId() {
    // Anahtarlar gerekmez (yalnızca seçim ve CLI yolları): her çağrıda üç anahtarı çözmemek için anahtarsız okuma.
    const s = this.cfgPeek();
    const own = agents.resolveBin(this.job.agent, s) ? this.job.agent : null;
    if (s.reviewerBy === 'agent') return own;
    if (agents.resolveBin('claude', s)) return 'claude';
    return own;
  }

  // İptal edilebilir bekleme.
  sleep(ms) {
    const signal = this.signal;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('Durduruldu'));
      const onAbort = () => {
        clearTimeout(t);
        reject(new Error('Durduruldu'));
      };
      const t = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, Math.max(0, ms));
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  // Kullanıcıya gösterilen metinlerin (inceleme özetleri, rapor) dili: kullanıcının yazdığı dil.
  // Ürünün arayüz dili (plan.language) bundan farklı olabilir (ör. Türkçe istekle İngilizce arayüzlü ürün).
  userLang(head = this.job.plan) {
    const job = this.job;
    const lang = guessLang(`${job.idea || ''} ${job.request || ''} ${(job.userNotes || []).join(' ')}`) || head?.userLanguage || head?.language || null;
    return lang && /^turkish$/i.test(lang.trim()) ? 'Turkish (Türkçe)' : lang;
  }
}

for (const part of [require('./planning'), require('./maintenance'), require('./pipeline'), require('./task'), require('./review'), require('./findings'), require('./audit')]) mixin(Orchestrator, part);

module.exports = { Orchestrator };
