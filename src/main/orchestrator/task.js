// Görev: taban (kesintiden sonra kaldığı yerden), teknik brif, isteğe bağlı TDD, kodlama ve
// doğrulama → inceleme → düzeltme döngüsü.
// (Orchestrator sınıfının yöntemleri; bkz. index.js — `this` orkestratördür.)
const settings = require('../settings');
const agents = require('../agents');
const project = require('../project');
const verify = require('../verify');
const panelLib = require('../panel');
const { claudeModelLabel, briefModelOf } = require('../models');
const P = require('../prompts');
const { SEVERE, PANEL_LABELS } = require('./shared');

class Task {
  async runTask(task, s) {
    const job = this.job;
    const n = job.tasks.indexOf(task) + 1;
    job.currentTaskId = task.id;
    this.setTask(task, { status: 'running', step: 'working', startedAt: Date.now(), attempts: 0 });
    this.log('system', 'step', `Görev ${n}/${job.tasks.length}: ${task.title}`);
    const carried = await this.beginTask(task);
    const tree = project.fileTree(job.projectDir, { maxEntries: 300, maxDepth: 5 });
    // Kesilip sürdürülen görevde brif önceki çalışmadan durur: yeniden yazdırılmaz (brif en pahalı salt okunur
    // oturumdur). Yeniden planlanan görevin brifi yoktur ve yazılır.
    if (s.taskBriefing && task.brief && carried.length) {
      this.log('review', 'info', `Teknik brif önceki çalışmadan korunuyor (${task.briefBy || 'brif'}, ${Math.round(task.brief.length / 1000)}K karakter); yeniden yazdırılmadı.`);
    } else if (s.taskBriefing) {
      task.brief = (await this.writeBrief(task, tree, s)) || task.brief;
      this.update();
    }
    await this.writeTddTests(task, s, n);
    const res = await this.codeTask(task, s, { tree, carried, n });
    if (!s.verifyEachTask) this.setTask(task, { status: res.ok ? 'done' : 'failed' });
    else await this.verifyAndFix(task, s, res);
    await this.finishTask(task, n);
  }

  /**
   * Görevin tabanını belirler ve o tabandan beri değişen dosyaları döner (daha önce başlayıp kesilen görevin işi).
   * Görevin tabanı: inceleme, görevin BAŞINDAN beri değişen her şeye bakar. Uygulama kapanıp açılınca yarım kalan
   * iş "şartname" commit'ine girse bile fark kaybolmaz; görev baştan çalışmaz, kaldığı yerden tamamlanır.
   * Taban eskidiyse (bu görevden sonra başka görevler ya da kapı düzeltmeleri commit'lendiyse — ör. sorunlu kalmış
   * bir görev sonradan yeniden çalışıyor) yenilenir; aksi halde başkalarının işi bu görevin farkı sanılırdı.
   */
  async beginTask(task) {
    const job = this.job;
    const dir = job.projectDir;
    if (this.useGit) {
      const stale = task.baseCommit && job.lastCommit && job.lastCommit.owner !== task.id && job.lastCommit.at > (task.baseAt || 0);
      if (!task.baseCommit || stale) {
        task.baseCommit = await project.headCommit(dir);
        task.baseAt = Date.now();
      }
    }
    const carried = this.useGit && task.baseCommit ? await project.changedFiles(dir, task.baseCommit) : [];
    if (carried.length) this.log('system', 'info', `Bu görev daha önce başlamıştı: ${carried.length} dosyada yapılmış iş duruyor. Ajan baştan başlamayacak, kalan işi tamamlayacak; inceleme görevin tüm farkına bakacak.`);
    return carried;
  }

