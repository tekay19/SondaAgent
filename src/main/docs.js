// Ekli teknik dokümanlar: Gemini'ye gönderilecek parçalara dönüştürme ve
// ajanların okuyabilmesi için proje klasörüne kopyalama.
const fs = require('fs');
const path = require('path');

const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.csv', '.html', '.htm', '.xml', '.sql', '.graphql', '.gql', '.ts', '.tsx', '.js', '.jsx', '.py', '.prisma', '.env.example', '.toml', '.ini']);
const INLINE_MIME = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};
const MAX_FILE = 15 * 1024 * 1024;
const MAX_TOTAL = 19 * 1024 * 1024; // Gemini satır içi istek sınırı ~20 MB
const DOC_DIR = path.join('docs', 'sonda');

const FILTERS = [
  { name: 'Dokümanlar', extensions: ['pdf', 'md', 'markdown', 'txt', 'docx', 'json', 'yaml', 'yml', 'csv', 'html', 'png', 'jpg', 'jpeg', 'webp'] },
  { name: 'Tüm dosyalar', extensions: ['*'] },
];

function kindOf(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.docx') return 'docx';
  if (INLINE_MIME[ext]) return INLINE_MIME[ext].startsWith('image/') ? 'image' : 'pdf';
  if (TEXT_EXT.has(ext)) return 'text';
  return null;
}

function inspect(filePath) {
  const st = fs.statSync(filePath);
  const kind = kindOf(filePath);
  return { path: filePath, name: path.basename(filePath), size: st.size, kind, supported: !!kind && st.size <= MAX_FILE };
}

async function toGeminiParts(attachments) {
  const parts = [];
  let total = 0;
  for (const a of attachments) {
    const header = { text: `\n===== ATTACHED DOCUMENT: ${a.name} =====` };
    const ext = path.extname(a.path).toLowerCase();
    if (a.kind === 'text') {
      parts.push(header, { text: fs.readFileSync(a.path, 'utf8') });
    } else if (a.kind === 'docx') {
      const mammoth = require('mammoth');
      const { value } = await mammoth.extractRawText({ path: a.path });
      parts.push(header, { text: value });
    } else if (a.kind === 'pdf' || a.kind === 'image') {
      total += a.size;
      if (total > MAX_TOTAL) throw new Error(`Ekler çok büyük (toplam ~20 MB sınırı). "${a.name}" gönderilemedi.`);
      parts.push(header, { inlineData: { mimeType: INLINE_MIME[ext], data: fs.readFileSync(a.path).toString('base64') } });
    }
  }
  return parts;
}

// Orijinal dokümanları ve Gemini'nin şartnamesini projeye yazar; ajanlar buradan okur.
function writeToProject(projectDir, attachments, specMarkdown) {
  const base = path.join(projectDir, DOC_DIR);
  fs.mkdirSync(path.join(base, 'references'), { recursive: true });
  const refs = [];
  for (const a of attachments || []) {
    try {
      const dest = path.join(base, 'references', a.name);
      fs.copyFileSync(a.path, dest);
      refs.push(path.join(DOC_DIR, 'references', a.name).split(path.sep).join('/'));
    } catch {
      /* dosya taşınmış/silinmiş olabilir */
    }
  }
  if (specMarkdown) fs.writeFileSync(path.join(base, 'SPEC.md'), specMarkdown);
  return { specPath: `${DOC_DIR.split(path.sep).join('/')}/SPEC.md`, refs };
}

// Kullanıcının isteği birebir saklanır (nihai doğruluk kaynağı). Aynı klasördeki sonraki
// işler dosyanın sonuna eklenir; önceki istekler asla silinmez.
function writeRequest(projectDir, job) {
  const file = path.join(projectDir, DOC_DIR, 'REQUEST.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const marker = `<!-- job:${job.id} -->`;
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    /* ilk istek */
  }
  if (text.includes(marker)) return;
  const notes = job.attachments?.length ? `\n\nEkli dokümanlar: ${job.attachments.map((a) => `docs/sonda/references/${a.name}`).join(', ')}` : '';
  const section = `${marker}\n## ${text ? 'Ek istek' : 'Orijinal istek'} — ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC\n\n${job.idea || '(İstek metni yok — ekli dokümanlara göre.)'}${notes}\n`;
  fs.writeFileSync(file, text ? `${text.trimEnd()}\n\n---\n\n${section}` : `# Kullanıcı isteği\n\nBu dosya kullanıcının isteğini birebir içerir ve nihai doğruluk kaynağıdır.\n\n${section}`);
}

