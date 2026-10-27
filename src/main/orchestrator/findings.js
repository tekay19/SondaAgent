// Bulgu defteri: doğrulanmış bulguların kaydı, düzeltme sonrası yeniden doğrulanması ve incelemeye katılması.
// (Orchestrator sınıfının yöntemleri; bkz. index.js — `this` orkestratördür.)
const agents = require('../agents');
const panelLib = require('../panel');
const P = require('../prompts');
const { PANEL_LABELS } = require('./shared');

class Findings {
  // ---------- bulgu defteri ----------
  // Doğrulanmış her orta+ bulgu işte izlenir; kodda yeniden doğrulanıp "düzeldi" denene kadar açık kalır.
  ledger() {
    if (!Array.isArray(this.job.findings)) this.job.findings = [];
    return this.job.findings;
  }

  recordFindings(panel, at, label) {
    if (!panel) return [];
    const added = panelLib.ledgerAdd(this.ledger(), (panel.confirmed || []).filter((f) => f.severity !== 'low'), { at, label });
    panelLib.ledgerAdd(this.ledger(), (panel.uncertain || []).filter((f) => f.severity !== 'low'), { at, label, status: 'uncertain' });
    return added;
  }

  // Düzeltme turundan sonra (ve her kapıda): açık bulgular GÜNCEL kodda yeniden doğrulanır.
  // Dönen: { fixed, still, uncertain } ya da doğrulayıcı çalışamadıysa null (kayıtlar açık kalır).
  async recheckFindings(items, where) {
    const rid = this.reviewerId();
    if (!rid || !items.length) return null;
    const dir = this.job.projectDir;
    const total = { fixed: [], still: [], uncertain: [] };
    this.log('review', 'info', `Doğrulayıcı (${agents.ADAPTERS[rid].label}) ${items.length} açık bulgunun düzelip düzelmediğini güncel kodda kontrol ediyor (${where})…`);
    try {
      for (let i = 0; i < items.length; i += 15) {
        const payload = items.slice(i, i + 15).map((f) => ({ f, code: panelLib.codeExcerpt(dir, f.file, f.line, { radius: 30, maxChars: 4500 }) }));
        const out = await this.reviewSession(P.findingRecheckPrompt({ items: payload, lang: this.userLang() }), { schema: P.FINDING_RECHECK_SCHEMA, agentId: rid, label: 'bulgu yeniden doğrulama', timeoutMin: 15, what: 'Bulgu yeniden doğrulama', valid: (o) => Array.isArray(o?.results) && o.results.length > 0 });
        if (!out) throw new Error('sonuç alınamadı');
        const r = panelLib.ledgerApply(this.ledger(), out.results);
        for (const k of Object.keys(total)) total[k].push(...r[k]);
      }
    } catch (e) {
      this.checkAbort();
      this.log('review', 'warn', `Açık bulgular yeniden doğrulanamadı (${e.message}); defterde açık kalıyor, sonraki denetimde tekrar bakılacak.`);
      return total.fixed.length || total.still.length ? total : null;
    }
    this.log('review', total.still.length ? 'warn' : 'ok', `Yeniden doğrulama: ${total.fixed.length} bulgu düzeldi${total.still.length ? `, ${total.still.length} hâlâ duruyor` : ''}${total.uncertain.length ? `, ${total.uncertain.length} belirsiz` : ''}.`);
    for (const f of total.still.slice(0, 8)) this.log('review', 'warn', `✗ ${f.id} [${f.severity}] ${f.title}${f.note ? ` — ${f.note}` : ''}`);
    this.update();
    return total;
  }