  /**
   * Görev öncesi teknik brif. Varsayılan: Claude Fable 5.1 kodu gezerek yazar (salt okunur oturum). Claude kurulu
   * değilse ya da Ayarlar'da Gemini seçildiyse Gemini yazar (dosya ağacı + anahtar dosyalar üzerinden).
   * Dönen: brif metni ya da yazılamadıysa null (görev planıyla devam edilir).
   */
  async writeBrief(task, tree, s) {
    const job = this.job;
    const dir = job.projectDir;
    const model = briefModelOf(s);
    if (model && agents.resolveBin('claude', s)) {
      const label = claudeModelLabel(model);
      this.log('review', 'step', `Teknik brif: Claude ${label} kodu inceleyip bu görevin brifini yazıyor…`);
      try {
        const res = await this.runAgent(P.briefAgentPrompt({ job, task }), { mode: 'review', agentId: 'claude', model, label: `teknik brif · ${label}`, src: 'review', timeoutMin: 15, quiet: true });
        const brief = String(res.text || '').trim();
        if (res.ok && brief.length >= 400) {
          this.log('review', 'ok', `Teknik brif hazır (Claude ${label}, ${Math.round(brief.length / 1000)}K karakter).`);
          task.briefBy = `Claude ${label}`;
          return brief;
        }
        this.log('review', 'warn', `Claude ${label} kullanılabilir bir brif vermedi${res.error ? ` (${String(res.error).split('\n')[0].slice(0, 160)})` : ''}.`);
      } catch (e) {
        this.checkAbort();
        if (agents.AUTH_ERROR.test(e.message)) throw e;
        this.log('review', 'warn', `Brif oturumu başarısız: ${e.message}`);
      }
      if (!settings.managerReady(settings.get())) {
        this.log('system', 'warn', 'Brif hazırlanamadı; görev planıyla devam ediliyor.');
        return null;
      }
      this.log('gemini', 'info', 'Brifi Gemini yazıyor (yedek)…');
    } else {
      this.log('gemini', 'info', 'Gemini mevcut kodu okuyup bu görev için teknik brif hazırlıyor…');
    }
    try {
      const brief = String(await this.gem({
        system: P.BRIEF_SYSTEM,
        parts: [{ text: P.briefUserText({ job, task, fileTree: tree, keyFiles: project.keyFiles(dir) }) }],
        temperature: 0.3,
        maxOutputTokens: 32768,
        progressLabel: 'Brif yazılıyor',
      })).trim();
      this.log('gemini', 'ok', `Teknik brif hazır (${Math.round(brief.length / 1000)}K karakter).`);
      task.briefBy = 'Gemini';
      return brief;
    } catch (e) {
      this.checkAbort();
      this.log('gemini', 'warn', `Brif hazırlanamadı, görev planıyla devam ediliyor: ${e.message}`);
      return null;
    }
  }

