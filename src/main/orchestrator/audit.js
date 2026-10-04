// Bağımsız denetim ("Claude önerileri"): görev incelemeleri her görevin farkını tek başına görür. Belirli aralıklarla
// ayrı bir Claude oturumu bitmiş kodun tamamını ve planın kalan görevlerini birlikte okur: sonraki görevlerin dayanacağı
// temellerdeki eksikler, sessizce hiç çalışmayan testler, görev sınırlarına düşen kusurlar. Öneriler bağımsız
// doğrulayıcıdan geçer; doğrulananlar bulgu defterine yazılır ve sonraki görev başlamadan bir düzeltme oturumu uygular.
// Ardından kontroller (kırıldıysa aynı oturumda onarım), hafıza, commit ve hedefli yeniden doğrulama gelir; kapanmayan
// öneri defterde açık kalır ve faz kapısı / son kabul o kapanmadan geçilmez.
// (Orchestrator sınıfının yöntemleri; bkz. index.js — `this` orkestratördür.)
const agents = require('../agents');
const project = require('../project');
const verify = require('../verify');
const panelLib = require('../panel');
const { briefModelOf, claudeModelLabel } = require('../models');
const P = require('../prompts');
const { SEVERE } = require('./shared');

const AUDIT_UPCOMING = 14; // denetçiye gösterilen en fazla kalan görev
const AUDIT_MAX = 10; // denetimden alınan en fazla öneri
const KINDS = new Set(['readiness', 'test-gap', 'defect']);
const SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);

class Audit {
  /**
   * Denetim zamanı mı? Bu çalıştırmada biten görevden sonra; son denetimden beri `auditEvery` görev bittiyse ve en az
   * bir görev kaldıysa (son görevden sonra son kabul zaten tüm projeyi denetler). Standart inceleme seviyesinde,
   * git yokken ya da inceleyecek ajan yokken çalışmaz.
   */
  auditDue(index, s) {
    const job = this.job;
    if (s.independentAudit === false || s.reviewLevel === 'standard' || !this.useGit || !this.reviewerId()) return false;
    if (!this.auditUpcoming(index).length) return false;
    const last = (job.audits || []).filter((a) => a.status === 'done').at(-1);
    const lastIdx = last ? job.tasks.findIndex((t) => t.id === last.afterTask) : -1;
    return index - lastIdx >= Math.max(1, s.auditEvery || 3);
  }

  // Uygulama kapanınca yarıda kalan denetim, sürdürmede aynı yerden yeniden yapılır.
  auditInterrupted(task) {
    return (this.job.audits || []).some((a) => a.afterTask === task.id && a.status !== 'done');
  }

  auditUpcoming(index) {
    return this.job.tasks.slice(index + 1).filter((t) => t.status !== 'done' && t.status !== 'skipped');
  }