  // Son kabulde: daha önce "belirsiz" kalan bulgular kararlı biçimde yeniden değerlendirilir (ya açık ya yanlış alarm).
  async settleUncertain() {
    const rid = this.reviewerId();
    const items = panelLib.ledgerOpen(this.ledger(), ['uncertain']).filter((f) => f.severity !== 'low').slice(0, 15);
    if (!rid || !items.length) return;
    this.log('review', 'info', `Belirsiz kalan ${items.length} bulgu kararlı biçimde yeniden doğrulanıyor…`);
    const verified = await this.verifyPanelFindings(items, rid, { decisive: true });
    let opened = 0;
    for (const v of verified) {
      const item = this.ledger().find((x) => x.id === v.id);
      if (!item || v.verifyNote === 'doğrulanamadı') continue;
      if (v.verdict === 'confirmed') {
        item.status = 'open';
        opened++;
      } else if (v.verdict === 'rejected') {
        item.status = 'rejected';
        item.closedAt = Date.now();
      }
      item.note = v.verifyNote || item.note;
    }
    this.log('review', opened ? 'warn' : 'ok', `Belirsiz bulgular: ${opened} doğrulandı (açık), ${verified.filter((v) => v.verdict === 'rejected').length} yanlış alarm, ${verified.filter((v) => v.verdict === 'uncertain').length} hâlâ belirsiz (raporda listelenecek).`);
    this.update();
  }

  // Yöneticinin bulguları: uzman bulguları gibi kodda doğrulanmaya gider.
  managerFindings(review) {
    return (review.findings || []).filter((f) => f.severity !== 'low').slice(0, 15).map((f) => ({ ...f, area: 'manager', ...panelLib.parseFileRef(f.file, f.line) }));
  }

  // Doğrulanmış yönetici bulgularını panel sonucuyla birleştirir.
  joinPanel(pnl, verified) {
    if (!verified?.length) return pnl;
    const base = pnl || { confirmed: [], uncertain: [], rejected: [], low: [], summaries: [] };
    const by = (v) => verified.filter((x) => x.verdict === v);
    return { ...base, confirmed: [...(base.confirmed || []), ...by('confirmed')], uncertain: [...(base.uncertain || []), ...by('uncertain')], rejected: [...(Array.isArray(base.rejected) ? base.rejected : []), ...by('rejected')] };
  }

  /**
   * Yönetici bulgularının akıbeti. Doğrulayıcı yoksa (standart inceleme) orta+ bulgular doğrudan engelleyicidir.
   * Doğrulayıcı varsa yalnızca doğrulananlar (panel birleştirmesiyle) engeller; kararı yalnızca kendi bulgularına
   * dayanan "düzelt", bulguların hiçbiri doğrulanmadıysa düşer — yanlış alarm ajanın zamanını yemez.
   */
  settleManager(review, panel, mf, canVerify) {
    if (!mf.length) return review;
    if (!canVerify) {
      for (const f of mf) review.issues.push(`İnceleme [${f.severity}]: ${f.title} (${f.file || '?'})`);
      review.verdict = 'fix';
      review.fixInstructions = `${review.fixInstructions ? `${review.fixInstructions}\n\n` : ''}Defects reported by the first-pass review:\n${mf.map((f) => `- [${f.severity}] ${f.title} (${f.file || '?'}${f.line ? `:${f.line}` : ''}): ${f.problem} Failure: ${f.scenario} Fix: ${f.fix}`).join('\n')}`;
      return review;
    }
    const mine = (list) => (Array.isArray(list) ? list : []).filter((f) => f.area === 'manager');
    const confirmed = mine(panel?.confirmed);
    this.log('review', confirmed.length ? 'warn' : 'info', `İlk incelemenin bulguları kodda doğrulandı: ${mf.length} bulgudan ${confirmed.length} gerçek${mine(panel?.rejected).length ? `, ${mine(panel.rejected).length} yanlış alarm` : ''}${mine(panel?.uncertain).length ? `, ${mine(panel.uncertain).length} belirsiz` : ''}.`);
    const rejected = mine(panel?.rejected);
    if (review.findingsOnly) {
      // Talimata yalnızca doğrulanan bulgular girer (panel birleştirmesi ekler); hiçbiri doğrulanmadıysa karar düşer.
      review.fixInstructions = '';
      if (!confirmed.length) review.verdict = 'pass';
    } else if (rejected.length && review.verdict === 'fix') {
      review.fixInstructions = `${review.fixInstructions}\n\nThese claims of the first-pass review were checked against the code by an independent verifier and DISPROVED — do not act on them: ${rejected.map((f) => `"${f.title}"`).join('; ')}.`;
    }
    return review;
  }

