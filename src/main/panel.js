// Uzman denetim paneli yardımcıları (Electron'dan bağımsız, test edilebilir).
// Panel: güvenlik, iş mantığı / veri bütünlüğü ve mimari / test uzmanları (Claude) aynı kodu paralel inceler;
// ayrı bir Claude doğrulayıcı her bulguyu kodda kontrol eder, yalnızca doğrulananlar düzeltmeye gider.
const fs = require('fs');
const path = require('path');

const SEVERE = new Set(['critical', 'high']);

// "src/a.ts:52-80", "src/a.ts (line 12)", "a.ts, b.ts" gibi biçimlerden ilk dosya ve satır.
function parseFileRef(file, line) {
  const text = String(file || '').trim();
  const token = (text.split(/[\s,;]+/)[0] || '').replace(/[()`'"]/g, '');
  const m = token.match(/^(.*?)(?::(\d+)(?:[-–]\d+)?)?$/);
  const ln = Number(line) || Number(m?.[2]) || Number(text.match(/line\s+(\d+)/i)?.[1]) || 0;
  return { file: (m ? m[1] : token).replace(/^\.?\/+/, ''), line: ln };
}

// Bulgunun gösterdiği yerdeki kod (satır numaralı). Proje dışına çıkılamaz.
function codeExcerpt(dir, file, line, { radius = 40, maxChars = 7000 } = {}) {
  const ref = parseFileRef(file, line);
  if (!ref.file) return '(no file given)';
  const root = path.resolve(dir);
  const full = path.resolve(root, ref.file);
  if (!full.startsWith(root + path.sep)) return '(outside the project)';
  let text;
  try {
    text = fs.readFileSync(full, 'utf8');
  } catch {
    return '(file not found)';
  }
  const lines = text.split('\n');
  const from = ref.line ? Math.max(1, ref.line - radius) : 1;
  const to = ref.line ? Math.min(lines.length, ref.line + radius) : Math.min(lines.length, 140);
  let out = lines
    .slice(from - 1, to)
    .map((l, i) => `${String(from + i).padStart(4)}  ${l}`)
    .join('\n');
  if (out.length > maxChars) out = `${out.slice(0, maxChars)}\n…`;
  return out;
}

const where = (f) => `${f.file || '?'}${f.line ? `:${f.line}` : ''}`;
const fmt = (f) => `- [${f.severity}] ${f.title} (${where(f)}): ${f.problem} Failure: ${f.scenario} Fix: ${f.fix}`;

/**
 * Doğrulanmış bulguları incelemeye katar. Doğrulanmış orta ve üstü her bulgu düzeltme turu açar: kusur yazıldığı
 * yerde, bağlam tazeyken düzeltilir (sonraki görevlere devredilmez). Düşük bulgular öneri olarak kalır.
 */
function mergePanel(review, panel, { labels = {} } = {}) {
  if (!panel) return review;
  const confirmed = panel.confirmed || [];
  const block = confirmed.filter((f) => f.severity !== 'low');
  const rest = confirmed.filter((f) => !block.includes(f));
  const label = (f) => labels[f.area] || f.area || 'uzman';
  review.issues = review.issues || [];
  review.suggestions = review.suggestions || [];
  for (const f of block) review.issues.push(`Uzman · ${label(f)} [${f.severity}]: ${f.title} (${where(f)})`);
  for (const f of rest) review.suggestions.push(`Uzman · ${label(f)} [${f.severity}]: ${f.title} (${where(f)})`);
  if (block.length) {
    review.verdict = 'fix';
    review.fixInstructions = `${review.fixInstructions ? `${review.fixInstructions}\n\n` : ''}Independent specialist review panel — findings verified against the code (fix the root cause of each):\n${block.map(fmt).join('\n')}${rest.length ? `\n\nAlso fix in this round (verified, lower severity):\n${rest.map(fmt).join('\n')}` : ''}`;
  }
  review.panel = {
    blocking: block.length,
    confirmed,
    uncertain: panel.uncertain || [],
    rejected: (panel.rejected || []).length,
    summaries: panel.summaries || [],
  };
  return review;
}

// ---------- Bulgu defteri ----------
// Doğrulanmış her orta+ bulgu kapanana (kodda yeniden doğrulanıp "düzeldi" denene) kadar işte izlenir.
// Hafıza/devreden not adımı bunları düşüremez; faz kapısı ve son kabul açık bulguyla geçilemez.
const fkey = (f) => `${String(f.file || '').toLowerCase().replace(/:\d+.*$/, '')}|${String(f.title || '').toLowerCase().replace(/\s+/g, ' ').trim()}`;
const CLOSED = new Set(['fixed', 'rejected']);

/** Bulguları deftere ekler (aynı dosya + başlık zaten açıksa yinelemez). Eklenen kayıtları döner. */
function ledgerAdd(ledger, findings, { at, label, status = 'open', now = Date.now() } = {}) {
  const added = [];
  for (const f of findings || []) {
    if (!f?.title) continue;
    const existing = ledger.find((x) => fkey(x) === fkey(f) && !CLOSED.has(x.status));
    if (existing) {
      // Belirsiz kalan bulgu sonradan doğrulandıysa açık sayılır; yeniden görülme sayısı tutulur.
      if (status === 'open' && existing.status === 'uncertain') existing.status = 'open';
      existing.seen = (existing.seen || 1) + 1;
      continue;
    }
    const n = ledger.reduce((m, x) => Math.max(m, Number(String(x.id).replace(/\D/g, '')) || 0), 0) + 1;
    const ref = parseFileRef(f.file, f.line);
    const item = {
      id: `F${n}`,
      at,
      label: label || at || '',
      area: f.area || '',
      severity: f.severity || 'medium',
      title: String(f.title),
      file: ref.file,
      line: ref.line,
      problem: f.problem || f.detail || '',
      scenario: f.scenario || '',
      fix: f.fix || '',
      status,
      note: f.verifyNote || '',
      openedAt: now,
    };
    ledger.push(item);
    added.push(item);
  }
  return added;
}

const ledgerOpen = (ledger, statuses = ['open']) => (ledger || []).filter((x) => statuses.includes(x.status));

/**
 * Yeniden doğrulama sonuçlarını deftere işler. results: [{ id, verdict: 'fixed' | 'still_present' | 'uncertain', reason }]
 * Sonuç gelmeyen kayıt olduğu gibi kalır. Dönen: { fixed, still, uncertain } (defter kayıtları).
 */
function ledgerApply(ledger, results, { now = Date.now() } = {}) {
  const out = { fixed: [], still: [], uncertain: [] };
  const byId = new Map((results || []).map((r) => [String(r.id), r]));
  for (const item of ledger || []) {
    const r = byId.get(item.id);
    if (!r) continue;
    item.note = r.reason || item.note || '';
    item.checkedAt = now;
    if (r.verdict === 'fixed') {
      item.status = 'fixed';
      item.closedAt = now;
      out.fixed.push(item);
    } else if (r.verdict === 'still_present') {
      item.status = 'open';
      item.rounds = (item.rounds || 0) + 1;
      out.still.push(item);
    } else {
      out.uncertain.push(item);
    }
  }
  return out;
}

const fmtOpen = (f) => `- [${f.severity}] ${f.id} ${f.title} (${where(f)}): ${f.problem}${f.scenario ? ` Failure: ${f.scenario}` : ''}${f.fix ? ` Fix: ${f.fix}` : ''}${f.note ? ` Verifier's note on the current code: ${f.note}` : ''}`;

/**
 * Hâlâ açık (yeniden doğrulamada "duruyor" denen) bulguları incelemeye engelleyici olarak katar.
 * review.openFindings: bu turda açık kalan kayıtların kimlikleri (arayüz ve karar için).
 */
function mergeOpenFindings(review, still, { labels = {} } = {}) {
  const items = (still || []).filter((f) => f.severity !== 'low');
  review.openFindings = items.map((f) => f.id);
  if (!items.length) return review;
  review.issues = review.issues || [];
  const label = (f) => labels[f.area] || f.area || 'uzman';
  for (const f of items) review.issues.push(`Açık bulgu ${f.id} · ${label(f)} [${f.severity}]: ${f.title} (${where(f)})${f.rounds ? ' — düzeltme sonrası hâlâ duruyor' : ''}`);
  review.verdict = 'fix';
  review.fixInstructions = `${review.fixInstructions ? `${review.fixInstructions}\n\n` : ''}Verified defects that are STILL OPEN (an independent verifier re-read the current code; fix the root cause of each and cover it with a test — a partial fix is not accepted):\n${items.map(fmtOpen).join('\n')}`;
  return review;
}

// Raporda ve arayüzde: kapanan / açık / doğrulanamayan bulgu sayıları.
function ledgerStats(ledger) {
  const l = ledger || [];
  return {
    total: l.length,
    fixed: l.filter((x) => x.status === 'fixed').length,
    open: l.filter((x) => x.status === 'open').length,
    uncertain: l.filter((x) => x.status === 'uncertain').length,
    rejected: l.filter((x) => x.status === 'rejected').length,
  };
}

module.exports = { parseFileRef, codeExcerpt, mergePanel, ledgerAdd, ledgerOpen, ledgerApply, mergeOpenFindings, ledgerStats, SEVERE };