  async runAudit(index, s) {
    const job = this.job;
    const dir = job.projectDir;
    const after = job.tasks[index];
    const rid = this.reviewerId();
    const audits = (job.audits = job.audits || []);
    const prev = audits.findIndex((a) => a.afterTask === after.id && a.status !== 'done');
    const rec = { n: prev >= 0 ? audits[prev].n : audits.length + 1, afterTask: after.id, startedAt: Date.now(), status: 'running', summary: '', suggestions: [], strengths: [] };
    if (prev >= 0) audits[prev] = rec;
    else audits.push(rec);
    const upcoming = this.auditUpcoming(index).slice(0, AUDIT_UPCOMING);
    // En derin okuma: brifleri yazan model (varsayılan Claude Fable 5.1). Claude yoksa inceleyici ajan.
    const model = rid === 'claude' ? briefModelOf(s) : null;
    const who = model ? `Claude ${claudeModelLabel(model)}` : agents.ADAPTERS[rid].label;
    const label = `bağımsız denetim ${rec.n}`;
    this.update({ phase: 'reviewing', currentTaskId: null });
    this.log('review', 'step', `Bağımsız denetim ${rec.n} (${who}): bitmiş kodun tamamı ve kalan ${upcoming.length} görev birlikte inceleniyor — sonraki görevlerin dayanacağı temeller, sessizce çalışmayan testler, görev sınırlarındaki kusurlar.`);

    let out = null;
    try {
      const res = await this.withCleanTree(() => this.runAgent(P.auditPrompt({ job, upcoming, lang: this.userLang() }), { mode: 'review', schema: P.AUDIT_SCHEMA, agentId: rid, model: model || undefined, label, src: 'review', timeoutMin: 30, effort: 'high', quiet: true }));
      out = res.structured || agents.jsonFromText(res.transcript || res.text);
    } catch (e) {
      this.checkAbort();
      if (agents.AUTH_ERROR.test(e.message)) throw e;
      this.log('review', 'warn', `Bağımsız denetim yapılamadı: ${e.message}`);
    }
    if (!Array.isArray(out?.suggestions)) {
      // Denetim sonuç vermediyse iş durmaz; bir sonraki denetim yine `auditEvery` görev sonra gelir.
      Object.assign(rec, { status: 'done', error: 'sonuç alınamadı', finishedAt: Date.now() });
      if (out) this.log('review', 'warn', 'Bağımsız denetim sonuç vermedi; yapım sürüyor.');
      this.update({ phase: 'running' });
      return rec;
    }

    const ids = new Set(upcoming.map((t) => t.id));
    const suggestions = out.suggestions
      .filter((x) => x?.title && SEVERITIES.has(x.severity))
      .slice(0, AUDIT_MAX)
      .map((x) => ({ ...x, kind: KINDS.has(x.kind) ? x.kind : 'defect', before: ids.has(x.before) ? x.before : '', area: 'audit', ...panelLib.parseFileRef(x.file, x.line) }));
    rec.summary = String(out.summary || '');
    rec.strengths = (out.strengths || []).filter((x) => typeof x === 'string').slice(0, 5);
    const toVerify = suggestions.filter((x) => x.severity !== 'low');
    const verified = toVerify.length ? await this.withCleanTree(() => this.verifyPanelFindings(toVerify, rid)) : [];
    rec.suggestions = [...verified, ...suggestions.filter((x) => x.severity === 'low').map((x) => ({ ...x, verdict: 'low' }))];

    // Doğrulananlar deftere: açık kalan her öneri faz kapısını ve son kabulü engeller. Belirsizler son kabulde
    // kararlı biçimde yeniden değerlendirilir. Defterde zaten açık olan bir kusur yeniden kaydedilmez.
    const ledger = this.ledger();
    const at = `audit:${rec.n}`;
    const items = [];
    for (const f of rec.suggestions) {
      if (f.verdict !== 'confirmed' && f.verdict !== 'uncertain') continue;
      const [item] = panelLib.ledgerAdd(ledger, [f], { at, label, status: f.verdict === 'confirmed' ? 'open' : 'uncertain' });
      if (!item) {
        f.known = true;
        continue;
      }
      f.ledgerId = item.id;
      if (f.verdict === 'confirmed') items.push({ ...item, kind: f.kind, before: f.before });
    }
    const n = (v) => rec.suggestions.filter((x) => x.verdict === v).length;
    const tally = `${suggestions.length} öneri — ${n('confirmed')} doğrulandı${n('rejected') ? `, ${n('rejected')} yanlış alarm elendi` : ''}${n('uncertain') ? `, ${n('uncertain')} belirsiz` : ''}${n('low') ? `, ${n('low')} düşük öncelik` : ''}`;
    this.log('review', items.length ? 'warn' : 'ok', `Bağımsız denetim ${rec.n}: ${suggestions.length ? tally : 'temeller sağlam, öneri yok'}.${rec.summary ? ` ${rec.summary}` : ''}`);
    for (const f of items) this.log('review', SEVERE.has(f.severity) ? 'warn' : 'dim', `✓ ${f.id} [${f.severity}] ${f.title} (${f.file || '?'}${f.line ? `:${f.line}` : ''})${f.before ? ` · ${f.before} öncesi` : ''}`);
    if (!items.length) {
      Object.assign(rec, { status: 'done', finishedAt: Date.now() });
      this.update({ phase: 'running' });
      return rec;
    }

    // Uygulama: sonraki görevden önce ayrı bir kodlama oturumu. Akışı bozmama güvencesi: önce kontrollerin durumu
    // kaydedilir; düzeltme daha önce geçen bir kontrolü bozarsa aynı oturumda bir onarım turu yapılır, o da yetmezse
    // düzeltme tamamen geri alınır (proje denetimden önceki haline döner) ve öneriler defterde açık kalır.
    // Önceden zaten kırık olan kontroller denetimin suçu sayılmaz.
    const base = await project.headCommit(dir);
    const tree = project.fileTree(dir, { maxEntries: 300, maxDepth: 5 });
    const runChecks = () => this.checksOnline(() => verify.runChecks({ dir, log: (l) => this.log('test', l.lvl, l.text), signal: this.signal }));
    const failing = (cs) => cs.filter((c) => !c.ok && !c.env).map((c) => c.cmd || c.name);
    const canRevert = this.useGit && (await project.isClean(dir));
    let before = [];
    if (canRevert) {
      this.update({ phase: 'verifying' });
      this.log('test', 'dim', 'Denetim düzeltmelerinden önce kontrollerin durumu kaydediliyor (düzeltme bir şeyi bozarsa geri alınabilsin diye)…');
      before = failing(await runChecks());
    }
    const broken = (cs) => failing(cs).filter((k) => !before.includes(k));
    this.update({ phase: 'fixing' });
    this.log('system', 'step', `Bağımsız denetim ${rec.n}: ${items.length} doğrulanmış öneri sonraki görevden önce uygulanıyor…`);
    let fix = await this.runAgent(P.auditFixPrompt({ job, items, standards: s.standards, fileTree: tree }), { label: `denetim düzeltmeleri ${rec.n}` });
    this.update({ phase: 'verifying' });
    let checks = await runChecks();
    if (broken(checks).length) {
      this.log('system', 'warn', `Denetim düzeltmelerinden sonra kontroller başarısız (${broken(checks).join(', ')}); ${agents.ADAPTERS[job.agent].label} onarıyor.`);
      const resumed = !!(agents.ADAPTERS[job.agent].supportsResume && fix.sessionId);
      this.update({ phase: 'fixing' });
      fix = await this.runAgent(resumed ? P.auditRepairPrompt(checks) : `${P.auditFixPrompt({ job, items, standards: s.standards, fileTree: tree })}\n\n${P.auditRepairPrompt(checks)}`, { resumeId: resumed ? fix.sessionId : null, label: `denetim onarımı ${rec.n}` });
      this.update({ phase: 'verifying' });
      checks = await runChecks();
    }
    const stillBroken = broken(checks);
    rec.checksOk = !stillBroken.length;
    if (stillBroken.length && canRevert) {
      await project.discardChanges(dir);
      Object.assign(rec, { status: 'done', reverted: true, finishedAt: Date.now(), still: items.map((f) => f.id) });
      this.log('system', 'warn', `Bağımsız denetim ${rec.n}: düzeltmeler ${stillBroken.join(', ')} kontrolünü bozdu ve onarılamadı; değişiklikler geri alındı, proje denetimden önceki haline döndü. ${items.length} öneri bulgu defterinde açık kalıyor (sonraki görevlere ve faz kapısına gider).`);
      this.update({ phase: 'running' });
      return rec;
    }
    if (stillBroken.length) this.log('system', 'warn', `Bağımsız denetim ${rec.n}: kontroller onarımdan sonra da başarısız; sonraki görevin doğrulaması bunu yakalayacak.`);
    rec.agentSummary = fix.text || '';
    await this.remember({ title: `Independent audit ${rec.n} fixes`, details: items.map((f) => `${f.id} ${f.title}`).join('; '), status: 'done', agentSummary: fix.text, baseCommit: base, attempts: 0 }, `Bağımsız denetim ${rec.n} — doğrulanmış önerilerin uygulanması`);
    if (this.useGit) {
      const hash = await this.commit(dir, `sonda: bağımsız denetim ${rec.n} düzeltmeleri`, at);
      if (hash) rec.commit = hash;
    }

    // Uygulandı mı? Doğrulayıcı her öneriyi güncel kodda yeniden kontrol eder; "düzeldi" kanıtsız denmez.
    this.update({ phase: 'reviewing' });
    const live = items.map((f) => ledger.find((x) => x.id === f.id)).filter(Boolean);
    const recheck = await this.withCleanTree(() => this.recheckFindings(live, label));
    rec.fixed = (recheck?.fixed || []).map((f) => f.id);
    rec.still = (recheck?.still || []).map((f) => f.id);
    Object.assign(rec, { status: 'done', finishedAt: Date.now() });
    const open = live.filter((f) => f.status === 'open').length;
    this.log('system', open ? 'warn' : 'ok', `Bağımsız denetim ${rec.n} tamam: ${rec.fixed.length}/${items.length} öneri uygulandı ve doğrulandı${open ? `; ${open} öneri açık kaldı — bulgu defterinde izleniyor, faz kapısı bunlar kapanmadan geçilmez` : ''}.`);
    this.update({ phase: 'running' });
    return rec;
  }
}

module.exports = Audit;