  /**
   * Bir inceleme turunun sonucunu birleştirir (faz kapısı ve son kabul): ilk incelemenin bulguları kodda doğrulanır,
   * güvenlik denetimi ve derin inceleme eklenir, doğrulanmış bulgular deftere yazılıp engelleyici olur, defterde
   * hâlâ açık olanlar (`recheck.still`) eklenir. `keepPrev`: düzeltme turunda önceki panel özeti korunur.
   */
  async settleRound({ raw, checks, extra = {}, security = [], deep = null, panel = null, recheck = null, openBefore = [], at, label, canVerify, prevPanel = null, keepPrev = false }) {
    let review = this.normalizeReview(raw, checks, extra);
    const mf = this.managerFindings(review);
    const rid = canVerify ? this.reviewerId() : null;
    const joined = this.joinPanel(panel, mf.length && rid ? await this.withCleanTree(() => this.verifyPanelFindings(mf, rid)) : null);
    review = this.settleManager(review, joined, mf, !!rid);
    review = this.mergeDeep(this.mergeSecurity(review, security), deep);
    if (joined) {
      this.recordFindings(joined, at, label);
      review = this.calibrateScore(panelLib.mergePanel(review, joined, { labels: PANEL_LABELS }));
    }
    if (review.scoreNote) this.log('review', 'info', review.scoreNote);
    if (keepPrev || !review.panel) review.panel = this.keepPanel(review.panel, prevPanel);
    // Turun başında açık olup doğrulayıcının karara bağlayamadığı kayıtlar (oturum düştü, yalnızca bir kısmı bitti) de
    // "hâlâ duruyor" sayılır: defter kapanmadan faz kapısı ve son kabul geçilmez. (Sonuçlanan kayıtların durumu
    // yeniden doğrulamada defterde güncellenir; "open" kalanlar ya hâlâ duruyor ya da hiç kontrol edilemedi.)
    const still = recheck?.still || [];
    const stillIds = new Set(still.map((f) => f.id));
    const unchecked = openBefore.filter((f) => f.status === 'open' && f.severity !== 'low' && !stillIds.has(f.id));
    if (recheck || unchecked.length) review = panelLib.mergeOpenFindings(review, [...still, ...unchecked], { labels: PANEL_LABELS });
    return review;
  }

  // Düzeltme turlarında panel yeniden çalışmaz: önceki turun özeti ve bulguları arayüzde kalır.
  keepPanel(cur, prev) {
    if (!prev) return cur;
    if (!cur) return { ...prev, blocking: 0 };
    const key = (f) => `${f.file}|${f.title}`;
    const seen = new Set((cur.confirmed || []).map(key));
    return { ...prev, ...cur, confirmed: [...(cur.confirmed || []), ...(prev.confirmed || []).filter((f) => !seen.has(key(f)))], summaries: cur.summaries?.length ? cur.summaries : prev.summaries || [] };
  }

  // Tarayıcı testinin nesnel sayfa kusurları (kırık görsel/bağlantı, başarısız istek, mobilde taşma…) engelleyicidir.
  smokeIssues(smoke) {
    return (smoke?.problems || []).filter((x) => x.level === 'error').slice(0, 20).map((x) => `Tarayıcı testi · ${x.route}${x.viewport ? ` (${x.viewport})` : ''}: ${x.text}`);
  }
}

module.exports = Findings;
