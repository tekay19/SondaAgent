// Sonda orkestratörü: Gemini keşfeder ve planlar → Claude planı eleştirir → ajan kodlar (isteğe
// bağlı TDD) → Sonda doğrular → Gemini inceler → faz kapılarında Claude derin inceleme + Gemini +
// güvenlik → gerekirse ajan düzeltir → son test (tarayıcı + ekran görüntüsü) → rapor.
const fs = require('fs');
const crypto = require('crypto');
const settings = require('./settings');
const gemini = require('./gemini');
const agents = require('./agents');
const project = require('./project');
const verify = require('./verify');
const docs = require('./docs');
const jobs = require('./jobs');
const procs = require('./procs');
const versions = require('./versions');
const secrets = require('./secrets');
const envfile = require('./envfile');
const panelLib = require('./panel');
const P = require('./prompts');

const ACTIVE_TASK = new Set(['running', 'verifying', 'reviewing', 'fixing']);
const SEVERE = new Set(['critical', 'high']);
const PANEL_LABELS = Object.fromEntries(Object.entries(P.SPECIALISTS).map(([k, v]) => [k, v.label]));

class Orchestrator {
  constructor({ emit }) {
    this.emit = emit;
    this.job = null;
    this.ctrl = null;
    this.running = false;
    this.useGit = false;
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

  setTask(task, patch) {
    Object.assign(task, patch);
    this.update();
  }

  log(src, lvl, text) {
    if (!this.job || text == null) return;
    const entry = { t: Date.now(), src, lvl, text: this.redactor()(String(text)) };
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
      this._red = envfile.makeRedactor(dir ? secrets.get(dir) : {});
    }
    return this._red;
  }

  // Kullanıcının girdiği değerleri projenin .env dosyasına yazar (ajan dosyayı ezmiş olsa bile geri koyar)
  // ve ajanların / Gemini'nin göreceği ad listesini günceller. Değerler hiçbir isteme girmez.
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
  commit(dir, message) {
    return project.commitAll(dir, message, {
      secretNeedles: secrets.needles(dir),
      onLeak: (files) => {
        this.log('system', 'warn', `Gizli değer içeren dosya commit dışında bırakıldı: ${files.join(', ')}. Ajan bir anahtarı koda yazmış; sonraki adımda ortam değişkenine taşıması istenecek.`);
        const note = `Files ${files.join(', ')} contain a literal secret value that belongs in .env. Replace it with the environment variable (e.g. process.env.NAME); never hardcode secrets.`;
        this.job.carryOver = [...new Set([...(this.job.carryOver || []), note])].slice(-30);
      },
    });
  }

  guarded(fn) {
    this.running = true;
    this.ctrl = new AbortController();
    this.emit({ type: 'busy', busy: true });
    fn()
      .catch((err) => this.fail(err))
      .finally(() => {
        this.running = false;
        this.ctrl = null;
        if (this.job) jobs.save(this.job, { immediate: true });
        this.emit({ type: 'busy', busy: false });
      });
  }

  fail(err) {
    if (!this.job) return;
    const aborted = this.signal?.aborted;
    for (const t of this.job.tasks) if (ACTIVE_TASK.has(t.status)) t.status = aborted ? 'pending' : 'failed';
    if (aborted) {
      this.log('system', 'warn', 'İş durduruldu.');
      this.update({ phase: 'stopped', currentTaskId: null });
    } else {
      this.log('system', 'error', err?.message || String(err));
      this.update({ phase: 'failed', error: err?.message || String(err), currentTaskId: null });
    }
  }

  // Uygulama kapanırken: süreçleri durdur ve işi eşzamanlı olarak "durduruldu" kaydet.
  interrupt() {
    if (!this.running || !this.job) return;
    this.ctrl?.abort();
    for (const t of this.job.tasks) if (ACTIVE_TASK.has(t.status)) t.status = 'pending';
    this.job.phase = 'stopped';
    this.job.currentTaskId = null;
    this.job.error = 'Uygulama kapatıldığı için iş durdu. "Sürdür" ile kaldığı yerden devam edebilirsiniz.';
    jobs.save(this.job, { immediate: true });
  }

  stop() {
    if (this.running) this.ctrl?.abort();
    else if (['awaiting_approval', 'awaiting_answers'].includes(this.job?.phase)) this.update({ phase: 'cancelled' });
  }

  // Çalışma sırasında (veya onaydan önce) kullanıcının verdiği ek talimat.
  // Sonraki tüm ajan istemlerine ve Gemini incelemelerine eklenir.
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

  async gem({ system, parts, schema, temperature, maxOutputTokens, progressLabel }) {
    const s = settings.get();
    let lastLog = 0;
    // Kullanıcının gizli değerleri (diff, dosya içeriği, test çıktısı içinde olsa bile) Gemini'ye gitmez.
    const red = this.redactor();
    return gemini.generate({
      apiKey: s.geminiKey,
      model: s.geminiModel,
      system: system && red(system),
      parts: (parts || []).map((p) => (typeof p?.text === 'string' ? { ...p, text: red(p.text) } : p)),
      schema,
      temperature,
      maxOutputTokens,
      signal: this.signal,
      onUsage: (u) => {
        this.job.stats.geminiTokens += u.totalTokenCount || 0;
      },
      onProgress: (chars) => {
        if (!progressLabel || Date.now() - lastLog < 8000) return;
        lastLog = Date.now();
        this.log('gemini', 'dim', `${progressLabel}… ${Math.round(chars / 1000)}K karakter`);
      },
    });
  }

