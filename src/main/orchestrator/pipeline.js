// Yapım hattı: görevler, faz kapıları, son kabul, hafıza ve teslim raporu.
// (Orchestrator sınıfının yöntemleri; bkz. index.js — `this` orkestratördür.)
const fs = require('fs');
const path = require('path');
const settings = require('../settings');
const agents = require('../agents');
const project = require('../project');
const verify = require('../verify');
const docs = require('../docs');
const jobs = require('../jobs');
const secrets = require('../secrets');
const envfile = require('../envfile');
const panelLib = require('../panel');
const P = require('../prompts');
const { SEVERE } = require('./shared');

// Görev kodlanıp incelendi ama hafıza / commit adımı bitmedi (bkz. task.finishTask).
const finishing = (t) => (t.status === 'done' || t.status === 'failed') && t.step === 'finishing';

// Hafıza oturumuna giden fark üst sınırı: ajan değişen dosyaları kendisi okur; tüm farkı isteme koymak her görevde
// on binlerce token ekliyordu. (Yöneticinin yazdığı hafıza dosya okuyamadığı için tüm farkı almaya devam eder.)
const MEMORY_DIFF_CHARS = 30000;
const clipDiff = (text, max) => {
  const t = String(text || '');
  return t.length > max ? `${t.slice(0, max)}\n… (diff truncated — read the changed files listed in the diff stat for the rest)` : t;
};

class Pipeline {
  // Son kabul geçmediyse: görevleri yeniden çalıştırmadan son kabul + düzeltme turlarını tekrarla.
  continueFinal() {
    if (this.running || !this.job?.plan || this.job.phase !== 'incomplete') throw new Error('Devam ettirilecek son kabul yok.');
    this.update({ error: null, errorKind: null });
    this.guarded(async () => {
      const s = this.cfg();
      this.useGit = s.gitCommit ? await project.ensureRepo(this.job.projectDir) : false;
      this.log('system', 'step', 'Son kabul yeniden başlatıldı: açık sorunlar düzeltilecek.');
      await this.finalStage(s);
    });
  }

  // Durdurulmuş / hata almış bir işi kaldığı yerden sürdürür.
  resume() {
    if (this.running || !this.job || !['stopped', 'failed'].includes(this.job.phase)) throw new Error('Sürdürülecek iş yok.');
    this.job.errorKind = null;
    // Planlama yarıda kaldı: ürün tanımı ve kullanıcının cevapları korunur, planlama oradan sürer.
    if (!this.job.plan) {
      const d = this.job.discovery;
      if (d?.questions?.length && !d.answers) return this.update({ phase: 'awaiting_answers', error: null });
      this.log('system', 'step', d ? 'Planlama kaldığı yerden sürüyor (ürün tanımı ve cevaplarınız korundu).' : 'Planlama yeniden başlatılıyor.');
      this.update({ phase: 'planning', error: null });
      return this.guarded(() => (this.job.kind ? this.planMaintenance() : this.plan()));
    }
    // Plan onaylanmadan yürütülmez: onay beklerken yeniden planlama başarısız olduysa ya da durdurulduysa elde
    // kalan plan kullanıcının reddettiği plandır. (Eski işlerde onay alanı yoktur; yürütme başladıysa onaylanmıştır.)
    if (!this.job.approvedAt && !this.job.startedAt) {
      this.log('system', 'info', 'Plan henüz onaylanmamıştı: onayınızı bekliyor.');
      return this.update({ phase: 'awaiting_approval', error: null });
    }
    // Kesilen görevler kaldıkları yerden sürer; sorunlu kalmış görevler yeniden denenir. Kodlanıp incelenmiş ama
    // hafıza / commit adımında kesilmiş görev ("finishing") yeniden yazılmaz: yalnızca o adım tamamlanır.
    for (const t of this.job.tasks) if (t.status !== 'done' && t.status !== 'skipped' && !finishing(t)) t.status = 'pending';
    this.update({ error: null });
    this.guarded(() => this.pipeline());
  }

