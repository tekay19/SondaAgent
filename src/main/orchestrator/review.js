// İnceleme: inceleme sonucunun normalleştirilmesi, derin inceleme, uzman paneli, bulgu doğrulama, puan.
// (Orchestrator sınıfının yöntemleri; bkz. index.js — `this` orkestratördür.)
const settings = require('../settings');
const agents = require('../agents');
const panelLib = require('../panel');
const P = require('../prompts');
const { SEVERE, clampScore, PANEL_LABELS } = require('./shared');

class Review {
  // Güvenlik denetimi: ayrı bir uzman gözüyle diff; kritik/yüksek bulgular düzeltme turu başlatır.
  async securityAudit(diff, scopeLabel, depAudit = null) {
    if (!this.cfg().securityReview || !diff?.diff) return [];
    this.log('manager', 'info', `Güvenlik denetimi (${scopeLabel}): OWASP, yetki/IDOR, oturum, dosya yükleme, gizli anahtarlar…`);
    try {
      const r = await this.gem({
        system: P.SECURITY_SYSTEM,
        parts: [{ text: `# Specification\n${this.job.plan.spec}${depAudit ? `\n\n# Dependency audit (production dependencies)\n${depAudit.summary}\n${depAudit.highCritical.map((x) => `- ${x}`).join('\n') || '(no high/critical)'}` : ''}\n\n# Diff stat\n${diff.stat}\n\n# Diff\n${diff.diff}` }],
        schema: P.SECURITY_SCHEMA,
        temperature: 0.1,
      });
      const findings = (r?.findings || []).filter((f) => f?.title);
      const count = (sev) => findings.filter((f) => f.severity === sev).length;
      this.log('manager', findings.some((f) => ['critical', 'high'].includes(f.severity)) ? 'warn' : 'ok',
        `Güvenlik denetimi: ${findings.length ? `${count('critical')} kritik, ${count('high')} yüksek, ${count('medium')} orta, ${count('low')} düşük bulgu` : 'bulgu yok'}`);
      for (const f of findings.slice(0, 8)) this.log('manager', ['critical', 'high'].includes(f.severity) ? 'warn' : 'dim', `[${f.severity}] ${f.title}${f.file ? ` (${f.file})` : ''}`);
      return findings;
    } catch (e) {
      this.checkAbort();
      this.log('manager', 'warn', `Güvenlik denetimi yapılamadı: ${e.message}`);
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

  // Claude derin inceleme: projede gezer, testleri kendisi çalıştırır, kabul kriterlerini koddan izler.
  // İnceleyici dosya değiştiremez; yine de temiz ağaçta başlarsa sonrasında değişiklik kalmadığı garanti edilir.
  async deepReview({ scope, tasks, reqIds, checks, smoke, focus }) {
    const job = this.job;
    const rid = this.reviewerId();
    if (!rid) return null;
    this.log('review', 'step', focus?.length
      ? `${agents.ADAPTERS[rid].label} yeniden doğrulama: ${scope} — yalnızca bildirdiği ${focus.length} sorunun giderildiğine ve kontrollerin geçtiğine bakıyor…`
      : `${agents.ADAPTERS[rid].label} derin inceleme: ${scope} (projede geziyor, testleri kendisi çalıştırıyor)…`);
    const deep = await this.reviewSession(P.deepReviewPrompt({ job, scope, tasks, reqIds, checks, smoke, lang: this.userLang(), focus }), {
      schema: P.DEEP_REVIEW_SCHEMA,
      agentId: rid,
      label: `${focus?.length ? 'yeniden doğrulama' : 'derin inceleme'} · ${scope}`,
      timeoutMin: focus?.length ? 12 : 25,
      what: 'Derin inceleme',
      convert: true,
      quiet: false,
    });
    if (deep) {
      const blocking = (deep.issues || []).filter((i) => i.blocking || ['critical', 'high'].includes(i.severity));
      this.log('review', deep.verdict === 'pass' && !blocking.length ? 'ok' : 'warn', `Derin inceleme: ${deep.verdict === 'pass' && !blocking.length ? 'ONAYLANDI' : 'DÜZELTME GEREKLİ'} — ${deep.summary}`);
      for (const i of (deep.issues || []).slice(0, 10)) this.log('review', i.blocking ? 'warn' : 'dim', `[${i.severity}${i.blocking ? ', engelleyici' : ''}] ${i.title}${i.file ? ` (${i.file})` : ''}`);
      for (const t of (deep.testsRun || []).slice(0, 8)) this.log('review', t.result === 'pass' ? 'dim' : 'warn', `test: ${t.command} → ${t.result}${t.note ? ` · ${t.note}` : ''}`);
    }
    return deep;
  }

  /**
   * Salt okunur inceleme oturumu: yapılandırılmış sonuç ya da metinden ayrıştırılmış JSON (`convert`: şemaya uymayan
   * yanıt yöneticiyle şemaya dönüştürülür, bkz. structuredFrom). Sonuç alınamazsa (`valid` geçmezse) uyarı yazıp null
   * döner. İptal ve oturum (giriş) hataları yukarı taşınır: iş giriş olmadan süremez, arayüz "Giriş yap" düğmesini
   * gösterir. Bütün inceleme oturumları (derin inceleme, uzmanlar, doğrulayıcı, denetim) bu yoldan geçer.
   */
  async reviewSession(prompt, { schema, agentId, label, timeoutMin, effort, model, what = label, valid = () => true, convert = false, quiet = true } = {}) {
    try {
      const res = await this.runAgent(prompt, {
        mode: 'review',
        schema,
        agentId: agentId || this.reviewerId(),
        label,
        src: 'review',
        timeoutMin,
        effort: effort === undefined ? this.cfg().reviewEffort || undefined : effort,
        model,
        quiet,
      });
      const out = convert ? await this.structuredFrom(res, schema, what) : res.structured || agents.jsonFromText(res.transcript || res.text);
      if (!out || !valid(out)) {
        this.log('review', 'warn', `${what}: sonuç alınamadı${res.error ? ` (${String(res.error).split('\n')[0].slice(0, 200)})` : ''}.`);
        return null;
      }
      return out;
    } catch (e) {
      this.checkAbort();
      if (agents.AUTH_ERROR.test(e.message)) throw e;
      this.log('review', 'warn', `${what} yapılamadı: ${e.message}`);
      return null;
    }
  }

  // Uzman oturumlarını paralel ve salt okunur çalıştırır. Dönen: [{ key, out }] (out: { summary, findings, strengths } | null)
  runSpecialists(keys, promptFor, { rid, timeoutMin }) {
    return Promise.all(keys.map(async (key) => ({
      key,
      out: await this.reviewSession(promptFor(key), { schema: P.SPECIALIST_SCHEMA, agentId: rid, label: `uzman · ${P.SPECIALISTS[key].label}`, timeoutMin, what: P.SPECIALISTS[key].label, valid: (o) => Array.isArray(o?.findings) }),
    })));
  }

  panelFindings(outs) {
    return (outs || []).flatMap(({ key, out }) => (Array.isArray(out?.findings) ? out.findings : []).map((f) => ({ ...f, area: key, ...panelLib.parseFileRef(f.file, f.line) })));
  }

  /**
   * Bulguları (uzmanların ve varsa ilk incelemenin) ayrı bir doğrulayıcıdan geçirir ve panel nesnesini kurar. Yalnızca
   * doğrulanan bulgular düzeltmeye gider; yanlış alarmlar ajanın zamanını yemez.
   * Dönen: { confirmed, uncertain, rejected, low, summaries }
   */
  async settlePanel(findings, outs, rid, { logLabel, max = 12 }) {
    const toVerify = findings.filter((f) => f.severity !== 'low');
    const verified = toVerify.length ? await this.verifyPanelFindings(toVerify, rid) : [];
    const by = (v) => verified.filter((f) => f.verdict === v);
    const confirmed = by('confirmed');
    const uncertain = by('uncertain');
    const rejected = by('rejected');
    const severe = confirmed.filter((f) => SEVERE.has(f.severity)).length;
    this.log('review', severe ? 'warn' : 'ok', `${logLabel}: ${confirmed.length ? `${confirmed.length} doğrulanmış bulgu${severe ? ` (${severe} kritik/yüksek)` : ''}` : 'doğrulanmış bulgu yok'}${rejected.length ? `, ${rejected.length} yanlış alarm elendi` : ''}${uncertain.length ? `, ${uncertain.length} belirsiz` : ''}.`);
    for (const f of confirmed.slice(0, max)) this.log('review', SEVERE.has(f.severity) ? 'warn' : 'dim', `✓ [${f.severity}] ${PANEL_LABELS[f.area] || f.area}: ${f.title} (${f.file || '?'}${f.line ? `:${f.line}` : ''})`);
    return {
      confirmed,
      uncertain,
      rejected,
      low: findings.filter((f) => f.severity === 'low'),
      summaries: (outs || []).map(({ key, out }) => ({ area: key, summary: out?.summary || '', strengths: out?.strengths || [] })),
    };
  }

  // Uzman denetim paneli (yalnızca Claude): güvenlik, iş kuralları / veri bütünlüğü ve mimari / test
  // uzmanları paralel ve salt okunur inceler; ayrı bir Claude doğrulayıcı her bulguyu kodda kontrol eder.
  async reviewPanel({ scope, depAudit = null }) {
    const job = this.job;
    const rid = this.reviewerId();
    if (!rid) return null;
    const lang = this.userLang();
    const keys = Object.keys(P.SPECIALISTS);
    this.log('review', 'step', `Uzman denetim paneli (${agents.ADAPTERS[rid].label}): ${keys.map((k) => P.SPECIALISTS[k].label).join(' · ')} — ${scope}`);
    const outs = await this.runSpecialists(keys, (key) => P.specialistPrompt({ job, key, scope, lang, depAudit }), { rid, timeoutMin: 20 });
    for (const { key, out } of outs) if (out) this.log('review', 'info', `${P.SPECIALISTS[key].label}: ${out.findings.length} bulgu — ${out.summary || ''}`);
    return this.settlePanel(this.panelFindings(outs), outs, rid, { logLabel: 'Uzman paneli' });
  }

  /**
   * Görev sonu uzman incelemesi (ilk incelemeyle PARALEL başlatılır): güvenlik ve iş kuralları uzmanı her görevde
   * (kusurların çoğu "riskli" görünmeyen görevlerde de iş kuralı / hata yolu kusuruydu); mimari/test uzmanı iskelet
   * görevinde (araç zinciri, test düzeni orada belirlenir), riskli görevlerde, refactor/özellik işlerinde ve azami
   * inceleme seviyesinde. Amaç: hatayı faz sonunda değil, yazıldığı görevde yakalamak. Dönen: uzman çıktıları.
   */
  taskSpecialists(task, changedFiles, rid) {
    const job = this.job;
    const lang = this.userLang();
    const text = `${task.title} ${task.goal} ${task.details} ${(task.acceptance || []).join(' ')}`.toLowerCase();
    const risky = /(ödeme|payment|stripe|iyzico|para|money|fiyat|price|stok|stock|sipariş|order|yetki|auth|role|rol|izin|permission|admin|webhook|callback|kuyruk|queue|zamanlay|cron|schedule|tick|retry|tekrar|idempot|transaction|transaksiyon|eşzaman|concurren|lock|kilit|state machine|durum|status|limit|kota|quota|sayaç|counter|dnc|tenant|kiracı)/.test(text);
    const first = !job.kind && job.tasks.indexOf(task) === 0;
    const withQuality = job.kind === 'refactor' || job.kind === 'feature' || first || risky || this.cfg().reviewLevel === 'max';
    const keys = withQuality ? ['security', 'logic', 'quality'] : ['security', 'logic'];
    this.log('review', 'step', `Görev sonu uzman incelemesi (${agents.ADAPTERS[rid].label}): ${keys.map((k) => P.SPECIALISTS[k].label).join(' · ')}${job.kind ? '' : risky ? ' — görev riskli alanlara dokunuyor' : ''}`);
    return this.runSpecialists(keys, (key) => P.taskSpecialistPrompt({ job, task, key, changedFiles, lang }), { rid, timeoutMin: 8 });
  }

  // Görev sonu incelemenin doğrulama aşaması: uzman bulguları ve ilk incelemenin bulguları (`extra`) birlikte doğrulanır.
  // Uzmanlar çalışmadıysa (panel bu görevde zaten çalıştı) yalnızca ilk incelemenin bulguları doğrulanır.
  async settleTaskPanel(outs, extra, rid) {
    if (!outs) {
      const verified = extra.length ? await this.verifyPanelFindings(extra, rid) : [];
      return this.joinPanel(null, verified);
    }
    return this.settlePanel([...this.panelFindings(outs), ...extra], outs, rid, { logLabel: `Görev sonu incelemesi (uzmanlar${extra.length ? ' + ilk incelemenin bulguları' : ''})`, max: 8 });
  }

  // Puan kanıtla düzeltilir: doğrulanmış uzman bulgusu varken 10/10 verilemez.
  calibrateScore(review) {
    const n = (review.panel?.confirmed || []).length;
    const severe = (review.panel?.confirmed || []).filter((f) => SEVERE.has(f.severity)).length;
    if (!n || review.qualityScore == null) return review;
    const cap = severe ? 5 : n >= 3 ? 7 : 8;
    if (review.qualityScore > cap) {
      review.scoreNote = `İlk inceleme ${review.qualityScore}/10 vermişti; ${n} doğrulanmış bulgu nedeniyle ${cap}/10'a düşürüldü.`;
      review.qualityScore = cap;
    }
    return review;
  }

  async verifyPanelFindings(findings, rid, { decisive = false } = {}) {
    const dir = this.job.projectDir;
    const items = findings.map((f, i) => ({ i, f, code: panelLib.codeExcerpt(dir, f.file, f.line, { radius: 25, maxChars: 4000 }) }));
    this.log('review', 'info', `Doğrulayıcı (${agents.ADAPTERS[rid].label}) ${findings.length} bulguyu kodda tek tek kontrol ediyor…`);
    const out = await this.reviewSession(P.panelVerifyPrompt({ items, lang: this.userLang(), decisive }), { schema: P.PANEL_VERIFY_SCHEMA, agentId: rid, label: 'bulgu doğrulama', timeoutMin: 15, what: 'Bulgu doğrulama', valid: (o) => (o?.results || []).length > 0 });
    if (!out) {
      this.log('review', 'warn', 'Bulgular doğrulanamadı; yalnızca kritik/yüksek olanlar dikkate alınıyor.');
      return findings.map((f) => ({ ...f, verdict: SEVERE.has(f.severity) ? 'confirmed' : 'uncertain', verifyNote: 'doğrulanamadı' }));
    }
    const byIndex = new Map(out.results.map((x) => [Number(x.index), x]));
    return findings.map((f, i) => ({ ...f, verdict: byIndex.get(i)?.verdict || 'uncertain', verifyNote: byIndex.get(i)?.reason || '' }));
  }

  // Düzeltme turundan sonra hedefli yeniden doğrulamaya girecek maddeler: engelleyici sorunlar,
  // "eksik" bulunan gereksinimler ve inceleyicinin çalıştırıp başarısız bulduğu komutlar.
  deepBlocking(deep) {
    const issues = (deep?.issues || []).filter((i) => i.blocking || ['critical', 'high'].includes(i.severity));
    const missing = (deep?.requirementChecks || [])
      .filter((c) => c?.id && c.status === 'missing')
      .map((c) => ({ severity: 'high', blocking: true, title: `Requirement ${c.id} not implemented`, detail: c.evidence || 'reported as missing', fix: 'implement the requirement and test it' }));
    const failed = (deep?.testsRun || [])
      .filter((t) => t?.result === 'fail')
      .map((t) => ({ severity: 'high', blocking: true, title: `Command failed: ${t.command}`, detail: t.note || 'the reviewer ran it and it failed', fix: 'make the command pass' }));
    return [...issues, ...missing, ...failed];
  }

  // Claude'un engelleyici bulgularını yönetici incelemesine katar; gereksinim kararlarında Claude'u esas alır.
  mergeDeep(review, deep) {
    if (!deep) return review;
    const blocking = (deep.issues || []).filter((i) => i.blocking || ['critical', 'high'].includes(i.severity));
    for (const i of blocking) review.issues.push(`Claude [${i.severity}]: ${i.title}${i.file ? ` (${i.file})` : ''}`);
    for (const i of (deep.issues || []).filter((x) => !blocking.includes(x))) review.suggestions.push(`Claude [${i.severity}]: ${i.title}`);
    // Kodu gezip testleri çalıştıran inceleyicinin "eksik" dediği gereksinim ve kendi çalıştırdığı başarısız test,
    // genel kararı "onay" olsa bile engelleyicidir.
    const missing = (deep.requirementChecks || []).filter((c) => c?.id && c.status === 'missing');
    for (const c of missing) review.issues.push(`Claude: gereksinim karşılanmadı: ${c.id}${c.evidence ? ` — ${String(c.evidence).slice(0, 200)}` : ''}`);
    const failedRuns = (deep.testsRun || []).filter((t) => t?.result === 'fail');
    for (const t of failedRuns) review.issues.push(`Claude: inceleyicinin çalıştırdığı komut başarısız: ${t.command}${t.note ? ` — ${String(t.note).slice(0, 160)}` : ''}`);
    const mustFix = blocking.length || missing.length || failedRuns.length;
    if (mustFix || deep.verdict === 'fix') {
      review.verdict = 'fix';
      const lines = [
        ...blocking.map((i) => `- [${i.severity}] ${i.title}${i.file ? ` in ${i.file}` : ''}: ${i.detail} — fix: ${i.fix}`),
        ...missing.map((c) => `- Requirement ${c.id} is not implemented${c.evidence ? `: ${c.evidence}` : ''} — implement it completely and cover it with a test.`),
        ...failedRuns.map((t) => `- The reviewer ran \`${t.command}\` and it failed${t.note ? `: ${t.note}` : ''} — make it pass.`),
      ];
      review.fixInstructions = `${review.fixInstructions ? `${review.fixInstructions}\n\n` : ''}Independent deep review (another senior engineer explored the repository and ran the checks):\n${lines.join('\n') || '- see the review summary'}`;
    }
    review.deep = { verdict: mustFix ? 'fix' : deep.verdict, summary: deep.summary, issues: deep.issues || [], testsRun: deep.testsRun || [] };
    return review;
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
    if (checks.length || (review.requirementsMet || []).length) this.log(authoritative ? 'review' : 'manager', 'dim', `Gereksinim kapsamı: ${met}/${valid.size} karşılandı`);
  }

  normalizeReview(review, checks, extra = {}) {
    const r = {
      verdict: review?.verdict === 'pass' ? 'pass' : 'fix',
      summary: review?.summary || '',
      // Kopyalar: inceleme sonucuna eklenen maddeler modelin döndürdüğü nesneyi değiştirmez.
      issues: [...(review?.issues || [])].filter((i) => typeof i === 'string' && i.trim()),
      suggestions: [...(review?.suggestions || [])].filter((i) => typeof i === 'string' && i.trim()),
      qualityScore: clampScore(review?.qualityScore),
      fixInstructions: review?.fixInstructions || '',
      acceptanceChecks: (review?.acceptanceChecks || []).filter((c) => c?.criterion),
      requirementChecks: (review?.requirementChecks || []).filter((c) => c?.id),
      testQuality: review?.testQuality || '',
      // Yöneticinin değişikliği kırma denemeleri ve bulduğu kusurlar (bulgular kodda doğrulanmaya gider).
      riskAnalysis: (Array.isArray(review?.riskAnalysis) ? review.riskAnalysis : []).filter((x) => x?.scenario).slice(0, 40),
      findings: (Array.isArray(review?.findings) ? review.findings : [])
        .filter((f) => f?.title && (f.problem || f.scenario))
        .slice(0, 20)
        .map((f) => ({ ...f, severity: ['critical', 'high', 'medium', 'low'].includes(f.severity) ? f.severity : 'medium', problem: f.problem || f.scenario, scenario: f.scenario || '', fix: f.fix || '' })),
      scores: review?.scores && typeof review.scores === 'object' ? Object.fromEntries(P.SCORE_KEYS.filter((k) => clampScore(review.scores[k]) != null).map((k) => [k, clampScore(review.scores[k])])) : null,
    };
    // "Kırık" denip bulgu olarak yazılmayan senaryo da bulgudur (doğrulayıcı karar verir).
    // "where" serbest metindir ("src/a.ts:execute", "src/a.ts › run()"): içindeki dosya yolu alınır.
    const fileOf = (w) => (String(w || '').match(/[^\s:()`'"›>]+\.[A-Za-z0-9]{1,6}/) || [''])[0];
    for (const x of r.riskAnalysis.filter((y) => y.outcome === 'broken')) {
      const file = fileOf(x.where);
      if (file && r.findings.some((f) => fileOf(f.file) === file)) continue;
      r.findings.push({ severity: 'medium', title: String(x.scenario).slice(0, 140), file: file || String(x.where || ''), problem: x.evidence || x.scenario, scenario: x.scenario, fix: 'Handle this scenario at its root cause and cover it with a test.' });
    }
    // Genel puan, doğruluk ve sağlamlık puanlarının en düşüğünü aşamaz.
    if (r.qualityScore != null && r.scores) {
      const cap = Math.min(r.scores.correctness ?? 10, r.scores.robustness ?? 10);
      if (r.qualityScore > cap) r.qualityScore = cap;
    }
    // Kararı yalnızca kendi bulgularına dayanan "düzelt": bulgular doğrulanmazsa karar düşer (settleManager).
    r.findingsOnly = r.verdict === 'fix' && !r.issues.length && r.findings.some((f) => f.severity !== 'low');
    // Kanıtla "karşılanmadı" denen kabul kriteri varken onay verilemez.
    const missing = r.acceptanceChecks.filter((c) => c.status === 'missing');
    if (missing.length && r.verdict === 'pass') {
      r.verdict = 'fix';
      r.issues.push(...missing.map((c) => `Kabul kriteri karşılanmadı: ${c.criterion}`));
    }
    // Aynı kural gereksinimler için: inceleyici kapsamındaki bir gereksinimi "eksik" bulduysa onay veremez.
    const missingReqs = r.requirementChecks.filter((c) => c.status === 'missing');
    if (missingReqs.length && r.verdict === 'pass') {
      r.verdict = 'fix';
      r.issues.push(...missingReqs.map((c) => `Gereksinim karşılanmadı: ${c.id}${c.evidence ? ` — ${String(c.evidence).slice(0, 200)}` : ''}`));
    }
    const failed = (checks || []).filter((c) => !c.ok && !c.env);
    if (failed.length && r.verdict === 'pass') {
      r.verdict = 'fix';
      r.issues.push(...failed.map((c) => `Doğrulama başarısız: ${c.cmd}`));
    }
    // İnceleyicinin kendi çalıştırdığı komut başarısızsa (ajan incelemesi) onay verilemez.
    const failedRuns = (Array.isArray(review?.testsRun) ? review.testsRun : []).filter((t) => t?.result === 'fail' && t.command);
    if (failedRuns.length) {
      r.testsRun = review.testsRun;
      r.verdict = 'fix';
      r.issues.push(...failedRuns.map((t) => `İnceleyicinin çalıştırdığı komut başarısız: ${t.command}${t.note ? ` — ${String(t.note).slice(0, 160)}` : ''}`));
      r.fixInstructions = `${r.fixInstructions ? `${r.fixInstructions}\n\n` : ''}${failedRuns.map((t) => `- The reviewer ran \`${t.command}\` and it failed${t.note ? `: ${t.note}` : ''} — make it pass.`).join('\n')}`;
    }
    if (extra.forceIssue) {
      r.verdict = 'fix';
      r.issues.push(extra.forceIssue);
    }
    // Nesnel kusurlar (ör. tarayıcı testinin sayfa denetimleri): inceleyicinin kararından bağımsız engeller.
    if (extra.forceIssues?.length) {
      r.verdict = 'fix';
      r.issues.push(...extra.forceIssues);
      r.fixInstructions = `${r.fixInstructions ? `${r.fixInstructions}\n\n` : ''}Objective defects found by the automated browser test (fix each at its cause):\n${extra.forceIssues.map((i) => `- ${i}`).join('\n')}`;
    }
    if (r.issues.length) r.findingsOnly = false;
    if (r.verdict === 'fix' && !r.fixInstructions.trim()) {
      r.fixInstructions = 'Fix every problem listed above and make all failing verification commands pass.';
    }
    return r;
  }

  // `src`: incelemeyi kimin yaptığı günlükte görünür ("manager" ya da ajan incelemesi için "review").
  logReview(review, label, src = 'manager') {
    const score = review.qualityScore ? ` · kalite ${review.qualityScore}/10` : '';
    this.log(src, review.verdict === 'pass' ? 'ok' : 'warn', `${label}: ${review.verdict === 'pass' ? 'ONAYLANDI' : 'DÜZELTME GEREKLİ'}${score} — ${review.summary}`);
    for (const i of review.issues) this.log(src, 'warn', `• ${i}`);
    const risks = review.riskAnalysis || [];
    if (risks.length) {
      const n = (o) => risks.filter((x) => x.outcome === o).length;
      this.log(src, n('broken') ? 'warn' : 'dim', `Kırma denemeleri: ${risks.length} senaryo — ${n('handled')} ele alınmış, ${n('broken')} kırık, ${n('untested')} testsiz${review.scores ? ` · puanlar: doğruluk ${review.scores.correctness ?? '-'}, sağlamlık ${review.scores.robustness ?? '-'}, test ${review.scores.tests ?? '-'}, bakım ${review.scores.maintainability ?? '-'}, arayüz ${review.scores.ux ?? '-'}` : ''}`);
      for (const x of risks.filter((y) => y.outcome === 'broken' || y.outcome === 'untested').slice(0, 6)) this.log(src, 'dim', `${x.outcome === 'broken' ? '✗ kırık' : '· testsiz'} [${x.area}] ${x.scenario}${x.where ? ` (${x.where})` : ''}`);
    }
    for (const sug of review.suggestions.slice(0, 5)) this.log(src, 'dim', `öneri: ${sug}`);
  }

  /**
   * Görevin ilk incelemesi, bağımsız bir ajan oturumuyla (yönetici rolü "manager" iken): kodu gezer, testleri kendisi
   * çalıştırır, değişikliği kırmayı dener. Dönen: REVIEW biçiminde nesne (+ testsRun) ya da sonuç alınamadıysa null.
   */
  async agentReview(task, { checks, changed, diff, tddNote, installed }) {
    const rid = this.reviewerId();
    if (!rid) return null;
    this.log('review', 'step', `${agents.ADAPTERS[rid].label} görevi bağımsız inceliyor: kodu geziyor, testleri çalıştırıyor, değişikliği kırmayı deniyor…`);
    const out = await this.reviewSession(P.taskReviewPrompt({ job: this.job, task, agentSummary: task.agentSummary, checks, changed, diffStat: diff?.stat, tddNote, installed, lang: this.userLang() }), {
      schema: P.AGENT_REVIEW_SCHEMA,
      agentId: rid,
      label: `inceleme · ${task.title}`,
      timeoutMin: 20,
      what: 'İnceleme',
      convert: true,
      valid: (o) => ['pass', 'fix'].includes(o?.verdict),
    });
    if (!out) return null;
    for (const t of (out.testsRun || []).slice(0, 8)) this.log('review', t.result === 'fail' ? 'warn' : 'dim', `test: ${t.command} → ${t.result}${t.note ? ` · ${t.note}` : ''}`);
    return out;
  }

  // Ajan incelemesi sonuç vermediğinde: yönetici hazırsa o inceler; yoksa karar yalnızca kontrollere dayanır.
  async reviewFallback(managerReview, checks) {
    if (settings.managerReady(this.cfg())) {
      this.log('manager', 'info', 'İncelemeyi yönetici yapıyor (yedek)…');
      try {
        return await managerReview();
      } catch (e) {
        this.checkAbort();
        this.log('manager', 'warn', `Yönetici incelemesi de yapılamadı: ${e.message}`);
      }
    }
    const failed = (checks || []).some((c) => !c.ok && !c.env);
    this.log('system', 'warn', 'Bağımsız inceleme yapılamadı; karar yalnızca doğrulama komutlarına dayanıyor.');
    return { verdict: failed ? 'fix' : 'pass', summary: 'Bağımsız inceleme yapılamadı; yalnızca doğrulama komutlarının sonucu değerlendirildi.', issues: [], suggestions: [], fixInstructions: '' };
  }

  // Derin incelemenin sonucundan yansız bir inceleme kaydı (engelleyiciler mergeDeep ile eklenir).
  neutralReview(deep) {
    return { verdict: 'pass', summary: deep?.summary || '', issues: [], suggestions: [], qualityScore: deep?.qualityScore ?? null, fixInstructions: '', acceptanceChecks: [], requirementChecks: [] };
  }
}

module.exports = Review;
