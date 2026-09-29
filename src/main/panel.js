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
 * Panelin doğrulanmış bulgularını incelemeye katar.
 * - kritik/yüksek (son kabulde orta da) → düzeltme turu açar;
 * - diğer doğrulanmış orta bulgular aynı turda düzeltilir; tur açılmazsa `carry` ile sonraki görevlere devreder.
 */
function mergePanel(review, panel, { final = false, labels = {} } = {}) {
  if (!panel) return review;
  const confirmed = panel.confirmed || [];
  const block = confirmed.filter((f) => SEVERE.has(f.severity) || (final && f.severity === 'medium'));
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
    carry: block.length ? [] : rest,
  };
  return review;
}

// Düzeltme turundan sonra derin incelemenin hedefli yeniden doğrulamasına girecek maddeler.
function panelFocus(panel, { final = false } = {}) {
  return (panel?.confirmed || [])
    .filter((f) => SEVERE.has(f.severity) || (final && f.severity === 'medium'))
    .map((f) => ({ severity: f.severity, title: f.title, file: where(f), detail: `${f.problem} Failure scenario: ${f.scenario} Expected fix: ${f.fix}` }));
}

module.exports = { parseFileRef, codeExcerpt, mergePanel, panelFocus };