  // ---------- yürütme ----------
  async pipeline() {
    const job = this.job;
    const s = this.cfg();
    const dir = job.projectDir;
    this.update({ phase: 'running', startedAt: job.startedAt || Date.now(), error: null });
    this.log('system', 'step', `Yürütme başladı · ajan: ${agents.ADAPTERS[job.agent].label}${this.modelNote(s)}`);

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
    job.designRefs = written.designRefs;
    job.designPages = written.designPages;
    if (job.designPages?.length && !(job.designPreviews || []).every((f) => fs.existsSync(path.join(dir, f)))) await this.designPreviews();
    this.log('system', 'info', `Teknik şartname yazıldı: ${written.specPath}${job.designRefs?.length ? ` · tasarım dosyaları: docs/sonda/design (${job.designRefs.length})` : ''}`);
    if (this.useGit) {
      await this.commit(dir, 'sonda: teknik şartname ve referans dokümanlar');
      if (!job.baseCommit) job.baseCommit = await project.headCommit(dir);
    }

    job.gates = job.gates || {};
    job.phaseStart = job.phaseStart || {};
    const tasks = job.tasks;
    const multiPhase = new Set(tasks.map((t) => t.phase).filter(Boolean)).size > 1;
    const touched = new Set(); // bu çalıştırmada kodu değişen fazlar
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      const ran = task.status !== 'done' && task.status !== 'skipped' && !finishing(task);
      if (finishing(task)) {
        this.checkAbort();
        this.log('system', 'info', `"${task.title}" kodlanmış ve incelenmişti; yalnızca hafıza ve commit adımı tamamlanıyor.`);
        await this.finishTask(task, i + 1);
        touched.add(task.phase);
      } else if (ran) {
        this.checkAbort();
        if (multiPhase && task.phase && !job.phaseStart[task.phase] && this.useGit) job.phaseStart[task.phase] = await project.headCommit(dir);
        await this.runTask(task, s);
        touched.add(task.phase);
      }
      // Faz bittiğinde kalite kapısı. Son faz, son doğrulamayla birlikte değerlendirilir. Sürdürmede bir kapı yalnızca
      // hiç bitmediyse, katı kapı işi durdurduysa ya da fazında bir görev yeniden çalıştıysa tekrarlanır.
      const next = tasks[i + 1];
      const gate = job.gates[task.phase];
      const gateDue = !gate || (gate.status !== 'passed' && (gate.status !== 'failed' || gate.blocked || touched.has(task.phase)));
      if (multiPhase && task.phase && next && next.phase !== task.phase && gateDue) {
        await this.runPhaseGate(task.phase, s);
      }
      // Bağımsız denetim: birkaç görevde bir, bitmiş kodun tamamı kalan görevlerle birlikte denetlenir (bkz. audit.js).
      if ((ran && this.auditDue(i, s)) || this.auditInterrupted(task, s)) {
        this.checkAbort();
        await this.runAudit(i, s);
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

  // Tam doğrulama. `fresh`: commit'li proje geçici bir klasöre klonlanıp sıfırdan kurulur, tip kontrolü ve
  // testleri çalıştırılır ("yalnızca bu klasörde çalışıyor" hatalarını yakalar). Diğer kontroller geçtiyse anlamlıdır.
  async fullChecks({ fresh = false } = {}) {
    this.localEnv();
    this.syncEnv();
    const v = this.job.plan.verify || {};
    const dir = this.job.projectDir;
    const log = (l) => this.log('test', l.lvl, l.text);
    const checks = await this.checksOnline(() => verify.runChecks({ dir, full: true, extraCommands: v.commands, setupCommands: v.setup, log, signal: this.signal }));
    if (fresh && this.cfg().freshCloneCheck !== false && this.useGit && !this.signal?.aborted && !checks.some((c) => !c.ok && !c.env)) {
      this.log('test', 'step', 'Temiz kurulum denetimi: proje yeni bir klonda sıfırdan kurulup test ediliyor…');
      const fc = await this.checksOnline(() => verify.freshCloneCheck({ dir, log, signal: this.signal }));
      if (fc) checks.push(fc);
    }
    return checks;
  }

  /**
   * Bir inceleme turu (faz kapısı ve son kabul ortak): yönetici incelemesi, güvenlik denetimi, derin inceleme, uzman
   * paneli ve açık bulguların yeniden doğrulanması paralel çalışır; sonuç settleRound ile birleştirilir.
   * - managerLeads: karar yöneticinin incelemesinden gelir (son kabul; faz kapısında "her adımda" rolü). Değilse
   *   karar derin incelemeden gelir; o da yoksa yöneticiye düşülür.
   * - deep: { scope, tasks, reqIds }; düzeltme turlarında derin inceleme yalnızca bildirdiklerini doğrular, önceki turda
   *   zaten onayladıysa hiç çalışmaz. panel yalnızca ilk turda çalışır.
   * Dönen: { review, deep, src }
   */
  async reviewRound({ attempt, checks, smoke, prevDeep, deepOn, manager, managerLeads, security, deep: deepScope, panel, at, label, prevPanel }) {
    const focus = attempt > 0 ? this.deepBlocking(prevDeep) : null;
    const openNow = deepOn ? panelLib.ledgerOpen(this.ledger()) : [];
    const deepTask = () => (!deepOn
      ? Promise.resolve(null)
      : attempt > 0 && prevDeep && !focus.length
        ? Promise.resolve(prevDeep)
        : this.deepReview({ ...deepScope, checks, smoke, focus }));
    const [first, findings, deep, pnl, recheck] = await this.withCleanTree(() => this.together([
      managerLeads ? manager() : Promise.resolve(null),
      security ? security() : Promise.resolve([]),
      deepTask(),
      panel && attempt === 0 ? this.reviewPanel(panel) : Promise.resolve(null),
      openNow.length ? this.recheckFindings(openNow, label) : Promise.resolve(null),
    ]));
    const raw = managerLeads ? first : deep ? this.neutralReview(deep) : await this.reviewFallback(manager, checks);
    const src = !managerLeads && deep ? 'review' : 'manager';
    const review = await this.settleRound({
      raw,
      checks,
      extra: { ...(smoke?.error ? { forceIssue: `Uygulama çalıştırılamadı: ${smoke.error}` } : {}), forceIssues: this.smokeIssues(smoke) },
      security: findings,
      deep,
      panel: pnl,
      recheck,
      openBefore: openNow,
      at,
      label,
      canVerify: deepOn,
      // Düzeltme turlarında panel yeniden çalışmaz; özeti arayüzde kalsın (engelleyiciliği yeniden doğrulama belirler).
      prevPanel,
      keepPrev: attempt > 0,
    });
    return { review, deep, src };
  }

  // Faz kalite kapısı: tüm kontroller + entegrasyon/e2e + tarayıcı testi + regresyon incelemesi.
  async runPhaseGate(phaseName, s) {
    const job = this.job;
    const dir = job.projectDir;
    const lang = this.userLang();
    // Ekran görüntüsü etiketi fazın plandaki sırasıdır: yeniden çalışan kapı başka bir fazın görüntülerini ezmez.
    const gateNo = [...new Set(job.tasks.map((t) => t.phase).filter(Boolean))].indexOf(phaseName) + 1;
    const gate = (job.gates[phaseName] = { status: 'running', attempts: 0 });
    this.update({ phase: 'verifying', currentTaskId: null });
    this.log('system', 'step', `Faz kapısı: "${phaseName}" — tam doğrulama, entegrasyon testleri ve regresyon incelemesi`);

    let review;
    let prevDeep = null;
    let freshFailed = false;
    for (let attempt = 0; ; attempt++) {
      this.checkAbort();
      const checks = await this.fullChecks({ fresh: attempt === 0 || freshFailed });
      freshFailed = checks.some((c) => c.fresh && !c.ok && !c.env);
      const smoke = await this.runBrowserTest(s, `g${gateNo}-${attempt}`, checks);
      this.update({ phase: 'reviewing' });
      // Yönetici rolü "manager" iken faz kapısını ajanlar yürütür (derin inceleme + uzman paneli); yönetici yalnızca
      // ajan incelemesi sonuç vermezse devreye girer.
      const byAgent = this.agentsLead(s) && s.reviewLevel !== 'standard';
      if (!byAgent) this.log('manager', 'info', `Yönetici "${phaseName}" fazını bütün olarak inceliyor…`);
      const diff = this.useGit ? await project.diffSince(dir, job.phaseStart[phaseName] || null, 200000) : null;
      const snapshot = this.useGit ? await project.sourceSnapshot(dir, { priority: await project.changedFiles(dir, job.phaseStart[phaseName] || null), budget: 450000 }) : null;
      const phaseTasks = job.tasks.filter((t) => t.phase === phaseName && t.status !== 'skipped');
      const deepOn = s.reviewLevel !== 'standard';
      const installed = project.installedVersions(dir);
      // Uzman paneli ilk turda çalışır; panel açıkken güvenlik denetimini Claude'un güvenlik uzmanı yapar.
      const panelOn = deepOn && s.reviewPanel !== false;
      const managerGate = () => this.gem({ system: P.phaseReviewSystem(lang, phaseName), parts: P.finalReviewParts({ job, checks, smoke, diff, phase: phaseName, snapshot, installed }), schema: P.REVIEW_SCHEMA, temperature: 0.2, maxOutputTokens: 32768 });
      const round = await this.reviewRound({
        attempt,
        checks,
        smoke,
        prevDeep,
        deepOn,
        manager: managerGate,
        // Ajanların yürüttüğü kapıda karar derin incelemeden gelir; o da yoksa yöneticiye düşülür.
        managerLeads: !byAgent,
        security: panelOn ? null : () => this.securityAudit(diff, `faz "${phaseName}"`),
        deep: { scope: `phase "${phaseName}"`, tasks: phaseTasks, reqIds: [...new Set(phaseTasks.flatMap((t) => t.covers || []))] },
        panel: panelOn ? { scope: `phase "${phaseName}" (and the code it builds on)` } : null,
        at: `gate:${phaseName}`,
        label: `faz "${phaseName}"`,
        prevPanel: gate.review?.panel,
      });
      const { deep, src: reviewSrc } = round;
      review = round.review;
      if (deep) prevDeep = deep;
      // Uzlaşma kuralı (yalnız faz kapısı): tüm kontroller geçti, Claude projeyi çalıştırıp onayladı ve güvenlik
      // temizse, ilk incelemenin tek başına itirazları düzeltme turu açmaz; sonraki görevlere ve son kabule aktarılır.
      const checksOk = !checks.some((c) => !c.ok && !c.env) && !smoke?.error;
      const secOk = !(review.security || []).some((f) => ['critical', 'high'].includes(f.severity));
      if (review.verdict === 'fix' && deep && !this.deepBlocking(deep).length && deep.verdict !== 'fix' && checksOk && secOk && !review.panel?.blocking && !(review.openFindings || []).length && !this.smokeIssues(smoke).length) {
        job.carryOver = [...(job.carryOver || []), ...review.issues.map((i) => `Faz "${phaseName}" incelemesinden (doğrula, geçerliyse düzelt): ${i}`)].slice(-30);
        this.log('system', 'info', `Kontroller geçti ve derin inceleme onayladı: ${reviewSrc === 'manager' ? 'yöneticinin' : 'incelemenin'} ${review.issues.length} notu düzeltme turu açılmadan sonraki görevlere ve son kabule aktarıldı.`);
        review.deferred = review.issues;
        review.issues = [];
        review.verdict = 'pass';
      }
      gate.review = review;
      this.trackRequirements(review);
      if (deep) this.trackRequirements({ requirementChecks: deep.requirementChecks || [] }, { authoritative: true });
      this.logReview(review, `Faz kapısı (${phaseName})`, reviewSrc);
      if (review.verdict === 'pass') {
        gate.status = 'passed';
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
      if (this.useGit) await this.commit(dir, `sonda: ${phaseName} faz düzeltmeleri (${attempt + 1})`, `gate:${phaseName}`);
    }

    docs.appendProgress(dir, `## ${gate.status === 'passed' ? '✓' : '✕'} Faz kapısı — ${phaseName}
- ${new Date().toLocaleString('tr-TR')} · kalite ${review.qualityScore ?? '-'}/10 · ${review.summary}
${(review.issues || []).map((i) => `- Açık: ${i}`).join('\n')}`);
    if (this.useGit) await this.commit(dir, `sonda: faz kapısı — ${phaseName}`, `gate:${phaseName}`);
    this.update({ phase: 'running' });

    if (gate.status === 'failed' && s.strictPhaseGates) {
      gate.blocked = true; // sürdürmede bu kapı yeniden çalışır
      throw new Error(`"${phaseName}" fazının kalite kapısı ${s.maxFixAttempts} düzeltme turundan sonra geçilemedi; sonraki faz sağlam olmayan bir temel üzerine kurulmasın diye durduruldu. Açık sorunlar yukarıda. Talimat ekleyip "Sürdür" diyebilir ya da Ayarlar'dan katı faz kapısını kapatabilirsiniz.`);
    }
  }

  // Hafızayı ajan günceller (yönetici rolü "manager" iken): farkı ve dosyaları kendisi okur. Dönen: { memory, carryOver, lessons } | null
  async agentMemory(task, diff) {
    const rid = this.reviewerId();
    if (!rid) return null;
    try {
      const res = await this.runAgent(P.memoryAgentPrompt({ job: this.job, task, diff: diff && { ...diff, diff: clipDiff(diff.diff, MEMORY_DIFF_CHARS) } }), { mode: 'review', schema: P.MEMORY_JSON_SCHEMA, agentId: rid, label: 'proje hafızası', src: 'review', timeoutMin: 10, effort: 'low', quiet: true });
      const out = res.structured || agents.jsonFromText(res.transcript || res.text);
      return typeof out?.memory === 'string' ? out : null;
    } catch (e) {
      this.checkAbort();
      if (agents.AUTH_ERROR.test(e.message)) throw e;
      this.log('review', 'warn', `Hafıza oturumu başarısız: ${e.message}`);
      return null;
    }
  }

  // Proje hafızası: gerçek kod farkına bakılarak MEMORY.md güncellenir,
  // sonraki görevler için devreden notlar çıkarır; PROGRESS.md'ye kayıt düşülür.
  async remember(task, heading) {
    const job = this.job;
    const dir = job.projectDir;
    const s = this.cfg();
    const diff = this.useGit ? await project.diffSince(dir, task.baseCommit || null, 150000) : null;
    this.checkAbort();
    const byAgent = this.agentsLead(s);
    const who = byAgent ? agents.ADAPTERS[this.reviewerId()].label : 'Yönetici';
    const src = byAgent ? 'review' : 'manager';
    this.log(src, 'info', `${who} proje hafızasını güncelliyor…`);
    try {
      const viaManager = () => this.gem({ system: P.MEMORY_SYSTEM, parts: [{ text: P.memoryUserText({ job, task, diff }) }], schema: P.MEMORY_SCHEMA, temperature: 0.2 });
      const r = byAgent ? (await this.agentMemory(task, diff)) || (settings.managerReady(this.cfg()) ? await viaManager() : null) : await viaManager();
      if (r?.memory?.trim()) {
        job.memory = r.memory.trim();
        job.carryOver = (r.carryOver || []).filter(Boolean).slice(0, 30);
        // Dersler: doğrulanmış kusurlardan damıtılan, projeye özgü kurallar (sonraki brif, görev ve incelemelere girer).
        if (Array.isArray(r.lessons)) {
          const before = (job.lessons || []).length;
          job.lessons = r.lessons.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()).slice(0, 15);
          if (job.lessons.length > before) this.log(src, 'info', `Projeye ${job.lessons.length - before} yeni ders eklendi (doğrulanmış kusurlardan çıkarılan kural): ${job.lessons.slice(before).map((x) => x.slice(0, 140)).join(' · ')}`);
        }
        docs.writeMemory(dir, job.memory);
        this.log(src, 'ok', `Hafıza güncellendi (${Math.round(job.memory.length / 1000)}K karakter${job.carryOver.length ? `, ${job.carryOver.length} devreden not` : ''}).`);
        for (const c of job.carryOver.slice(0, 5)) this.log(src, 'dim', `devreden: ${c}`);
      } else {
        this.log(src, 'warn', 'Hafıza güncellenemedi (yanıt alınamadı); ilerleme günlüğü yine de yazılıyor.');
      }
    } catch (e) {
      this.checkAbort();
      this.log(src, 'warn', `Hafıza güncellenemedi (${e.message}); ilerleme günlüğü yine de yazılıyor.`);
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
    const lang = this.userLang();
    this.update({ phase: 'verifying', currentTaskId: null });
    this.log('system', 'step', 'Son doğrulama ve uçtan uca test');

    let checks = [];
    let smoke = null;
    let review = null;
    let prevDeep = null;
    let freshFailed = false;
    for (let attempt = 0; ; attempt++) {
      this.checkAbort();
      checks = await this.fullChecks({ fresh: attempt === 0 || freshFailed });
      freshFailed = checks.some((c) => c.fresh && !c.ok && !c.env);
      smoke = await this.runBrowserTest(s, `f-${attempt}`, checks);

      this.update({ phase: 'reviewing' });
      this.log('manager', 'info', 'Yönetici tüm projeyi, test sonuçlarını ve ekran görüntülerini inceliyor…');
      const diff = this.useGit ? await project.diffSince(dir, job.baseCommit, 250000) : null;
      const snapshot = this.useGit ? await project.sourceSnapshot(dir, { budget: 500000 }) : null;
      const notMet = (job.plan.requirements || []).map((r) => r.id).filter((id) => (job.reqStatus || {})[id] !== 'met');
      const depAudit = s.securityReview ? await verify.dependencyAudit(dir, this.signal).catch(() => null) : null;
      if (depAudit) this.log('test', depAudit.highCritical.length ? 'warn' : 'ok', `Bağımlılık güvenlik taraması: ${depAudit.summary}${depAudit.highCritical.length ? ` — ${depAudit.highCritical.slice(0, 5).join(', ')}` : ''}`);
      const deepOn = s.reviewLevel !== 'standard';
      const installed = project.installedVersions(dir);
      // Bakım işlerinde değişen kod her görevin sonunda uzmanlarca incelendi; tüm proje yeniden taranmaz.
      // Özellik ekleme yeni yüzey getirir: eklenen özellik ve dokunduğu kod üç uzmanca da taranır.
      const panelOn = deepOn && s.reviewPanel !== false && (!job.kind || job.kind === 'feature');
      const finalScope = job.kind ? `the ${P.MAINTENANCE_LABEL[job.kind]} just applied to the project and the code it touches (final acceptance of the change, including regressions)` : 'the whole project (final acceptance)';
      // İlk turda: daha önce "belirsiz" kalan bulgular kararlı biçimde değerlendirilir (ya açık ya yanlış alarm).
      // Teslimden önce defterde açık orta+ bulgu kalamaz (reviewRound açık olanları yeniden doğrular).
      if (deepOn && attempt === 0) await this.withCleanTree(() => this.settleUncertain());
      const securityDue = attempt === 0 || (review?.security || []).length || depAudit?.highCritical?.length;
      const round = await this.reviewRound({
        attempt,
        checks,
        smoke,
        prevDeep,
        deepOn,
        manager: () => this.gem({ system: P.finalReviewSystem(lang), parts: P.finalReviewParts({ job, checks, smoke, diff, snapshot, installed }), schema: P.REVIEW_SCHEMA, temperature: 0.2, maxOutputTokens: 32768 }),
        managerLeads: true,
        security: panelOn || !securityDue ? null : () => this.securityAudit(diff, 'tüm proje', depAudit),
        deep: { scope: finalScope, tasks: job.tasks.filter((t) => t.status !== 'skipped'), reqIds: notMet },
        panel: panelOn ? { scope: finalScope, depAudit } : null,
        at: 'final',
        label: 'son kabul',
        prevPanel: job.finalReview?.panel,
      });
      const { deep } = round;
      review = round.review;
      if (deep) prevDeep = deep;
      // Kanıtla düzeltilmiş puan: defterde açık bulgu varken yüksek puan verilemez.
      const stillOpen = panelLib.ledgerOpen(this.ledger());
      if (stillOpen.length && review.qualityScore != null) review.qualityScore = Math.min(review.qualityScore, stillOpen.some((f) => SEVERE.has(f.severity)) ? 5 : 7);
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
      if (this.useGit) await this.commit(dir, `sonda: son düzeltmeler (${attempt + 1})`, 'final');
    }

    this.update({ phase: 'reporting' });
    this.log('manager', 'info', 'Teslim raporu yazılıyor…');
    // Rapor bir özet belgesidir: yöneticiye ulaşılamazsa saatler süren iş "hata" ile bitmez, özet Sonda'dan çıkar.
    let report;
    try {
      report = await this.gem({ system: P.reportSystem(this.userLang()), parts: [{ text: P.reportUserText({ job, checks, smoke, finalReview: review }) }], temperature: 0.3 });
    } catch (e) {
      this.checkAbort();
      this.log('manager', 'warn', `Teslim raporu yönetici ile yazılamadı (${e.message}); özet rapor eldeki sonuçlardan oluşturuldu.`);
      report = this.fallbackReport(review, checks, smoke);
    }
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

  // Yöneticiye ulaşılamadığında: eldeki kanıtlardan kısa ve dürüst bir teslim raporu.
  fallbackReport(review, checks, smoke) {
    const job = this.job;
    const tasks = job.tasks.filter((t) => t.status !== 'skipped');
    const reqs = job.plan.requirements || [];
    const st = job.reqStatus || {};
    const met = reqs.filter((r) => st[r.id] === 'met').length;
    const open = reqs.filter((r) => st[r.id] !== 'met');
    const badPages = (smoke?.pages || []).filter((p) => p.errors.length || (p.status && p.status >= 400));
    const lines = [
      '## Özet',
      review.summary || job.plan.summary || '',
      '',
      '## Görevler',
      ...tasks.map((t) => `- ${t.status === 'done' ? '✓' : '✕'} ${t.title}${t.review?.qualityScore ? ` — kalite ${t.review.qualityScore}/10` : ''}`),
      '',
      '## Test sonuçları',
      ...(checks.length ? checks.map((c) => `- ${c.name}: ${c.env ? 'atlandı (ortam)' : c.ok ? 'geçti' : 'BAŞARISIZ'}`) : ['- Doğrulama komutu çalıştırılmadı.']),
      ...(smoke?.pages ? [`- Tarayıcı testi: ${smoke.pages.length} sayfa gezildi, ${badPages.length} sorunlu`] : smoke?.error ? [`- Tarayıcı testi başarısız: ${smoke.error}`] : []),
      '',
      '## Gereksinim kapsamı',
      reqs.length ? `${met}/${reqs.length} gereksinim doğrulandı.` : 'Kayıtlı gereksinim yok.',
      ...open.slice(0, 40).map((r) => `- ${r.id} (${st[r.id] === 'partial' ? 'kısmen' : st[r.id] === 'missing' ? 'eksik' : 'doğrulanmadı'}): ${r.text}`),
      '',
      '## Son inceleme',
      `${review.verdict === 'pass' ? 'Onaylandı' : 'Açık sorunlar var'}${review.qualityScore ? ` · kalite ${review.qualityScore}/10` : ''}`,
      ...(review.issues || []).map((i) => `- ${i}`),
      '',
      '## Bulgu defteri',
      (() => {
        const st = panelLib.ledgerStats(job.findings);
        return st.total ? `${st.fixed} bulgu düzeltildi ve yeniden doğrulandı, ${st.open} açık, ${st.uncertain} doğrulanamadı.` : 'Doğrulanmış kusur kaydı yok.';
      })(),
      ...(job.findings || []).filter((f) => f.status === 'open').map((f) => `- AÇIK ${f.id} [${f.severity}] ${f.title}${f.file ? ` (${f.file})` : ''}`),
      ...(job.findings || []).filter((f) => f.status === 'uncertain').slice(0, 15).map((f) => `- Elle kontrol: ${f.id} [${f.severity}] ${f.title}${f.file ? ` (${f.file})` : ''}`),
      '',
      '_Bu rapor, yöneticiye ulaşılamadığı için Sonda tarafından eldeki sonuçlardan oluşturuldu._',
    ];
    return lines.join('\n');
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

module.exports = Pipeline;