  // TDD: önce bağımsız bir QA oturumu testleri yazar; uygulayıcı bu testleri geçirecek kodu yazar.
  async writeTddTests(task, s, n) {
    const job = this.job;
    const dir = job.projectDir;
    const app = project.nodeApp(dir);
    if (!(s.tddMode && n > 1 && app?.scripts?.test && (task.tests?.length || task.acceptance?.length) && this.useGit)) return;
    // Testler önceki çalışmada yazılıp commit'lendiyse (görev kesildi ya da sorunlu kalıp yeniden deneniyor) yeniden
    // yazdırılmaz: ikinci bir test takımı ilkini ezer.
    if (task.tddCommit) return;
    this.log('system', 'step', `TDD · QA mühendisi önce "${task.title}" testlerini yazıyor…`);
    const before = await project.headCommit(dir);
    const isTest = (f) => /(^|\/)(__tests__|tests?|e2e|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$/.test(f);
    const tres = await this.runAgent(P.testAuthorPrompt(job, task, s.standards), { label: 'TDD testleri', src: 'agent' });
    let written = (await project.changedFiles(dir, before)).filter(isTest);
    // Testler kod yazılmadan önce incelenir: yanlış beklenti ya da test ortamında çalışamayacak test,
    // uygulayıcıyı yanlış ürüne zorlar.
    if (tres.ok && written.length) {
      try {
        const { tr, src } = await this.reviewTddTests(task, written, s);
        if (tr?.verdict === 'fix' && tr.problems?.length) {
          this.log(src, 'warn', `TDD test incelemesi: ${tr.problems.length} sorun — testler kod yazılmadan önce düzeltiliyor.`);
          for (const pr of tr.problems.slice(0, 6)) this.log(src, 'dim', `• ${pr.file ? `${pr.file}: ` : ''}${pr.problem}`);
          const canResume = agents.ADAPTERS[job.agent].supportsResume && tres.sessionId;
          await this.runAgent(canResume ? P.testFixPrompt(task, tr) : `${P.testAuthorPrompt(job, task, s.standards)}\n\n${P.testFixPrompt(task, tr)}`, { resumeId: canResume ? tres.sessionId : null, label: 'TDD test düzeltmesi', src: 'agent' });
          written = (await project.changedFiles(dir, before)).filter(isTest);
        } else if (tr) {
          this.log(src, 'ok', 'TDD test incelemesi: testler şartnameyle uyumlu.');
        }
      } catch (e) {
        this.checkAbort();
        if (agents.AUTH_ERROR.test(e.message)) throw e;
        this.log('review', 'warn', `TDD test incelemesi yapılamadı: ${e.message}`);
      }
    }
    if (tres.ok && written.length) {
      await this.commit(dir, `sonda: TDD testleri — ${task.title}`, task.id);
      task.tddFiles = written;
      task.tddCommit = await project.headCommit(dir);
      this.log('test', 'ok', `TDD: ${written.length} test dosyası yazıldı (${written.slice(0, 6).join(', ')}${written.length > 6 ? '…' : ''}). Uygulayıcı bunları geçirecek.`);
    } else {
      this.log('test', 'warn', 'TDD testleri yazılamadı; görev normal akışla sürüyor.');
    }
    this.update();
  }

  /**
   * TDD testlerinin kod yazılmadan önceki incelemesi. Gemini "yönetici" rolündeyken bağımsız bir ajan oturumu yapar
   * (test dosyalarını ve dayandıkları kurulumu kendisi okur); sonuç vermezse ve anahtar varsa Gemini'ye düşülür.
   * Dönen: { tr: { verdict: 'ok' | 'fix', problems } | null, src (günlük kaynağı) }
   */
  async reviewTddTests(task, written, s) {
    const job = this.job;
    const files = project.fileContents(job.projectDir, written, 150000);
    const viaGemini = () => this.gem({ system: P.TEST_REVIEW_SYSTEM, parts: [{ text: P.testReviewUserText({ job, task, files }) }], schema: P.TEST_REVIEW_SCHEMA, temperature: 0.1 });
    const rid = this.agentsLead(s) ? this.reviewerId() : null;
    if (!rid) {
      this.log('gemini', 'info', 'Gemini TDD testlerini şartname ve kabul kriterleriyle karşılaştırıyor (kod yazılmadan önce)…');
      return { tr: await viaGemini(), src: 'gemini' };
    }
    this.log('review', 'info', `${agents.ADAPTERS[rid].label} TDD testlerini şartname ve kabul kriterleriyle karşılaştırıyor (kod yazılmadan önce)…`);
    const res = await this.runAgent(P.testReviewAgentPrompt({ job, task, files }), { mode: 'review', schema: P.TEST_REVIEW_JSON_SCHEMA, agentId: rid, label: 'TDD test incelemesi', src: 'review', timeoutMin: 10, effort: s.reviewEffort || undefined, quiet: true });
    const out = res.structured || agents.jsonFromText(res.transcript || res.text);
    if (['ok', 'fix'].includes(out?.verdict)) return { tr: out, src: 'review' };
    if (!settings.managerReady(settings.get())) {
      this.log('review', 'warn', 'TDD test incelemesi sonuç vermedi; testler incelenmeden devam ediliyor.');
      return { tr: null, src: 'review' };
    }
    this.log('gemini', 'info', 'TDD testlerini Gemini inceliyor (yedek)…');
    return { tr: await viaGemini(), src: 'gemini' };
  }

  // Kodlayan ajan görevi uygular; süre hedefini aşarsa sonraki göreve hatırlatma düşülür.
  async codeTask(task, s, { tree, carried, n }) {
    const job = this.job;
    const budgetMin = P.taskBudgetMin(task);
    const t0 = Date.now();
    const res = await this.runAgent(P.taskPrompt(job, task, s.standards, tree, { carried }), { label: `görev ${n}` });
    task.agentSummary = res.text || task.agentSummary;
    task.sessionId = res.sessionId || task.sessionId;
    task.agentMinutes = Math.round((Date.now() - t0) / 60000);
    if (task.agentMinutes > budgetMin * 1.5) {
      this.log('system', 'warn', `Görev ${n} hedeflenen ~${budgetMin} dk yerine ${task.agentMinutes} dk sürdü. Ajan gereğinden fazla uğraşmış olabilir; bir sonraki görevde süre hedefi hatırlatılacak.`);
      job.carryOver = [...new Set([...(job.carryOver || []), `Previous task took ${task.agentMinutes} min against a ~${budgetMin} min budget: keep verification proportional — implement, run the planned tests and the project checks, then stop.`])].slice(-30);
    } else {
      this.log('system', 'dim', `Ajan süresi: ${task.agentMinutes} dk (hedef ~${budgetMin} dk).`);
    }
    return res;
  }

  // Doğrulama → inceleme → düzeltme döngüsü: inceleme onaylayana ya da düzeltme hakkı bitene kadar.
  async verifyAndFix(task, s, firstRun) {
    const job = this.job;
    const dir = job.projectDir;
    const openMine = () => panelLib.ledgerOpen(this.ledger()).filter((x) => x.at === `task:${task.id}`);
    const round = { panelRan: false };
    let res = firstRun;
    for (let attempt = 0; ; attempt++) {
      this.checkAbort();
      this.setTask(task, { status: 'verifying' });
      this.log('test', 'step', `Doğrulama: ${task.title}`);
      const checks = await this.checksOnline(() => verify.runChecks({ dir, log: (l) => this.log('test', l.lvl, l.text), signal: this.signal }));
      this.checkAbort();

      this.setTask(task, { status: 'reviewing' });
      const { review, coreOk, src } = await this.reviewTask(task, s, { checks, res, attempt, round, mine: attempt > 0 ? openMine() : [] });
      task.review = review;
      this.addSuggestions(review.suggestions);
      this.logReview(review, `İnceleme (${task.title})`, src);

      if (review.verdict === 'pass') {
        this.setTask(task, { status: 'done' });
        return;
      }
      if (attempt >= s.maxFixAttempts) {
        // Yalnızca doğrulanmış orta seviye bulgular açık kaldıysa görev "sorunlu" sayılmaz: bulgular defterde açık
        // durur ve faz kapısı / son kabul bunlar kapanmadan geçilemez.
        const left = openMine();
        if (coreOk && left.length && !left.some((f) => SEVERE.has(f.severity))) {
          this.log('system', 'warn', `"${task.title}": ${left.length} orta seviye bulgu ${s.maxFixAttempts} düzeltme turunda kapanmadı; bulgu defterinde açık kaldı — faz kapısı bunlar düzelmeden geçilemez.`);
          review.deferred = review.issues;
          review.issues = [];
          review.verdict = 'pass';
          this.setTask(task, { status: 'done' });
        } else {
          this.log('system', 'warn', `"${task.title}" ${s.maxFixAttempts} düzeltme denemesinden sonra hâlâ sorunlu; sonraki göreve geçiliyor.`);
          this.setTask(task, { status: 'failed' });
        }
        return;
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

  /**
   * Bir turun incelemesi: ilk inceleme (ajan ya da Gemini), uzman paneli, bulguların doğrulanması, deftere kayıt ve
   * — düzeltme turundan sonra — açık bulguların yeniden doğrulanması.
   * Dönen: { review, coreOk (bulgular dışında engel yok mu), src (günlük kaynağı) }
   */
  async reviewTask(task, s, { checks, res, attempt, round, mine }) {
    const job = this.job;
    const dir = job.projectDir;
    const lang = this.userLang();
    const base = task.baseCommit || null;
    const rid = s.reviewLevel !== 'standard' && this.useGit ? this.reviewerId() : null;
    const where = `görev "${task.title}"`;
    const byAgent = this.agentsLead(s);
    if (!byAgent) this.log('gemini', 'info', 'Gemini değişikliği kırmayı deneyerek inceliyor (görevin tüm farkı, değişen dosyalar ve içe aktardıkları, kabul kriterleri, testler)…');
    const diff = this.useGit ? await project.diffSince(dir, base, 80000) : null;
    const changed = this.useGit ? await project.changedFiles(dir, base) : [];
    let tddNote = null;
    if (task.tddCommit) {
      const changedTests = await project.diffPaths(dir, task.tddCommit, task.tddFiles);
      tddNote = changedTests
        ? `The QA engineer wrote these tests first: ${task.tddFiles.join(', ')}. The implementer MODIFIED them — check every change is a justified correction and does not weaken the tests (blocking if it does):\n${changedTests}`
        : `The QA engineer wrote these tests first: ${task.tddFiles.join(', ')}. The implementer did not modify them.`;
    }
    const installed = project.installedVersions(dir);
    // İlk inceleme. Gemini "yönetici" rolündeyken bağımsız bir ajan oturumu yapar (kodu gezer, testleri çalıştırır);
    // "her adımda" rolündeyken Gemini yapar (fark, değişen dosyalar ve içe aktardıkları üzerinden).
    const geminiReview = () => this.gem({
      system: P.reviewSystem(lang),
      parts: [{ text: P.reviewUserText({ job, task, agentSummary: task.agentSummary, checks, diff, files: this.useGit ? project.fileContents(dir, changed, 200000) : null, related: this.useGit ? project.relatedFiles(dir, changed, 100000).text : '', tddNote, installed }) }],
      schema: P.REVIEW_SCHEMA,
      temperature: 0.2,
      maxOutputTokens: 32768,
    });
    const checksOk = !checks.some((c) => !c.ok && !c.env);
    // Uzmanlar kontrollerin geçtiği ilk turda bir kez çalışır (başarısız build'de önce o düzeltilir) — ilk incelemeyle
    // PARALEL: ilk incelemenin sonucuna ihtiyaçları yok, yalnızca doğrulama aşaması onun bulgularını da alır.
    // (Sırayla çalıştırmak her görevde dakikalarca bekletiyordu.)
    const specialistsOn = !round.panelRan && checksOk && !!rid && s.reviewPanel !== false && changed.length > 0;
    const [first, deep, recheck, outs] = await this.together([
      byAgent ? this.agentReview(task, { checks, changed, diff, tddNote, installed }) : geminiReview(),
      // Maksimum inceleme gücünde (ilk incelemeyi Gemini yapıyorsa) Claude da bağımsız derin inceleme yapar.
      !byAgent && s.reviewLevel === 'max' ? this.deepReview({ scope: `task "${task.title}"`, tasks: [task], reqIds: task.covers, checks, smoke: null }) : Promise.resolve(null),
      // Düzeltme turundan sonra: bu görevin açık bulguları güncel kodda yeniden doğrulanır (varsayım yok).
      mine.length && rid ? this.recheckFindings(mine, where) : Promise.resolve(null),
      specialistsOn ? this.taskSpecialists(task, changed, rid) : Promise.resolve(null),
    ]);
    // Ajan incelemesi sonuç vermediyse (oturum hatası, biçimsiz yanıt) Gemini'ye düşülür.
    const raw = first || (byAgent ? await this.reviewFallback(geminiReview, checks) : first);
    const src = byAgent && first ? 'review' : 'gemini';
    let review = this.normalizeReview(raw, checks, res.ok ? {} : { forceIssue: `Ajan görevi tamamlayamadı: ${String(res.error).slice(0, 300)}` });
    // İlk incelemenin bulguları da aynı doğrulayıcıdan geçer; uzmanlar çalışmamış olsa bile yeni bulgular doğrulanır.
    const mf = this.managerFindings(review);
    let pnl = null;
    if (specialistsOn) {
      round.panelRan = true;
      pnl = await this.settleTaskPanel(outs, mf, rid);
    } else if (mf.length && rid) {
      pnl = await this.settleTaskPanel(null, mf, rid);
    }
    review = this.mergeDeep(this.settleManager(review, pnl, mf, !!rid), deep);
    // Bu noktada "düzelt" kararı yalnızca nesnel/çekirdek nedenlere dayanır (bulgular aşağıda eklenir).
    const coreOk = review.verdict === 'pass';
    if (pnl) {
      this.recordFindings(pnl, `task:${task.id}`, where);
      // Doğrulanmış orta seviye bulgular da bu görevde düzeltilir: bağlam tazeyken, sonraki görevlere devretmeden.
      review = this.calibrateScore(panelLib.mergePanel(review, pnl, { labels: PANEL_LABELS }));
      if (review.scoreNote) this.log('review', 'info', review.scoreNote);
    }
    if (attempt > 0) review.panel = this.keepPanel(review.panel, task.review?.panel);
    if (recheck) review = panelLib.mergeOpenFindings(review, recheck.still, { labels: PANEL_LABELS });
    // Kodu gezip testleri çalıştıran ajan incelemesinin gereksinim kararları belirleyicidir.
    this.trackRequirements(review, { authoritative: src === 'review' });
    if (deep) this.trackRequirements({ requirementChecks: deep.requirementChecks || [] }, { authoritative: true });
    return { review, coreOk, src };
  }

  // Görev bitti: hafıza güncellenir, değişiklikler görevin adına commit'lenir. Adım kaydedilir: bu sırada kesilirse
  // sürdürmede görev yeniden yazılmaz, yalnızca bu adım tamamlanır (bkz. pipeline.resume).
  async finishTask(task, n) {
    const job = this.job;
    const dir = job.projectDir;
    this.setTask(task, { finishedAt: Date.now(), step: 'finishing' });
    await this.remember(task, `Görev ${n}/${job.tasks.length} — ${task.title}`);
    if (this.useGit) {
      const hash = await this.commit(dir, `sonda: ${task.title}${task.status === 'failed' ? ' (sorunlu)' : ''}`, task.id);
      if (hash) {
        task.commit = hash;
        this.log('system', 'dim', `commit ${hash}`);
      }
    }
    this.setTask(task, { step: 'closed' });
  }
}

module.exports = Task;