// ---------- Proje hafızası dosyaları ----------
const memPath = (dir, f) => path.join(dir, DOC_DIR, f);

function readMemory(projectDir) {
  try {
    return fs.readFileSync(memPath(projectDir, 'MEMORY.md'), 'utf8');
  } catch {
    return '';
  }
}

function writeMemory(projectDir, memory) {
  fs.mkdirSync(path.join(projectDir, DOC_DIR), { recursive: true });
  fs.writeFileSync(memPath(projectDir, 'MEMORY.md'), `<!-- Sonda tarafından her görevden sonra güncellenir. -->\n${memory.trim()}\n`);
}

// PROGRESS.md yalnızca sona eklenir; önceki işlerin kaydı asla silinmez.
function appendProgress(projectDir, entry) {
  const file = memPath(projectDir, 'PROGRESS.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, '# Build log\n\nSonda\'nın bu projede yaptığı her görevin kaydı (en yeni en altta).\n');
  fs.appendFileSync(file, `\n${entry.trim()}\n`);
}

const GUIDE_START = '<!-- sonda:start -->';
const GUIDE_END = '<!-- sonda:end -->';

// Claude Code CLAUDE.md'yi, Codex AGENTS.md'yi her oturumda kendiliğinden okur.
// Yönetilen bir blok ekleyerek ajanların (ve sonradan elle açılan oturumların) projeyi tanımasını sağlarız.
function writeAgentGuides(projectDir, standards) {
  const block = `${GUIDE_START}
## Sonda project context (auto-maintained — edit outside this block)
Before changing anything, read:
- \`docs/sonda/SPEC.md\` — technical specification and requirements (source of truth)
- \`docs/sonda/MEMORY.md\` — architecture memory: modules, data model, routes, reusable UI, conventions, decisions
- \`docs/sonda/PROGRESS.md\` — build log of every task done so far

Reuse existing modules and components; keep conventions consistent; never duplicate logic that already exists.

### Engineering standards
${standards.trim()}
${GUIDE_END}`;
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    const file = path.join(projectDir, name);
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      /* yok */
    }
    const re = new RegExp(`${GUIDE_START}[\\s\\S]*?${GUIDE_END}`);
    text = re.test(text) ? text.replace(re, block) : `${text.trim() ? `${text.trimEnd()}\n\n` : ''}${block}\n`;
    fs.writeFileSync(file, text);
  }
}

// Önceki Sonda işlerinden kalan hafıza (planlayıcıya bağlam olarak verilir).
function readSondaContext(projectDir) {
  const read = (f, max, tail = false) => {
    try {
      const t = fs.readFileSync(memPath(projectDir, f), 'utf8');
      if (t.length <= max) return t;
      return tail ? `…\n${t.slice(-max)}` : `${t.slice(0, max)}\n…`;
    } catch {
      return null;
    }
  };
  const parts = [];
  const request = read('REQUEST.md', 60000, true);
  const spec = read('SPEC.md', 40000);
  if (request) parts.push(`docs/sonda/REQUEST.md (earlier user requests, verbatim):\n${request}`);
  const mem = read('MEMORY.md', 20000);
  const prog = read('PROGRESS.md', 15000, true);
  if (spec) parts.push(`docs/sonda/SPEC.md (previous spec):\n${spec}`);
  if (mem) parts.push(`docs/sonda/MEMORY.md (architecture memory):\n${mem}`);
  if (prog) parts.push(`docs/sonda/PROGRESS.md (build log):\n${prog}`);
  return parts.join('\n\n');
}

module.exports = { FILTERS, inspect, toGeminiParts, writeToProject, writeRequest, readMemory, writeMemory, appendProgress, writeAgentGuides, readSondaContext };