  // ---------- planlama ----------
  startPlanning({ idea, projectDir, agent, attachments }) {
    if (this.running) throw new Error('Şu anda çalışan bir iş var. Önce durdurun.');
    if (!projectDir) throw new Error('Proje klasörü seçin.');
    if (!idea?.trim() && !attachments?.length) throw new Error('Bir istek yazın veya doküman ekleyin.');
    if (!settings.get().geminiKey) throw new Error('Gemini API anahtarı yok. Ayarlar\'dan ekleyin.');
    fs.mkdirSync(projectDir, { recursive: true });

    this.job = {
      id: `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
      idea: (idea || '').trim(),
      projectDir,
      agent,
      attachments: (attachments || []).map(({ path, name, size, kind }) => ({ path, name, size, kind })),
      createdAt: Date.now(),
      phase: 'planning',
      plan: null,
      tasks: [],
      stats: { agentRuns: 0, costUsd: 0, geminiTokens: 0 },
      suggestions: [],
      userNotes: [],
      shots: [],
      gates: {},
      phaseStart: {},
      discovery: null,
      planCritique: null,
      report: null,
      error: null,
    };
    settings.save({ lastProjectDir: projectDir, defaultAgent: agent });
    this.update();
    this.guarded(() => this.plan());
    return this.job.id;
  }

  replan(feedback) {
    if (this.running || !this.job) throw new Error('Yeniden planlanacak iş yok.');
    this.update({ phase: 'planning' });
    this.guarded(() => this.plan(feedback));
  }

  // Kullanıcı keşif sorularını cevapladı (ya da varsayılanları seçti): planlamaya devam.
  answerQuestions(answers) {
    const job = this.job;
    if (this.running || !job?.discovery || job.phase !== 'awaiting_answers') throw new Error('Cevap bekleyen soru yok.');
    const qs = job.discovery.questions || [];
    job.discovery.answers = qs.map((q, i) => {
      const a = answers?.[i];
      return { question: q.question, answer: (typeof a === 'string' && a.trim()) || q.default };
    });
    this.log('system', 'info', `Cevaplar alındı: ${job.discovery.answers.map((a) => `${a.question} → ${a.answer}`).join(' | ')}`);
    this.update({ phase: 'planning' });
    this.guarded(() => this.plan());
  }

  async plan(feedback) {
    const job = this.job;
    const s = settings.get();
    this.log('gemini', 'step', feedback ? 'Plan geri bildirime göre güncelleniyor…' : job.discovery ? 'Planlama sürüyor…' : 'Gemini isteği analiz ediyor…');
    this.syncEnv();
    const existing = project.describe(job.projectDir);
    if (existing && !job.discovery) this.log('system', 'info', 'Klasörde mevcut proje bulundu; plan bunun üzerine kurulacak.');
    if (job.attachments.length && !job.discovery) this.log('system', 'info', `${job.attachments.length} doküman Gemini'ye gönderiliyor: ${job.attachments.map((a) => a.name).join(', ')}`);

    const docParts = await docs.toGeminiParts(job.attachments);
    const big = { temperature: 0.3, maxOutputTokens: 65536 };
    const attachmentNames = job.attachments.map((a) => a.name);

    // 0 — Keşif: kıdemli ürün yöneticisi gözüyle tam ürün tanımı + yalnızca kullanıcının verebileceği kararlar.
    if (!job.discovery) {
      this.log('gemini', 'info', 'Keşif · Gemini isteği kıdemli ürün yöneticisi gözüyle tam ürün tanımına genişletiyor (kullanıcılar, yolculuklar, ekranlar, iş kuralları)…');
      const d = await this.gem({ ...big, temperature: 0.5, system: P.PLANNER_BASE + P.STEP_DISCOVERY, parts: [{ text: P.planUserText({ idea: job.idea, existing, attachmentNames, env: job.env }) }, ...docParts], schema: P.DISCOVERY_SCHEMA, progressLabel: 'Ürün tanımı yazılıyor' });
      const questions = (d?.questions || []).filter((q) => q?.question).slice(0, 6).map((q) => ({
        question: q.question,
        why: q.why || '',
        options: (q.options || []).filter(Boolean).slice(0, 5),
        default: q.default || q.options?.[0] || '',
      }));
      job.discovery = { productBrief: String(d?.productBrief || '').trim(), questions, answers: null };
      this.log('gemini', 'ok', `Ürün tanımı hazır (${Math.round(job.discovery.productBrief.length / 1000)}K karakter)${questions.length ? ` · ${questions.length} soru` : ''}.`);
      if (questions.length && !s.autoApprove) {
        this.log('gemini', 'info', 'Planı netleştirmek için cevaplarınız bekleniyor (her sorunun önerilen bir varsayılanı var).');
        this.update({ phase: 'awaiting_answers' });
        return;
      }
      job.discovery.answers = questions.map((q) => ({ question: q.question, answer: q.default }));
    }

    const previousPlan = feedback && job.plan ? { ...job.plan, tasks: job.tasks.map(({ phase, title, goal, details, acceptance, tests, covers }) => ({ phase, title, goal, details, acceptance, tests, covers })) } : null;
    const base = P.planUserText({ idea: job.idea, existing, feedback, previousPlan, attachmentNames, discovery: job.discovery, env: job.env });

    // 1/4 — Gereksinimler
    this.checkAbort();
    this.log('gemini', 'info', '1/4 · Gereksinimler çıkarılıyor (her kural ayrı madde)…');
    const head = await this.gem({ ...big, system: P.PLANNER_BASE + P.STEP_REQUIREMENTS, parts: [{ text: base }, ...docParts], schema: P.REQUIREMENTS_SCHEMA, progressLabel: 'Gereksinimler yazılıyor' });
    head.stack = head.stack || [];
    head.features = head.features || [];
    head.assumptions = head.assumptions || [];
    head.questions = (head.questions || []).filter(Boolean).slice(0, 3);
    head.requirements = (head.requirements || []).filter((r) => r?.id && r?.text);
    if (!head.requirements.length) throw new Error('Gemini gereksinim listesi üretemedi. Tekrar deneyin.');
    this.log('gemini', 'ok', `${head.requirements.length} gereksinim çıkarıldı.`);

    // Güncel sürümler: Gemini'nin eski API bilgisiyle (Tailwind 3, Zod 3…) şartname yazmasını önler.
    job.versions = await versions.currentVersions([job.idea, job.discovery?.productBrief, head.stack.join(', ')].join('\n'), { signal: this.signal }).catch(() => ({}));
    if (Object.keys(job.versions).length) this.log('system', 'info', `Güncel sürümler npm'den alındı: ${Object.entries(job.versions).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    const baseV = base + P.versionsBlock(job.versions);

    // Plan: varsayılan olarak Claude mühendis yazar, Gemini yönetici onaylar; olmazsa Gemini planlar.
    const cleanMd = (t) => String(t).trim().replace(/^```(?:markdown|md)?\s*/i, '').replace(/```\s*$/, '');
    const uncoveredOf = (tasks) => {
      const covered = new Set(tasks.flatMap((t) => t.covers || []));
      return head.requirements.map((r) => r.id).filter((id) => !covered.has(id));
    };
    const thinOf = (tasks) => tasks.filter((t) => (t.acceptance || []).length < 4 || (t.tests || []).length < 2).map((t) => `- ${t.title} (acceptance ${(t.acceptance || []).length}, tests ${(t.tests || []).length})`);
    let spec = null;
    let tp = null;
    job.planReview = null;
    job.planCritique = null;
    if (s.planner !== 'gemini' && this.reviewerId()) {
      this.checkAbort();
      const r = await this.claudePlan({ baseV, head, s, uncoveredOf, thinOf, cleanMd });
      if (r) ({ spec, tp } = r);
      else this.log('system', 'warn', 'Claude plan oturumu kullanılabilir bir plan vermedi; Gemini planlayıcıya geçiliyor.');
    }
    if (!tp) ({ spec, tp } = await this.geminiPlan({ baseV, head, docParts, s, big, cleanMd, uncoveredOf, thinOf }));
    const stillThin = thinOf(tp.tasks);
    if (stillThin.length) this.log('gemini', 'warn', `Uyarı: ${stillThin.length} görevde 4'ten az kabul kriteri ya da 2'den az test var.`);
    const avgCovers = tp.tasks.reduce((n, t) => n + (t.covers || []).length, 0) / tp.tasks.length;
    if (avgCovers > 8) this.log('gemini', 'warn', `Görev başına ortalama ${avgCovers.toFixed(1)} gereksinim düşüyor; görevler büyük. İstekte görev sayısını sınırladıysanız sınırı artırmak kaliteyi yükseltir.`);
    const stillUncovered = uncoveredOf(tp.tasks);
    if (stillUncovered.length) this.log('gemini', 'warn', `Uyarı: ${stillUncovered.length} gereksinim hiçbir göreve bağlanmadı (${stillUncovered.slice(0, 12).join(', ')}${stillUncovered.length > 12 ? '…' : ''}). Son incelemede kontrol edilecek.`);

    const plan = { ...head, spec, verify: { setup: [], commands: [], routes: [], devCommand: '', devUrl: '', ...(tp.verify || {}) } };
    const tasks = tp.tasks.filter((t) => t?.title && t?.details).slice(0, 60);
    const phaseCount = new Set(tasks.map((t) => t.phase).filter(Boolean)).size;
    this.log('gemini', 'ok', `Plan hazır: ${plan.projectName} · ${phaseCount > 1 ? `${phaseCount} faz · ` : ''}${tasks.length} görev · ${plan.requirements.length} gereksinim · şartname ${Math.round(spec.length / 1000)}K`);
    if (plan.questions.length) this.log('gemini', 'info', `Gemini'nin ${plan.questions.length} ek sorusu var (cevaplamak isteğe bağlı; varsayılanlar planda).`);
    this.update({
      plan,
      gates: {},
      tasks: tasks.map((t, i) => ({
        id: `t${i + 1}`,
        phase: t.phase || '',
        title: t.title,
        goal: t.goal || '',
        details: t.details,
        acceptance: t.acceptance || [],
        tests: t.tests || [],
        covers: t.covers || [],
        status: 'pending',
        attempts: 0,
      })),
      phase: 'awaiting_approval',
    });

    if (s.autoApprove) {
      this.log('system', 'info', 'Otomatik onay açık — başlatılıyor.');
      await this.pipeline();
    }
  }

  // Gemini planlar (yedek yol ya da "planner: gemini" ayarı): 6 uzman bölümlü şartname → görevler →
  // bağımsız Claude eleştirisi → Gemini son hali → şartname kararlarla yeniden yazılır.
  async geminiPlan({ baseV, head, docParts, s, big, cleanMd, uncoveredOf, thinOf }) {
    const job = this.job;
    // 2/4 — Derin teknik şartname: 6 uzman bölüm (önce mimari ve veri modeli, sonra diğerleri paralel).
    this.checkAbort();
    this.log('gemini', 'info', `2/4 · Derin teknik şartname: ${P.SPEC_SECTIONS.length} uzman bölüm (mimari, veri modeli, API, ekranlar, akışlar, güvenlik/operasyon)…`);
    const written = {};
    const writeSection = async (sec) => {
      const done = P.SPEC_SECTIONS.filter((x) => written[x.key]).map((x) => written[x.key]);
      const text = await this.gem({ ...big, system: P.specSectionSystem(sec), parts: [{ text: P.specSectionUserText(baseV, head, done) }, ...docParts] });
      written[sec.key] = cleanMd(text);
      this.log('gemini', 'ok', `Şartname bölümü hazır: ${sec.title} (${Math.round(written[sec.key].length / 1000)}K)`);
    };
    const [first, second, ...rest] = P.SPEC_SECTIONS;
    await writeSection(first);
    this.checkAbort();
    await writeSection(second);
    this.checkAbort();
    await Promise.all(rest.map(writeSection));
    let spec = P.SPEC_SECTIONS.map((x) => written[x.key]).join('\n\n');
    this.log('gemini', 'ok', `Şartname hazır (${Math.round(spec.length / 1000)}K karakter).`);

    // 3/4 — Fazlar ve görevler (Given/When/Then kabul kriterleri + somut testler)
    this.checkAbort();
    this.log('gemini', 'info', '3/4 · Fazlar ve görevler planlanıyor (kabul kriterleri ve test senaryolarıyla)…');
    let tp = await this.gem({ ...big, temperature: 0.4, system: P.PLANNER_BASE + P.STEP_TASKS, parts: [{ text: P.tasksUserText(baseV, head, spec) }, ...docParts], schema: P.TASKS_SCHEMA, progressLabel: 'Görevler yazılıyor' });
    if (!tp?.tasks?.length) throw new Error('Gemini geçerli bir görev listesi üretemedi. Tekrar deneyin.');

    // Bağımsız eleştiri: Claude klasörü ve güncel kütüphane sürümlerini salt-okunur inceleyip planı eleştirir.
    let critique = null;
    if (s.reviewLevel !== 'standard' && this.reviewerId()) {
      this.checkAbort();
      const label = agents.ADAPTERS[this.reviewerId()].label;
      this.log('review', 'step', `${label} planı bağımsız olarak eleştiriyor (salt-okunur: mevcut kod, güncel sürümler, görev sırası, test edilebilirlik)…`);
      try {
        const res = await this.runAgent(P.planCritiquePrompt({ lang: head.language, base: baseV, head, spec, draft: tp }), {
          mode: 'review',
          schema: P.PLAN_CRITIQUE_SCHEMA,
          agentId: this.reviewerId(),
          label: 'plan eleştirisi',
          src: 'review',
          timeoutMin: 30,
        });
        critique = await this.structuredFrom(res, P.PLAN_CRITIQUE_SCHEMA, 'Plan eleştirisi');
        if (critique) {
          const n = (sev) => (critique.findings || []).filter((f) => f.severity === sev).length;
          this.log('review', critique.verdict === 'solid' ? 'ok' : 'warn', `Plan eleştirisi: ${critique.verdict === 'solid' ? 'sağlam' : 'değişiklik gerekli'} — ${n('high')} yüksek, ${n('medium')} orta, ${n('low')} düşük bulgu. ${critique.summary}`);
          for (const f of (critique.findings || []).filter((x) => x.severity !== 'low').slice(0, 10)) this.log('review', f.severity === 'high' ? 'warn' : 'dim', `[${f.severity}/${f.area}] ${f.problem}`);
          job.planCritique = critique;
        } else {
          this.log('review', 'warn', `Plan eleştirisi alınamadı${res.error ? `: ${String(res.error).slice(0, 200)}` : ''}; Gemini denetimiyle devam ediliyor.`);
        }
      } catch (e) {
        this.checkAbort();
        this.log('review', 'warn', `Plan eleştirisi yapılamadı: ${e.message}. Gemini denetimiyle devam ediliyor.`);
      }
    }

    // 4/4 — Gemini son hali: kapsanmayan gereksinimler, test tabanının altındaki görevler ve Claude'un eleştirisi.
    const uncovered = uncoveredOf(tp.tasks);
    const thin = thinOf(tp.tasks);
    if (s.planSelfReview || uncovered.length || critique || thin.length) {
      this.checkAbort();
      this.log('gemini', 'info', `4/4 · Gemini planı son haline getiriyor${critique ? ' (eleştirideki bulgular işleniyor)' : ''}${uncovered.length ? ` · ${uncovered.length} kapsanmayan gereksinim` : ''}${thin.length ? ` · ${thin.length} görevde test/kabul kriteri eksik` : ''}…`);
      try {
        const reviewed = await this.gem({ ...big, system: P.PLANNER_BASE + P.STEP_TASKS_REVIEW, parts: [{ text: P.tasksReviewUserText(baseV, head, spec, tp, uncovered, critique, thin) }], schema: P.TASKS_SCHEMA, progressLabel: 'Plan yeniden yazılıyor' });
        if (reviewed?.tasks?.length) tp = reviewed;
      } catch (e) {
        this.checkAbort();
        this.log('gemini', 'warn', `Plan denetimi yapılamadı, taslak kullanılıyor: ${e.message}`);
      }
    }

    // Kararlar şartnamenin sonuna "ek" olarak değil, ilgili bölümlerin içine işlenir: çelişki kalmaz.
    const decisions = tp.specAddendum?.trim() || '';
    if (decisions || (critique?.findings || []).some((f) => f.severity !== 'low')) {
      this.checkAbort();
      this.log('gemini', 'info', 'Şartname, plan incelemesindeki kararlarla bölüm bölüm yeniden yazılıyor (çelişki kalmaması için)…');
      let fellBack = false;
      const rewritten = await Promise.all(
        P.SPEC_SECTIONS.map(async (sec) => {
          try {
            const t = cleanMd(await this.gem({ ...big, system: P.specRewriteSystem(sec), parts: [{ text: P.specRewriteUserText({ base: baseV, head, sectionText: written[sec.key], critique, decisions }) }] }));
            if (t.length >= 0.6 * written[sec.key].length) return t;
          } catch (e) {
            this.checkAbort();
          }
          fellBack = true;
          return written[sec.key];
        })
      );
      spec = rewritten.join('\n\n');
      if (fellBack && decisions) spec += `\n\n## Addendum — plan review decisions\n${cleanMd(decisions)}`;
      this.log('gemini', 'ok', `Şartname kararlarla güncellendi (${Math.round(spec.length / 1000)}K karakter)${fellBack ? '; bazı bölümler için kararlar ek olarak eklendi' : ''}.`);
    }
    return { spec, tp };
  }

  // Claude mühendis planlar (salt-okunur, araçlarla), Gemini yönetici değerlendirir; gerekirse Claude
  // aynı oturumda revize eder. Kullanılabilir plan çıkmazsa null döner (Gemini yoluna geçilir).
  async claudePlan({ baseV, head, s, uncoveredOf, thinOf, cleanMd }) {
    const job = this.job;
    const rid = this.reviewerId();
    const label = agents.ADAPTERS[rid].label;
    const valid = (pl) => pl && typeof pl.spec === 'string' && pl.spec.trim().length > 500 && Array.isArray(pl.tasks) && pl.tasks.some((t) => t?.title && t?.details);
    this.log('review', 'step', `2/4 · ${label} mühendis olarak teknik şartnameyi ve görev planını yazıyor (klasörü inceliyor, güncel sürümleri ve komutları doğruluyor)…`);
    let res;
    try {
      res = await this.runAgent(P.claudePlanPrompt({ base: baseV, head }), { mode: 'review', schema: P.CLAUDE_PLAN_SCHEMA, agentId: rid, label: 'plan yazımı', src: 'review', timeoutMin: 40 });
    } catch (e) {
      this.checkAbort();
      this.log('review', 'warn', `Plan oturumu başarısız: ${e.message}`);
      return null;
    }
    let plan = await this.structuredFrom(res, P.CLAUDE_PLAN_SCHEMA, 'Plan');
    if (!valid(plan)) return null;
    let sessionId = res.sessionId;
    this.log('review', 'ok', `Plan yazıldı: ${plan.tasks.length} görev · şartname ${Math.round(plan.spec.length / 1000)}K${plan.decisions ? ` · kararlar: ${String(plan.decisions).split('\n')[0].slice(0, 160)}` : ''}`);

    const rounds = [];
    const maxRounds = 2;
    for (let round = 0; ; round++) {
      this.checkAbort();
      const uncovered = uncoveredOf(plan.tasks);
      const thin = thinOf(plan.tasks);
      this.log('gemini', 'info', `3/4 · Gemini yönetici olarak planı isteğe, ürün tanımına ve gereksinimlere göre değerlendiriyor${uncovered.length ? ` · ${uncovered.length} kapsanmayan gereksinim` : ''}${thin.length ? ` · ${thin.length} görevde test/kabul kriteri eksik` : ''}…`);
      let review;
      try {
        review = await this.gem({ system: P.managerReviewSystem(head.language), parts: [{ text: P.managerReviewUserText({ base: baseV, head, plan, uncovered, thin }) }], schema: P.MANAGER_REVIEW_SCHEMA, temperature: 0.2, maxOutputTokens: 32768 });
      } catch (e) {
        this.checkAbort();
        this.log('gemini', 'warn', `Yönetici değerlendirmesi yapılamadı (${e.message}); plan olduğu gibi kullanılıyor.`);
        break;
      }
      const blocking = (review.findings || []).filter((f) => f.severity !== 'low');
      const needsRevision = review.verdict === 'revise' || uncovered.length || thin.length;
      rounds.push({ verdict: needsRevision ? 'revise' : 'approve', summary: review.summary, findings: review.findings || [] });
      this.log('gemini', needsRevision ? 'warn' : 'ok', `Yönetici: ${needsRevision ? 'DEĞİŞİKLİK İSTİYOR' : 'ONAYLADI'} — ${review.summary}`);
      for (const f of blocking.slice(0, 10)) this.log('gemini', f.severity === 'high' ? 'warn' : 'dim', `[${f.severity}${f.area ? `/${f.area}` : ''}] ${f.problem}`);
      if (!needsRevision || round >= maxRounds) break;

      this.log('review', 'step', `${label} yöneticinin istediği değişiklikleri uyguluyor (tur ${round + 1}/${maxRounds})…`);
      try {
        const rev = await this.runAgent(P.planRevisionPrompt(review, uncovered, thin), { mode: 'review', schema: P.CLAUDE_PLAN_SCHEMA, agentId: rid, resumeId: sessionId, label: `plan revizyonu ${round + 1}`, src: 'review', timeoutMin: 30 });
        const revised = await this.structuredFrom(rev, P.CLAUDE_PLAN_SCHEMA, 'Plan revizyonu');
        if (valid(revised)) {
          plan = revised;
          sessionId = rev.sessionId || sessionId;
          this.log('review', 'ok', `Plan revize edildi: ${plan.tasks.length} görev · şartname ${Math.round(plan.spec.length / 1000)}K`);
        } else {
          this.log('review', 'warn', 'Revizyon kullanılabilir bir plan döndürmedi; önceki plan korunuyor.');
          break;
        }
      } catch (e) {
        this.checkAbort();
        this.log('review', 'warn', `Revizyon yapılamadı: ${e.message}`);
        break;
      }
    }
    job.planReview = { planner: label, rounds };
    if (plan.stack?.length) head.stack = plan.stack;
    return {
      spec: cleanMd(plan.spec),
      tp: { tasks: plan.tasks, verify: plan.verify || {} },
    };
  }

  approve({ skipTaskIds = [] } = {}) {
    if (this.running || !this.job?.plan) throw new Error('Onaylanacak plan yok.');
    for (const t of this.job.tasks) if (skipTaskIds.includes(t.id) && t.status === 'pending') t.status = 'skipped';
    this.guarded(() => this.pipeline());
  }

  // Son kabul geçmediyse: görevleri yeniden çalıştırmadan son kabul + düzeltme turlarını tekrarla.
  continueFinal() {
    if (this.running || !this.job?.plan || this.job.phase !== 'incomplete') throw new Error('Devam ettirilecek son kabul yok.');
    this.update({ error: null });
    this.guarded(async () => {
      const s = settings.get();
      this.useGit = s.gitCommit ? await project.ensureRepo(this.job.projectDir) : false;
      this.log('system', 'step', 'Son kabul yeniden başlatıldı: açık sorunlar düzeltilecek.');
      await this.finalStage(s);
    });
  }

  // Durdurulmuş / hata almış bir işi kaldığı yerden sürdürür.
  resume() {
    if (this.running || !this.job) throw new Error('Sürdürülecek iş yok.');
    // Planlama yarıda kaldı: ürün tanımı ve kullanıcının cevapları korunur, planlama oradan sürer.
    if (!this.job.plan) {
      const d = this.job.discovery;
      if (d?.questions?.length && !d.answers) return this.update({ phase: 'awaiting_answers', error: null });
      this.log('system', 'step', d ? 'Planlama kaldığı yerden sürüyor (ürün tanımı ve cevaplarınız korundu).' : 'Planlama yeniden başlatılıyor.');
      this.update({ phase: 'planning', error: null });
      return this.guarded(() => this.plan());
    }
    for (const t of this.job.tasks) if (t.status !== 'done' && t.status !== 'skipped') t.status = 'pending';
    this.update({ error: null });
    this.guarded(() => this.pipeline());
  }

  // ---------- yürütme ----------
  async pipeline() {
    const job = this.job;
    const s = settings.get();
    const dir = job.projectDir;
    this.update({ phase: 'running', startedAt: job.startedAt || Date.now(), error: null });
    this.log('system', 'step', `Yürütme başladı · ajan: ${agents.ADAPTERS[job.agent].label}`);

    this.useGit = s.gitCommit ? await project.ensureRepo(dir) : false;
    if (s.gitCommit && !this.useGit) this.log('system', 'warn', 'git bulunamadı; commit ve kod farkı incelemesi yapılamayacak.');
    this.syncEnv();

    // Aynı klasördeki önceki Sonda işlerinin hafızasıyla başla.
    if (!job.memory) job.memory = docs.readMemory(dir).replace(/^<!--.*?-->\s*/, '');
    job.carryOver = job.carryOver || [];
    if (job.memory) this.log('system', 'info', 'Bu klasörde önceki işlerden kalan proje hafızası yüklendi.');

    const written = docs.writeToProject(dir, job.attachments, this.specMarkdown());
    docs.writeRequest(dir, job);
    job.specPath = written.specPath;
    job.docRefs = written.refs;
    this.log('system', 'info', `Teknik şartname yazıldı: ${written.specPath}`);
    if (this.useGit) {
      await this.commit(dir, 'sonda: teknik şartname ve referans dokümanlar');
      if (!job.baseCommit) job.baseCommit = await project.headCommit(dir);
    }

    job.gates = job.gates || {};
    job.phaseStart = job.phaseStart || {};
    const tasks = job.tasks;
    const multiPhase = new Set(tasks.map((t) => t.phase).filter(Boolean)).size > 1;
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      if (task.status !== 'done' && task.status !== 'skipped') {
        this.checkAbort();
        if (multiPhase && task.phase && !job.phaseStart[task.phase] && this.useGit) job.phaseStart[task.phase] = await project.headCommit(dir);
        await this.runTask(task, s);
      }
      // Faz bittiğinde kalite kapısı. Son faz, son doğrulamayla birlikte değerlendirilir.
      const next = tasks[i + 1];
      if (multiPhase && task.phase && next && next.phase !== task.phase && job.gates[task.phase]?.status !== 'passed') {
        await this.runPhaseGate(task.phase, s);
      }
    }
    this.checkAbort();
    await this.finalStage(s);
  }

  async runBrowserTest(s, tag, checks) {
    if (!s.visualTest) return null;
    const v = this.job.plan.verify || {};
    // Servisler ortam yüzünden (ör. Docker kapalı) kalkmadıysa uygulama zaten çalışamaz; bu bir kod hatası değildir.
    const envDown = (checks || []).find((c) => c.env);
    if (envDown) {
      this.log('test', 'warn', `Tarayıcı testi atlandı: ${envDown.output}`);
      return { skipped: envDown.output };
    }
    this.update({ phase: 'testing' });
    await this.cleanupOrphans('Tarayıcı testi öncesi');
    this.log('test', 'step', 'Tarayıcı testi: sunucu başlatılıyor, sayfalar geziliyor…');
    this.syncEnv();
    const auth = envfile.basicAuthCreds(secrets.get(this.job.projectDir));
    if (auth) this.log('test', 'dim', 'Basic Auth korumalı sayfalar .env\'deki kullanıcı adı ve parolayla açılacak.');
    let smoke;
    try {
      smoke = await verify.runSmoke({ dir: this.job.projectDir, routes: v.routes, command: v.devCommand || null, url: v.devUrl || null, auth, log: (l) => this.log('test', l.lvl, l.text), signal: this.signal });
    } catch (e) {
      smoke = { ok: false, error: e.message, output: '' };
    }
    this.checkAbort();
    if (smoke.skipped) this.log('test', 'dim', `Tarayıcı testi atlandı: ${smoke.skipped}`);
    else if (smoke.error) {
      this.log('test', 'error', `Tarayıcı testi başarısız: ${smoke.error}`);
      const tail = (smoke.output || '').trim().split('\n').slice(-15).join('\n');
      if (tail) this.log('test', 'dim', `Sunucu çıktısının sonu:\n${tail}`);
    }
    this.storeShots(smoke, tag);
    return smoke;
  }

  fullChecks() {
    this.syncEnv();
    const v = this.job.plan.verify || {};
    return verify.runChecks({ dir: this.job.projectDir, full: true, extraCommands: v.commands, setupCommands: v.setup, log: (l) => this.log('test', l.lvl, l.text), signal: this.signal });
  }

  // Güvenlik denetimi: ayrı bir uzman gözüyle diff; kritik/yüksek bulgular düzeltme turu başlatır.
  async securityAudit(diff, scopeLabel, depAudit = null) {
    if (!settings.get().securityReview || !diff?.diff) return [];
    this.log('gemini', 'info', `Güvenlik denetimi (${scopeLabel}): OWASP, yetki/IDOR, oturum, dosya yükleme, gizli anahtarlar…`);
    try {
      const r = await this.gem({
        system: P.SECURITY_SYSTEM,
        parts: [{ text: `# Specification\n${this.job.plan.spec}${depAudit ? `\n\n# Dependency audit (production dependencies)\n${depAudit.summary}\n${depAudit.highCritical.map((x) => `- ${x}`).join('\n') || '(no high/critical)'}` : ''}\n\n# Diff stat\n${diff.stat}\n\n# Diff\n${diff.diff}` }],
        schema: P.SECURITY_SCHEMA,
        temperature: 0.1,
      });
      const findings = (r?.findings || []).filter((f) => f?.title);
      const count = (sev) => findings.filter((f) => f.severity === sev).length;
      this.log('gemini', findings.some((f) => ['critical', 'high'].includes(f.severity)) ? 'warn' : 'ok',
        `Güvenlik denetimi: ${findings.length ? `${count('critical')} kritik, ${count('high')} yüksek, ${count('medium')} orta, ${count('low')} düşük bulgu` : 'bulgu yok'}`);
      for (const f of findings.slice(0, 8)) this.log('gemini', ['critical', 'high'].includes(f.severity) ? 'warn' : 'dim', `[${f.severity}] ${f.title}${f.file ? ` (${f.file})` : ''}`);
      return findings;
    } catch (e) {
      this.checkAbort();
      this.log('gemini', 'warn', `Güvenlik denetimi yapılamadı: ${e.message}`);
      return [];
    }
  }

  // Güvenlik bulgularını incelemeye katar: kritik/yüksek → engelleyici, diğerleri → öneri.
  mergeSecurity(review, findings) {
    const blocking = findings.filter((f) => ['critical', 'high'].includes(f.severity));
    for (const f of blocking) review.issues.push(`Güvenlik [${f.severity}]: ${f.title}${f.file ? ` (${f.file})` : ''}`);
    for (const f of findings.filter((x) => !blocking.includes(x))) review.suggestions.push(`Güvenlik [${f.severity}]: ${f.title}`);
    if (blocking.length) {
      review.verdict = 'fix';
      review.fixInstructions = `${review.fixInstructions ? `${review.fixInstructions}\n\n` : ''}Security findings that must be fixed:\n${blocking.map((f) => `- [${f.severity}] ${f.title}${f.file ? ` in ${f.file}` : ''} — fix: ${f.fix}`).join('\n')}`;
    }
    review.security = findings;
    return review;
  }

  // Faz kalite kapısı: tüm kontroller + entegrasyon/e2e + tarayıcı testi + regresyon incelemesi.
  async runPhaseGate(phaseName, s) {
    const job = this.job;
    const dir = job.projectDir;
    const lang = job.plan.language;
    const gateNo = Object.keys(job.gates).length + 1;
    const gate = (job.gates[phaseName] = { status: 'running', attempts: 0 });
    this.update({ phase: 'verifying', currentTaskId: null });
    this.log('system', 'step', `Faz kapısı: "${phaseName}" — tam doğrulama, entegrasyon testleri ve regresyon incelemesi`);

    let review;
    let prevDeep = null;
    let prevPanel = null;
    for (let attempt = 0; ; attempt++) {
      this.checkAbort();
      const checks = await this.fullChecks();
      const smoke = await this.runBrowserTest(s, `g${gateNo}-${attempt}`, checks);
      this.update({ phase: 'reviewing' });
      this.log('gemini', 'info', `Gemini "${phaseName}" fazını bütün olarak inceliyor…`);
      const diff = this.useGit ? await project.diffSince(dir, job.phaseStart[phaseName] || null, 200000) : null;
      const snapshot = this.useGit ? await project.sourceSnapshot(dir, { priority: await project.changedFiles(dir, job.phaseStart[phaseName] || null), budget: 450000 }) : null;
      const phaseTasks = job.tasks.filter((t) => t.phase === phaseName && t.status !== 'skipped');
      const deepOn = s.reviewLevel !== 'standard';
      const installed = project.installedVersions(dir);
      // Düzeltme turlarında Claude fazı baştan incelemez: yalnızca bildirdiği sorunları doğrular;
      // önceki turda zaten onayladıysa hiç çalışmaz.
      const prevBlocking = this.deepBlocking(prevDeep);
      // Uzman paneli ilk turda çalışır; doğrulanan bulguları düzeltme sonrası hedefli yeniden doğrulamaya girer.
      const panelOn = deepOn && s.reviewPanel !== false;
      const focus = attempt > 0 ? [...prevBlocking, ...(attempt === 1 ? panelLib.panelFocus(prevPanel) : [])] : null;
      const deepTask = !deepOn
        ? Promise.resolve(null)
        : attempt > 0 && prevDeep && !focus.length
          ? Promise.resolve(prevDeep)
          : this.deepReview({ scope: `phase "${phaseName}"`, tasks: phaseTasks, reqIds: [...new Set(phaseTasks.flatMap((t) => t.covers || []))], checks, smoke, focus });
      const [raw, findings, deep, pnl] = await Promise.all([
        this.gem({ system: P.phaseReviewSystem(lang, phaseName), parts: P.finalReviewParts({ job, checks, smoke, diff, phase: phaseName, snapshot, installed }), schema: P.REVIEW_SCHEMA, temperature: 0.2 }),
        // Panel açıkken güvenlik denetimini Claude'un güvenlik uzmanı yapar.
        panelOn ? Promise.resolve([]) : this.securityAudit(diff, `faz "${phaseName}"`),
        deepTask,
        panelOn && attempt === 0 ? this.reviewPanel({ scope: `phase "${phaseName}" (and the code it builds on)` }) : Promise.resolve(null),
      ]);
      if (deep) prevDeep = deep;
      if (pnl) prevPanel = pnl;
      review = panelLib.mergePanel(this.mergeDeep(this.mergeSecurity(this.normalizeReview(raw, checks, smoke?.error ? { forceIssue: `Uygulama çalıştırılamadı: ${smoke.error}` } : {}), findings), deep), attempt === 0 ? pnl : null, { labels: PANEL_LABELS });
      // Düzeltme turlarında panel yeniden çalışmaz; özeti arayüzde kalsın (engelleyiciliği yeniden doğrulama belirler).
      if (!review.panel && gate.review?.panel) review.panel = { ...gate.review.panel, blocking: 0, carry: [] };
      // Uzlaşma kuralı (yalnız faz kapısı): tüm kontroller geçti, Claude projeyi çalıştırıp onayladı ve güvenlik
      // temizse, Gemini'nin tek başına itirazları düzeltme turu açmaz; sonraki görevlere ve son kabule aktarılır.
      const checksOk = !checks.some((c) => !c.ok && !c.env) && !smoke?.error;
      const secOk = !(review.security || []).some((f) => ['critical', 'high'].includes(f.severity));
      if (review.verdict === 'fix' && deep && !this.deepBlocking(deep).length && deep.verdict !== 'fix' && checksOk && secOk && !review.panel?.blocking) {
        job.carryOver = [...(job.carryOver || []), ...review.issues.map((i) => `Faz "${phaseName}" incelemesinden (doğrula, geçerliyse düzelt): ${i}`)].slice(-30);
        this.log('system', 'info', `Kontroller geçti ve Claude onayladı: Gemini'nin ${review.issues.length} notu düzeltme turu açılmadan sonraki görevlere ve son kabule aktarıldı.`);
        review.deferred = review.issues;
        review.issues = [];
        review.verdict = 'pass';
      }
      gate.review = review;
      this.trackRequirements(review);
      if (deep) this.trackRequirements({ requirementChecks: deep.requirementChecks || [] }, { authoritative: true });
      this.logReview(review, `Faz kapısı (${phaseName})`);
      if (review.verdict === 'pass') {
        gate.status = 'passed';
        this.carryPanel(review, `faz "${phaseName}"`);
        break;
      }
      if (attempt >= s.maxFixAttempts) {
        gate.status = 'failed';
        break;
      }
      gate.attempts = attempt + 1;
      this.update({ phase: 'fixing' });
      const fixRes = await this.runAgent(P.finalFixPrompt(job, review, checks, smoke, s.standards, project.fileTree(dir, { maxEntries: 300, maxDepth: 5 }), phaseName), { label: `faz düzeltme ${attempt + 1}/${s.maxFixAttempts}` });
      await this.remember({ title: `Phase gate fixes: ${phaseName}`, details: review.fixInstructions, status: 'done', agentSummary: fixRes.text, review, attempts: 0 }, `Faz "${phaseName}" düzeltme turu ${attempt + 1}`);
      if (this.useGit) await this.commit(dir, `sonda: ${phaseName} faz düzeltmeleri (${attempt + 1})`);
    }

    docs.appendProgress(dir, `## ${gate.status === 'passed' ? '✓' : '✕'} Faz kapısı — ${phaseName}
- ${new Date().toLocaleString('tr-TR')} · kalite ${review.qualityScore ?? '-'}/10 · ${review.summary}
${(review.issues || []).map((i) => `- Açık: ${i}`).join('\n')}`);
    if (this.useGit) await this.commit(dir, `sonda: faz kapısı — ${phaseName}`);
    this.update({ phase: 'running' });

    if (gate.status === 'failed' && s.strictPhaseGates) {
      throw new Error(`"${phaseName}" fazının kalite kapısı ${s.maxFixAttempts} düzeltme turundan sonra geçilemedi; sonraki faz sağlam olmayan bir temel üzerine kurulmasın diye durduruldu. Açık sorunlar yukarıda. Talimat ekleyip "Sürdür" diyebilir ya da Ayarlar'dan katı faz kapısını kapatabilirsiniz.`);
    }
  }

  specMarkdown() {
    const p = this.job.plan;
    return `# ${p.projectName}

${p.summary}

**Stack:** ${p.stack.join(', ')}
**UI language:** ${p.language || '-'}

## Requirements
${p.requirements.map((r) => `- **${r.id}**: ${r.text}`).join('\n')}

## Assumptions
${p.assumptions.map((a) => `- ${a}`).join('\n') || '-'}

${p.spec}
`;
  }

  // Kodlayan ya da inceleyen ajanı çalıştırır. mode: 'code' (yazma yetkili) | 'review' (salt okunur).
  async runAgent(prompt, { resumeId, label, mode = 'code', schema, agentId, src = 'agent', timeoutMin, effort, quiet = false } = {}) {
    const job = this.job;
    const id = agentId || job.agent;
    const adapter = agents.ADAPTERS[id];
    let currentPrompt = prompt;
    let currentResume = resumeId;
    for (let waits = 0; ; waits++) {
      const s = settings.get();
      job.stats.agentRuns += 1;
      if (mode === 'code') this.syncEnv();
      this.log('system', 'info', `${adapter.label} ${mode === 'review' ? 'inceliyor (salt okunur)' : 'çalışıyor'}${label ? ` · ${label}` : ''}…`);
      const res = await agents.runAgent({
        agentId: id,
        settings: { ...s, ...(timeoutMin ? { agentTimeoutMin: Math.min(s.agentTimeoutMin, timeoutMin) } : {}), ...(effort !== undefined ? { claudeEffort: effort } : {}) },
        cwd: job.projectDir,
        prompt: currentPrompt,
        resumeId: currentResume,
        mode,
        schema,
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
      if (!res.ok) {
        if (res.fatal || res.limited) throw new Error(res.error);
        this.log(src, 'error', res.error);
      }
      return res;
    }
  }

  // İnceleyici sonucu şemaya uygun teslim etmediyse (zayıf model, araç çağrılmadı) analizi kaybetme:
  // yazdığı metni Gemini şemaya dönüştürür.
  async structuredFrom(res, schema, what) {
    if (res?.structured) return res.structured;
    if (!res?.ok || !res.transcript?.trim()) return null;
    this.log('review', 'dim', `${what}: sonuç yapılandırılmış gelmedi; Gemini inceleyicinin yazdıklarını şemaya dönüştürüyor…`);
    try {
      return await this.gem({
        system: 'Convert the reviewer\'s written analysis below into the given JSON schema faithfully. Do not invent findings; keep every concrete finding, severity, file and fix it states. Keep the language of each field as written.',
        parts: [{ text: res.transcript }],
        schema: gemini.toGeminiSchema(schema),
        temperature: 0,
      });
    } catch (e) {
      this.checkAbort();
      this.log('review', 'warn', `Dönüştürme başarısız: ${e.message}`);
      return null;
    }
  }

  // Bağımsız inceleyici: Claude kuruluysa her zaman Claude (Codex ile kodlanıyorsa çapraz model);
  // değilse kodlayan ajanın salt-okunur modu.
  reviewerId() {
    const s = settings.get();
    if (agents.resolveBin('claude', s)) return 'claude';
    return agents.resolveBin(this.job.agent, s) ? this.job.agent : null;
  }

  // Claude derin inceleme: projede gezer, testleri kendisi çalıştırır, kabul kriterlerini koddan izler.
  // İnceleyici dosya değiştiremez; yine de temiz ağaçta başlarsa sonrasında değişiklik kalmadığı garanti edilir.
  async deepReview({ scope, tasks, reqIds, checks, smoke, focus }) {
    const job = this.job;
    const rid = this.reviewerId();
    if (!rid) return null;
    const dir = job.projectDir;
    const cleanBefore = this.useGit && (await project.isClean(dir));
    this.log('review', 'step', focus?.length
      ? `${agents.ADAPTERS[rid].label} yeniden doğrulama: ${scope} — yalnızca bildirdiği ${focus.length} sorunun giderildiğine ve kontrollerin geçtiğine bakıyor…`
      : `${agents.ADAPTERS[rid].label} derin inceleme: ${scope} (projede geziyor, testleri kendisi çalıştırıyor)…`);
    let deep = null;
    try {
      const res = await this.runAgent(P.deepReviewPrompt({ job, scope, tasks, reqIds, checks, smoke, lang: job.plan.language, focus }), {
        mode: 'review',
        schema: P.DEEP_REVIEW_SCHEMA,
        agentId: rid,
        label: `${focus?.length ? 'yeniden doğrulama' : 'derin inceleme'} · ${scope}`,
        src: 'review',
        timeoutMin: focus?.length ? 12 : 25,
        effort: settings.get().reviewEffort || undefined,
      });
      deep = await this.structuredFrom(res, P.DEEP_REVIEW_SCHEMA, 'Derin inceleme');
      if (!deep) this.log('review', 'warn', `Derin inceleme sonucu alınamadı${res.error ? `: ${String(res.error).slice(0, 200)}` : ''}.`);
    } catch (e) {
      this.checkAbort();
      this.log('review', 'warn', `Derin inceleme yapılamadı: ${e.message}`);
    }
    if (cleanBefore && !(await project.isClean(dir))) {
      await project.discardChanges(dir);
      this.log('review', 'warn', 'İnceleyici çalışırken dosyalar değişti; değişiklikler geri alındı.');
    }
    if (deep) {
      const blocking = (deep.issues || []).filter((i) => i.blocking || ['critical', 'high'].includes(i.severity));
      this.log('review', deep.verdict === 'pass' && !blocking.length ? 'ok' : 'warn', `Derin inceleme: ${deep.verdict === 'pass' && !blocking.length ? 'ONAYLANDI' : 'DÜZELTME GEREKLİ'} — ${deep.summary}`);
      for (const i of (deep.issues || []).slice(0, 10)) this.log('review', i.blocking ? 'warn' : 'dim', `[${i.severity}${i.blocking ? ', engelleyici' : ''}] ${i.title}${i.file ? ` (${i.file})` : ''}`);
      for (const t of (deep.testsRun || []).slice(0, 8)) this.log('review', t.result === 'pass' ? 'dim' : 'warn', `test: ${t.command} → ${t.result}${t.note ? ` · ${t.note}` : ''}`);
    }
    return deep;
  }

  // Uzman denetim paneli (yalnızca Claude): güvenlik, iş kuralları / veri bütünlüğü ve mimari / test
  // uzmanları paralel ve salt okunur inceler; ayrı bir Claude doğrulayıcı her bulguyu kodda kontrol eder.
  // Yalnızca doğrulanan bulgular düzeltmeye gider; yanlış alarmlar ajanın zamanını yemez.
  async reviewPanel({ scope, depAudit = null }) {
    const job = this.job;
    const rid = this.reviewerId();
    if (!rid) return null;
    const dir = job.projectDir;
    const lang = job.plan.language;
    const effort = settings.get().reviewEffort || undefined;
    const keys = Object.keys(P.SPECIALISTS);
    const cleanBefore = this.useGit && (await project.isClean(dir));
    this.log('review', 'step', `Uzman denetim paneli (${agents.ADAPTERS[rid].label}): ${keys.map((k) => P.SPECIALISTS[k].label).join(' · ')} — ${scope}`);
    const outs = await Promise.all(
      keys.map(async (key) => {
        const label = P.SPECIALISTS[key].label;
        try {
          const res = await this.runAgent(P.specialistPrompt({ job, key, scope, lang, depAudit }), { mode: 'review', schema: P.SPECIALIST_SCHEMA, agentId: rid, label: `uzman · ${label}`, src: 'review', timeoutMin: 20, effort, quiet: true });
          const out = res.structured || agents.jsonFromText(res.transcript || res.text);
          if (!Array.isArray(out?.findings)) this.log('review', 'warn', `${label}: sonuç alınamadı.`);
          else this.log('review', 'info', `${label}: ${out.findings.length} bulgu — ${out.summary || ''}`);
          return { key, out };
        } catch (e) {
          this.checkAbort();
          this.log('review', 'warn', `${label} incelemesi yapılamadı: ${e.message}`);
          return { key, out: null };
        }
      })
    );
    const findings = outs.flatMap(({ key, out }) => (Array.isArray(out?.findings) ? out.findings : []).map((f) => ({ ...f, area: key, ...panelLib.parseFileRef(f.file, f.line) })));
    const toVerify = findings.filter((f) => f.severity !== 'low');
    const verified = toVerify.length ? await this.verifyPanelFindings(toVerify, rid) : [];
    if (cleanBefore && !(await project.isClean(dir))) {
      await project.discardChanges(dir);
      this.log('review', 'warn', 'Panel çalışırken dosyalar değişti; değişiklikler geri alındı.');
    }
    const confirmed = verified.filter((f) => f.verdict === 'confirmed');
    const uncertain = verified.filter((f) => f.verdict === 'uncertain');
    const rejected = verified.filter((f) => f.verdict === 'rejected');
    const severe = confirmed.filter((f) => SEVERE.has(f.severity)).length;
    this.log('review', severe ? 'warn' : 'ok', `Uzman paneli: ${confirmed.length} doğrulanmış bulgu${severe ? ` (${severe} kritik/yüksek)` : ''}, ${rejected.length} yanlış alarm elendi${uncertain.length ? `, ${uncertain.length} belirsiz` : ''}.`);
    for (const f of confirmed.slice(0, 12)) this.log('review', SEVERE.has(f.severity) ? 'warn' : 'dim', `✓ [${f.severity}] ${PANEL_LABELS[f.area]}: ${f.title} (${f.file || '?'}${f.line ? `:${f.line}` : ''})`);
    return {
      confirmed,
      uncertain,
      rejected,
      low: findings.filter((f) => f.severity === 'low'),
      summaries: outs.map(({ key, out }) => ({ area: key, summary: out?.summary || '', strengths: out?.strengths || [] })),
    };
  }

  async verifyPanelFindings(findings, rid) {
    const dir = this.job.projectDir;
    const items = findings.map((f, i) => ({ i, f, code: panelLib.codeExcerpt(dir, f.file, f.line, { radius: 25, maxChars: 4000 }) }));
    this.log('review', 'info', `Doğrulayıcı (${agents.ADAPTERS[rid].label}) ${findings.length} bulguyu kodda tek tek kontrol ediyor…`);
    try {
      const res = await this.runAgent(P.panelVerifyPrompt({ items, lang: this.job.plan.language }), { mode: 'review', schema: P.PANEL_VERIFY_SCHEMA, agentId: rid, label: 'bulgu doğrulama', src: 'review', timeoutMin: 15, effort: settings.get().reviewEffort || undefined, quiet: true });
      const out = res.structured || agents.jsonFromText(res.transcript || res.text);
      const byIndex = new Map((out?.results || []).map((x) => [Number(x.index), x]));
      if (!byIndex.size) throw new Error('doğrulama sonucu alınamadı');
      return findings.map((f, i) => ({ ...f, verdict: byIndex.get(i)?.verdict || 'uncertain', verifyNote: byIndex.get(i)?.reason || '' }));
    } catch (e) {
      this.checkAbort();
      this.log('review', 'warn', `Bulgular doğrulanamadı (${e.message}); yalnızca kritik/yüksek olanlar dikkate alınıyor.`);
      return findings.map((f) => ({ ...f, verdict: SEVERE.has(f.severity) ? 'confirmed' : 'uncertain', verifyNote: 'doğrulanamadı' }));
    }
  }

  // Panelin doğrulanmış ama bu turda düzeltilmeyen bulguları sonraki görevlere zorunlu not olarak devreder.
  carryPanel(review, where) {
    const carry = review.panel?.carry || [];
    if (!carry.length) return;
    this.job.carryOver = [...(this.job.carryOver || []), ...carry.map((f) => `Uzman paneli (${where}, doğrulandı — düzeltilmeli): [${f.severity}] ${f.title} (${f.file || '?'}${f.line ? `:${f.line}` : ''}) — ${f.fix}`)].slice(-30);
    this.log('system', 'info', `Uzman panelinin ${carry.length} doğrulanmış orta seviye bulgusu sonraki görevlere düzeltilmek üzere aktarıldı.`);
  }

  deepBlocking(deep) {
    return (deep?.issues || []).filter((i) => i.blocking || ['critical', 'high'].includes(i.severity));
  }

  // Claude'un engelleyici bulgularını Gemini incelemesine katar; gereksinim kararlarında Claude'u esas alır.
  mergeDeep(review, deep) {
    if (!deep) return review;
    const blocking = (deep.issues || []).filter((i) => i.blocking || ['critical', 'high'].includes(i.severity));
    for (const i of blocking) review.issues.push(`Claude [${i.severity}]: ${i.title}${i.file ? ` (${i.file})` : ''}`);
    for (const i of (deep.issues || []).filter((x) => !blocking.includes(x))) review.suggestions.push(`Claude [${i.severity}]: ${i.title}`);
    if (blocking.length || deep.verdict === 'fix') {
      review.verdict = 'fix';
      review.fixInstructions = `${review.fixInstructions ? `${review.fixInstructions}\n\n` : ''}Independent deep review (another senior engineer explored the repository and ran the checks):\n${blocking.map((i) => `- [${i.severity}] ${i.title}${i.file ? ` in ${i.file}` : ''}: ${i.detail} — fix: ${i.fix}`).join('\n') || '- see the review summary'}`;
    }
    review.deep = { verdict: blocking.length ? 'fix' : deep.verdict, summary: deep.summary, issues: deep.issues || [], testsRun: deep.testsRun || [] };
    return review;
  }

  // İptal edilebilir bekleme.
  sleep(ms) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(resolve, Math.max(0, ms));
      this.signal?.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new Error('Durduruldu'));
      }, { once: true });
    });
  }

  // Gereksinim izlenebilirliği: incelemelerin kanıtıyla doğruladığı gereksinimleri işaretle.
  // authoritative (projede gezip test çalıştıran derin inceleme) önceki kararların üzerine yazar.
  trackRequirements(review, { authoritative = false } = {}) {
    const job = this.job;
    const valid = new Set((job.plan.requirements || []).map((r) => r.id));
    job.reqStatus = job.reqStatus || {};
    job.reqEvidence = job.reqEvidence || {};
    const checks = review.requirementChecks || [];
    for (const c of checks) {
      if (!valid.has(c.id) || !['met', 'partial', 'missing'].includes(c.status)) continue;
      const cur = job.reqStatus[c.id];
      if (authoritative || c.status === 'met' || cur !== 'met') {
        job.reqStatus[c.id] = c.status === 'missing' ? (authoritative || !cur ? 'missing' : cur) : c.status;
        if (c.evidence) job.reqEvidence[c.id] = c.evidence;
      }
    }
    // Eski biçim (id listeleri)
    for (const id of review.requirementsPartial || []) if (valid.has(id) && job.reqStatus[id] !== 'met') job.reqStatus[id] = 'partial';
    for (const id of review.requirementsMet || []) if (valid.has(id)) job.reqStatus[id] = 'met';
    const met = Object.values(job.reqStatus).filter((v) => v === 'met').length;
    if (checks.length || (review.requirementsMet || []).length) this.log(authoritative ? 'review' : 'gemini', 'dim', `Gereksinim kapsamı: ${met}/${valid.size} karşılandı`);
  }

  normalizeReview(review, checks, extra = {}) {
    const r = {
      verdict: review?.verdict === 'pass' ? 'pass' : 'fix',
      summary: review?.summary || '',
      issues: review?.issues || [],
      suggestions: review?.suggestions || [],
      qualityScore: review?.qualityScore || null,
      fixInstructions: review?.fixInstructions || '',
      acceptanceChecks: (review?.acceptanceChecks || []).filter((c) => c?.criterion),
      requirementChecks: (review?.requirementChecks || []).filter((c) => c?.id),
      testQuality: review?.testQuality || '',
    };
    // Kanıtla "karşılanmadı" denen kabul kriteri varken onay verilemez.
    const missing = r.acceptanceChecks.filter((c) => c.status === 'missing');
    if (missing.length && r.verdict === 'pass') {
      r.verdict = 'fix';
      r.issues.push(...missing.map((c) => `Kabul kriteri karşılanmadı: ${c.criterion}`));
    }
    const failed = (checks || []).filter((c) => !c.ok && !c.env);
    if (failed.length && r.verdict === 'pass') {
      r.verdict = 'fix';
      r.issues.push(...failed.map((c) => `Doğrulama başarısız: ${c.cmd}`));
    }
    if (extra.forceIssue) {
      r.verdict = 'fix';
      r.issues.push(extra.forceIssue);
    }
    if (r.verdict === 'fix' && !r.fixInstructions.trim()) {
      r.fixInstructions = 'Fix every problem listed above and make all failing verification commands pass.';
    }
    return r;
  }

  logReview(review, label) {
    const score = review.qualityScore ? ` · kalite ${review.qualityScore}/10` : '';
    this.log('gemini', review.verdict === 'pass' ? 'ok' : 'warn', `${label}: ${review.verdict === 'pass' ? 'ONAYLANDI' : 'DÜZELTME GEREKLİ'}${score} — ${review.summary}`);
    for (const i of review.issues) this.log('gemini', 'warn', `• ${i}`);
    for (const sug of review.suggestions.slice(0, 5)) this.log('gemini', 'dim', `öneri: ${sug}`);
  }

  async runTask(task, s) {
    const job = this.job;
    const dir = job.projectDir;
    const n = job.tasks.indexOf(task) + 1;
    const lang = job.plan.language;
    job.currentTaskId = task.id;
    this.setTask(task, { status: 'running', startedAt: Date.now(), attempts: 0 });
    this.log('system', 'step', `Görev ${n}/${job.tasks.length}: ${task.title}`);

    const tree = project.fileTree(dir, { maxEntries: 300, maxDepth: 5 });
    if (s.taskBriefing) {
      this.log('gemini', 'info', 'Gemini mevcut kodu okuyup bu görev için teknik brif hazırlıyor…');
      try {
        const brief = await this.gem({
          system: P.BRIEF_SYSTEM,
          parts: [{ text: P.briefUserText({ job, task, fileTree: tree, keyFiles: project.keyFiles(dir) }) }],
          temperature: 0.3,
          maxOutputTokens: 32768,
          progressLabel: 'Brif yazılıyor',
        });
        task.brief = String(brief).trim();
        this.log('gemini', 'ok', `Teknik brif hazır (${Math.round(task.brief.length / 1000)}K karakter).`);
      } catch (e) {
        this.checkAbort();
        this.log('gemini', 'warn', `Brif hazırlanamadı, görev planıyla devam ediliyor: ${e.message}`);
      }
      this.update();
    }
    // TDD: önce bağımsız bir QA oturumu testleri yazar; uygulayıcı bu testleri geçirecek kodu yazar.
    const app = project.nodeApp(dir);
    if (s.tddMode && n > 1 && app?.scripts?.test && (task.tests?.length || task.acceptance?.length) && this.useGit) {
      this.log('system', 'step', `TDD · QA mühendisi önce "${task.title}" testlerini yazıyor…`);
      const before = await project.headCommit(dir);
      const isTest = (f) => /(^|\/)(__tests__|tests?|e2e|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$/.test(f);
      const tres = await this.runAgent(P.testAuthorPrompt(job, task, s.standards), { label: 'TDD testleri', src: 'agent' });
      let written = (await project.changedFiles(dir, before)).filter(isTest);
      // Testler kod yazılmadan önce incelenir: yanlış beklenti ya da test ortamında çalışamayacak test,
      // uygulayıcıyı yanlış ürüne zorlar.
      if (tres.ok && written.length) {
        this.log('gemini', 'info', 'Gemini TDD testlerini şartname ve kabul kriterleriyle karşılaştırıyor (kod yazılmadan önce)…');
        try {
          const tr = await this.gem({
            system: P.TEST_REVIEW_SYSTEM,
            parts: [{ text: P.testReviewUserText({ job, task, files: project.fileContents(dir, written, 150000) }) }],
            schema: P.TEST_REVIEW_SCHEMA,
            temperature: 0.1,
          });
          if (tr?.verdict === 'fix' && tr.problems?.length) {
            this.log('gemini', 'warn', `TDD test incelemesi: ${tr.problems.length} sorun — testler kod yazılmadan önce düzeltiliyor.`);
            for (const pr of tr.problems.slice(0, 6)) this.log('gemini', 'dim', `• ${pr.file ? `${pr.file}: ` : ''}${pr.problem}`);
            const canResume = agents.ADAPTERS[job.agent].supportsResume && tres.sessionId;
            await this.runAgent(canResume ? P.testFixPrompt(task, tr) : `${P.testAuthorPrompt(job, task, s.standards)}\n\n${P.testFixPrompt(task, tr)}`, { resumeId: canResume ? tres.sessionId : null, label: 'TDD test düzeltmesi', src: 'agent' });
            written = (await project.changedFiles(dir, before)).filter(isTest);
          } else {
            this.log('gemini', 'ok', 'TDD test incelemesi: testler şartnameyle uyumlu.');
          }
        } catch (e) {
          this.checkAbort();
          this.log('gemini', 'warn', `TDD test incelemesi yapılamadı: ${e.message}`);
        }
      }
      if (tres.ok && written.length) {
        await this.commit(dir, `sonda: TDD testleri — ${task.title}`);
        task.tddFiles = written;
        task.tddCommit = await project.headCommit(dir);
        this.log('test', 'ok', `TDD: ${written.length} test dosyası yazıldı (${written.slice(0, 6).join(', ')}${written.length > 6 ? '…' : ''}). Uygulayıcı bunları geçirecek.`);
      } else {
        this.log('test', 'warn', 'TDD testleri yazılamadı; görev normal akışla sürüyor.');
      }
      this.update();
    }

    let res = await this.runAgent(P.taskPrompt(job, task, s.standards, tree), { label: `görev ${n}` });
    task.agentSummary = res.text || task.agentSummary;
    task.sessionId = res.sessionId || task.sessionId;

    if (!s.verifyEachTask) {
      this.setTask(task, { status: res.ok ? 'done' : 'failed' });
    } else {
      for (let attempt = 0; ; attempt++) {
        this.checkAbort();
        this.setTask(task, { status: 'verifying' });
        this.log('test', 'step', `Doğrulama: ${task.title}`);
        const checks = await verify.runChecks({ dir, log: (l) => this.log('test', l.lvl, l.text), signal: this.signal });
        this.checkAbort();

        this.setTask(task, { status: 'reviewing' });
        this.log('gemini', 'info', 'Gemini kodu madde madde inceliyor (diff + değişen dosyaların tam içeriği, kabul kriterleri, testler)…');
        const diff = this.useGit ? await project.diffSince(dir, null, 80000) : null;
        const files = this.useGit ? project.fileContents(dir, await project.changedFiles(dir, null), 200000) : null;
        let tddNote = null;
        if (task.tddCommit) {
          const changed = await project.diffPaths(dir, task.tddCommit, task.tddFiles);
          tddNote = changed
            ? `The QA engineer wrote these tests first: ${task.tddFiles.join(', ')}. The implementer MODIFIED them — check every change is a justified correction and does not weaken the tests (blocking if it does):\n${changed}`
            : `The QA engineer wrote these tests first: ${task.tddFiles.join(', ')}. The implementer did not modify them.`;
        }
        const [raw, deep] = await Promise.all([
          this.gem({
            system: P.reviewSystem(lang),
            parts: [{ text: P.reviewUserText({ job, task, agentSummary: task.agentSummary, checks, diff, files, tddNote, installed: project.installedVersions(dir) }) }],
            schema: P.REVIEW_SCHEMA,
            temperature: 0.2,
          }),
          // Maksimum inceleme gücünde her görevde Claude da bağımsız derin inceleme yapar.
          s.reviewLevel === 'max' ? this.deepReview({ scope: `task "${task.title}"`, tasks: [task], reqIds: task.covers, checks, smoke: null }) : Promise.resolve(null),
        ]);
        const review = this.mergeDeep(this.normalizeReview(raw, checks, res.ok ? {} : { forceIssue: `Ajan görevi tamamlayamadı: ${String(res.error).slice(0, 300)}` }), deep);
        task.review = review;
        this.trackRequirements(review);
        if (deep) this.trackRequirements({ requirementChecks: deep.requirementChecks || [] }, { authoritative: true });
        job.suggestions.push(...review.suggestions);
        this.logReview(review, `İnceleme (${task.title})`);

        if (review.verdict === 'pass') {
          this.setTask(task, { status: 'done' });
          break;
        }
        if (attempt >= s.maxFixAttempts) {
          this.log('system', 'warn', `"${task.title}" ${s.maxFixAttempts} düzeltme denemesinden sonra hâlâ sorunlu; sonraki göreve geçiliyor.`);
          this.setTask(task, { status: 'failed' });
          break;
        }
        this.setTask(task, { status: 'fixing', attempts: attempt + 1 });
        const resumed = !!(agents.ADAPTERS[job.agent].supportsResume && task.sessionId);
        res = await this.runAgent(P.fixPrompt(job, task, review, checks, { resumed, standards: s.standards, fileTree: resumed ? null : project.fileTree(dir, { maxEntries: 300, maxDepth: 5 }) }), {
          resumeId: resumed ? task.sessionId : null,
          label: `düzeltme ${attempt + 1}/${s.maxFixAttempts}`,
        });
        task.agentSummary = res.text || task.agentSummary;
        task.sessionId = res.sessionId || task.sessionId;
      }
    }

    this.setTask(task, { finishedAt: Date.now() });
    await this.remember(task, `Görev ${n}/${job.tasks.length} — ${task.title}`);
    if (this.useGit) {
      const hash = await this.commit(dir, `sonda: ${task.title}${task.status === 'failed' ? ' (sorunlu)' : ''}`);
      if (hash) {
        task.commit = hash;
        this.log('system', 'dim', `commit ${hash}`);
      }
    }
    this.update();
  }

  // Proje hafızası: Gemini gerçek kod farkına bakarak MEMORY.md'yi günceller,
  // sonraki görevler için devreden notlar çıkarır; PROGRESS.md'ye kayıt düşülür.
  async remember(task, heading) {
    const job = this.job;
    const dir = job.projectDir;
    const s = settings.get();
    const diff = this.useGit ? await project.diffSince(dir, null, 150000) : null;
    this.checkAbort();
    this.log('gemini', 'info', 'Gemini proje hafızasını güncelliyor…');
    try {
      const r = await this.gem({ system: P.MEMORY_SYSTEM, parts: [{ text: P.memoryUserText({ job, task, diff }) }], schema: P.MEMORY_SCHEMA, temperature: 0.2 });
      if (r?.memory?.trim()) {
        job.memory = r.memory.trim();
        job.carryOver = (r.carryOver || []).filter(Boolean).slice(0, 30);
        docs.writeMemory(dir, job.memory);
        this.log('gemini', 'ok', `Hafıza güncellendi (${Math.round(job.memory.length / 1000)}K karakter${job.carryOver.length ? `, ${job.carryOver.length} devreden not` : ''}).`);
        for (const c of job.carryOver.slice(0, 5)) this.log('gemini', 'dim', `devreden: ${c}`);
      }
    } catch (e) {
      this.checkAbort();
      this.log('gemini', 'warn', `Hafıza güncellenemedi (${e.message}); ilerleme günlüğü yine de yazılıyor.`);
    }

    const icon = task.status === 'done' ? '✓' : task.status === 'failed' ? '✕' : '•';
    const rv = task.review;
    docs.appendProgress(dir, `## ${icon} ${heading}
- ${new Date().toLocaleString('tr-TR')} · ${agents.ADAPTERS[job.agent].label} · durum: ${task.status}${rv?.qualityScore ? ` · kalite ${rv.qualityScore}/10` : ''}${task.attempts ? ` · ${task.attempts} düzeltme turu` : ''}
${rv ? `- İnceleme: ${rv.summary}\n${(rv.issues || []).map((i) => `  - ${i}`).join('\n')}` : ''}
${job.userNotes?.length ? `- Kullanıcı talimatları: ${job.userNotes.join(' | ')}` : ''}

### Ajan özeti
${(task.agentSummary || '(yok)').trim()}

${diff?.stat ? `### Değişen dosyalar\n\`\`\`\n${diff.stat}\n\`\`\`` : ''}`);
    docs.writeAgentGuides(dir, s.standards || P.DEFAULT_STANDARDS);
    this.update();
  }

  async finalStage(s) {
    const job = this.job;
    const dir = job.projectDir;
    const lang = job.plan.language;
    this.update({ phase: 'verifying', currentTaskId: null });
    this.log('system', 'step', 'Son doğrulama ve uçtan uca test');

    let checks = [];
    let smoke = null;
    let review = null;
    let prevDeep = null;
    let prevPanel = null;
    for (let attempt = 0; ; attempt++) {
      this.checkAbort();
      checks = await this.fullChecks();
      smoke = await this.runBrowserTest(s, `f-${attempt}`, checks);

      this.update({ phase: 'reviewing' });
      this.log('gemini', 'info', 'Gemini tüm projeyi, test sonuçlarını ve ekran görüntülerini inceliyor…');
      const diff = this.useGit ? await project.diffSince(dir, job.baseCommit, 250000) : null;
      const snapshot = this.useGit ? await project.sourceSnapshot(dir, { budget: 500000 }) : null;
      const notMet = (job.plan.requirements || []).map((r) => r.id).filter((id) => (job.reqStatus || {})[id] !== 'met');
      const depAudit = s.securityReview ? await verify.dependencyAudit(dir, this.signal).catch(() => null) : null;
      if (depAudit) this.log('test', depAudit.highCritical.length ? 'warn' : 'ok', `Bağımlılık güvenlik taraması: ${depAudit.summary}${depAudit.highCritical.length ? ` — ${depAudit.highCritical.slice(0, 5).join(', ')}` : ''}`);
      const deepOn = s.reviewLevel !== 'standard';
      const installed = project.installedVersions(dir);
      const prevBlocking = this.deepBlocking(prevDeep);
      const panelOn = deepOn && s.reviewPanel !== false;
      const focus = attempt > 0 ? [...prevBlocking, ...(attempt === 1 ? panelLib.panelFocus(prevPanel, { final: true }) : [])] : null;
      const deepTask = !deepOn
        ? Promise.resolve(null)
        : attempt > 0 && prevDeep && !focus.length
          ? Promise.resolve(prevDeep)
          : this.deepReview({ scope: 'the whole project (final acceptance)', tasks: job.tasks.filter((t) => t.status !== 'skipped'), reqIds: notMet, checks, smoke, focus });
      const [raw, findings, deep, pnl] = await Promise.all([
        this.gem({ system: P.finalReviewSystem(lang), parts: P.finalReviewParts({ job, checks, smoke, diff, snapshot, installed }), schema: P.REVIEW_SCHEMA, temperature: 0.2 }),
        panelOn
          ? Promise.resolve([])
          : attempt === 0 || (review?.security || []).length || depAudit?.highCritical?.length ? this.securityAudit(diff, 'tüm proje', depAudit) : Promise.resolve([]),
        deepTask,
        panelOn && attempt === 0 ? this.reviewPanel({ scope: 'the whole project (final acceptance)', depAudit }) : Promise.resolve(null),
      ]);
      if (deep) prevDeep = deep;
      if (pnl) prevPanel = pnl;
      const brokenServer = smoke && smoke.error ? `Uygulama çalıştırılamadı: ${smoke.error}` : null;
      // Son kabulde doğrulanmış orta seviye bulgular da teslimi engeller.
      review = panelLib.mergePanel(this.mergeDeep(this.mergeSecurity(this.normalizeReview(raw, checks, brokenServer ? { forceIssue: brokenServer } : {}), findings), deep), attempt === 0 ? pnl : null, { final: true, labels: PANEL_LABELS });
      if (!pnl && prevPanel && review.panel == null) review.panel = { ...(job.finalReview?.panel || {}), blocking: 0 };
      this.trackRequirements(review);
      if (deep) this.trackRequirements({ requirementChecks: deep.requirementChecks || [] }, { authoritative: true });
      this.update({ finalReview: review });
      this.logReview(review, 'Son inceleme');

      // Son kabul, kullanıcıya çalışır uygulama teslim etmenin son şansı: daha fazla düzeltme hakkı.
      const maxFinal = Math.max(s.maxFixAttempts, s.finalFixAttempts ?? 3);
      if (review.verdict === 'pass' || attempt >= maxFinal) break;
      this.update({ phase: 'fixing' });
      const fixRes = await this.runAgent(P.finalFixPrompt(job, review, checks, smoke, s.standards, project.fileTree(dir, { maxEntries: 300, maxDepth: 5 })), { label: `son düzeltme ${attempt + 1}/${maxFinal}` });
      const pseudo = { title: 'Final hardening', details: review.fixInstructions, status: 'done', agentSummary: fixRes.text, review, attempts: 0 };
      await this.remember(pseudo, `Son düzeltme turu ${attempt + 1}`);
      if (this.useGit) await this.commit(dir, `sonda: son düzeltmeler (${attempt + 1})`);
    }

    this.update({ phase: 'reporting' });
    this.log('gemini', 'info', 'Teslim raporu yazılıyor…');
    const report = await this.gem({ system: P.reportSystem(lang), parts: [{ text: P.reportUserText({ job, checks, smoke, finalReview: review }) }], temperature: 0.3 });
    docs.appendProgress(dir, `## ${review.verdict === 'pass' ? '✓' : '⚠'} Teslim — son inceleme
- ${new Date().toLocaleString('tr-TR')} · kalite ${review.qualityScore ?? '-'}/10 · ${review.summary}
${(review.issues || []).map((i) => `- Açık: ${i}`).join('\n')}
- Doğrulama: ${checks.map((c) => `${c.name} ${c.ok ? '✓' : '✕'}`).join(', ') || '-'}`);
    if (this.useGit) await this.commit(dir, 'sonda: teslim');
    // "Tamamlandı" yalnızca son kabul (çalışırlık + güvenlik + gereksinimler) geçtiyse. Aksi halde dürüstçe
    // "teslime hazır değil" denir ve kullanıcı ek düzeltme turları başlatabilir.
    const passed = review.verdict === 'pass';
    this.update({ report, phase: passed ? 'done' : 'incomplete', finishedAt: Date.now() });
    if (passed) this.log('system', 'ok', 'Teslime hazır — testler, güvenlik denetimi, tarayıcı testi ve son kabul geçti.');
    else this.log('system', 'warn', `Teslime hazır değil — ${review.issues.length} açık sorun var (raporda). "Düzeltmeye devam et" ile ek düzeltme turları başlatabilirsiniz.`);
  }

  storeShots(smoke, tag) {
    if (!smoke?.pages?.length) return;
    const shots = [];
    smoke.pages.forEach((p, i) => {
      if (!p.jpeg) return;
      const file = jobs.saveShot(this.job.id, `${tag}-${i}.jpg`, p.jpeg);
      shots.push({ route: p.route, viewport: p.viewport, status: p.status, errors: p.errors, title: p.title, file });
    });
    this.update({ shots });
    this.emit({
      type: 'shots',
      jobId: this.job.id,
      shots: shots.map((sh, i) => ({ ...sh, dataUrl: `data:image/jpeg;base64,${smoke.pages.filter((p) => p.jpeg)[i].jpeg.toString('base64')}` })),
    });
  }
}

module.exports = { Orchestrator };
