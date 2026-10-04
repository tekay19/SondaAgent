// Ekli teknik dokümanlar ve tasarım dosyaları: Gemini'ye gönderilecek parçalara dönüştürme ve
// ajanların okuyabilmesi için proje klasörüne kopyalama.
// İki rol vardır: "doc" (şartname, PRD, API dokümanı…) ve "design" (arayüzün görünümünü BELİRLEYEN
// HTML/CSS, görsel, klasör halinde tasarım…). Tasarım dosyaları docs/sonda/design/ altına kopyalanır.
const fs = require('fs');
const path = require('path');

const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.log', '.json', '.yaml', '.yml', '.csv', '.html', '.htm', '.xml', '.sql', '.graphql', '.gql', '.ts', '.tsx', '.js', '.jsx', '.py', '.prisma', '.env.example', '.toml', '.ini']);
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
const DOC_POSIX = 'docs/sonda';
const DESIGN_DIR = 'design'; // docs/sonda/design/ — tasarım dosyaları; _onizleme/ altında Sonda'nın aldığı görüntüler
const PREVIEW_DIR = '_onizleme';

// Tasarım dosyası olarak kabul edilenler: sayfa/şablon kaynakları, stiller, görseller, fontlar, PDF çizimler.
const DESIGN_TEXT_EXT = new Set(['.html', '.htm', '.css', '.scss', '.sass', '.less', '.js', '.mjs', '.jsx', '.tsx', '.vue', '.svelte', '.svg', '.json', '.md', '.txt']);
const DESIGN_ASSET_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.pdf', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp4', '.webm', '.avif']);
const DESIGN_SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.cache', '.DS_Store']);
const FOLDER_MAX_FILES = 3000;
const FOLDER_MAX_BYTES = 300 * 1024 * 1024;

const FILTERS = [
  { name: 'Dokümanlar', extensions: ['pdf', 'md', 'markdown', 'txt', 'log', 'docx', 'json', 'yaml', 'yml', 'csv', 'html', 'png', 'jpg', 'jpeg', 'webp'] },
  { name: 'Tüm dosyalar', extensions: ['*'] },
];
const DESIGN_FILTERS = [
  { name: 'Tasarım dosyaları', extensions: ['html', 'htm', 'css', 'scss', 'js', 'svg', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'pdf', 'woff', 'woff2', 'ttf', 'otf', 'json'] },
  { name: 'Tüm dosyalar', extensions: ['*'] },
];

function kindOf(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.docx') return 'docx';
  if (INLINE_MIME[ext]) return INLINE_MIME[ext].startsWith('image/') ? 'image' : 'pdf';
  if (TEXT_EXT.has(ext)) return 'text';
  return null;
}
const isDesignFile = (file) => {
  const ext = path.extname(file).toLowerCase();
  return DESIGN_TEXT_EXT.has(ext) || DESIGN_ASSET_EXT.has(ext);
};

// Klasör içeriği (tasarım klasörü): dosya sayısı ve toplam boyut; bağımlılık/derleme klasörleri atlanır.
function walkFolder(root, { maxFiles = FOLDER_MAX_FILES } = {}) {
  const files = [];
  let bytes = 0;
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files.length >= maxFiles) return;
      if (e.isSymbolicLink() || DESIGN_SKIP_DIRS.has(e.name) || e.name.startsWith('._')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (e.isFile()) {
        let size = 0;
        try {
          size = fs.statSync(path.join(dir, e.name)).size;
        } catch {
          continue;
        }
        bytes += size;
        files.push({ rel: r, size });
      }
    }
  };
  walk(root, '');
  return { files, bytes };
}

/**
 * Bir eki inceler. Dosya: tür (metin / pdf / görsel / docx) ve boyut. Klasör (yalnızca tasarım için):
 * içindeki dosya sayısı ve toplam boyut. `role`: "doc" (varsayılan) ya da "design".
 */
function inspect(filePath, role) {
  const st = fs.statSync(filePath);
  const name = path.basename(filePath);
  if (st.isDirectory()) {
    const { files, bytes } = walkFolder(filePath);
    const html = files.filter((f) => /\.html?$/i.test(f.rel)).length;
    return { path: filePath, name, size: bytes, kind: 'folder', role: 'design', files: files.length, html, supported: files.length > 0 && files.length < FOLDER_MAX_FILES && bytes <= FOLDER_MAX_BYTES };
  }
  const design = role === 'design';
  const kind = design && !kindOf(filePath) && isDesignFile(filePath) ? 'asset' : kindOf(filePath);
  return { path: filePath, name, size: st.size, kind, role: design ? 'design' : 'doc', supported: !!kind && st.isFile() && st.size <= MAX_FILE };
}

// Arayüzden gelen ek listesi ana süreçte yeniden incelenir: ad, tür ve boyut dosyanın kendisinden okunur;
// desteklenmeyen, çok büyük ya da artık var olmayan dosyalar elenir. Klasörler yalnızca tasarım olarak kabul edilir.
function sanitizeAttachments(list) {
  const out = [];
  const seen = new Set();
  for (const a of Array.isArray(list) ? list : []) {
    const p = typeof a?.path === 'string' ? a.path : '';
    if (!p || !path.isAbsolute(p) || seen.has(p)) continue;
    seen.add(p);
    try {
      const info = inspect(p, a.role === 'design' ? 'design' : 'doc');
      if (info.supported) out.push({ path: info.path, name: info.name, size: info.size, kind: info.kind, role: info.role, ...(info.kind === 'folder' ? { files: info.files, html: info.html } : {}) });
    } catch {
      /* dosya yok */
    }
  }
  return out.slice(0, 40);
}

const isDesign = (a) => a?.role === 'design' || a?.kind === 'folder' || a?.kind === 'asset';

// Tasarım klasöründe Gemini'ye metin olarak verilecek dosyalar: önce sayfalar, sonra stiller, sonra betikler.
function designTextFiles(folder) {
  const { files } = walkFolder(folder);
  const rank = (r) => (/\.html?$/i.test(r) ? 0 : /\.(css|scss|sass|less)$/i.test(r) ? 1 : /\.svg$/i.test(r) ? 3 : 2);
  return files
    .filter((f) => DESIGN_TEXT_EXT.has(path.extname(f.rel).toLowerCase()) && f.size <= 400000)
    .sort((a, b) => rank(a.rel) - rank(b.rel) || a.rel.split('/').length - b.rel.split('/').length || a.rel.localeCompare(b.rel));
}

/**
 * Ekleri Gemini parçalarına çevirir. Dokümanlar metin / satır içi (PDF, görsel) olarak; tasarım dosyalarında
 * sayfa ve stil kaynakları metin olarak (bütçeli), görseller satır içi; klasörlerde kalan dosyalar adıyla listelenir.
 */
async function toGeminiParts(attachments) {
  const parts = [];
  let total = 0;
  let designText = 0;
  const DESIGN_TEXT_BUDGET = 450000;
  const inline = (label, file, size) => {
    total += size;
    if (total > MAX_TOTAL) throw new Error(`Ekler çok büyük (toplam ~20 MB sınırı). "${label}" gönderilemedi.`);
    parts.push({ text: `\n===== ${label} =====` }, { inlineData: { mimeType: INLINE_MIME[path.extname(file).toLowerCase()], data: fs.readFileSync(file).toString('base64') } });
  };
  const textPart = (label, file, size) => {
    if (designText + size > DESIGN_TEXT_BUDGET) return false;
    designText += size;
    parts.push({ text: `\n===== ${label} =====\n${fs.readFileSync(file, 'utf8')}` });
    return true;
  };
  for (const a of attachments) {
    const ext = path.extname(a.path).toLowerCase();
    if (a.kind === 'folder') {
      const listed = [];
      const skipped = [];
      for (const f of designTextFiles(a.path)) {
        if (textPart(`DESIGN FILE: ${a.name}/${f.rel}`, path.join(a.path, f.rel), f.size)) listed.push(f.rel);
        else skipped.push(f.rel);
      }
      const { files } = walkFolder(a.path);
      const images = files.filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f.rel) && f.size <= 4 * 1024 * 1024).slice(0, 12);
      for (const f of images) {
        try {
          inline(`DESIGN IMAGE: ${a.name}/${f.rel}`, path.join(a.path, f.rel), f.size);
        } catch {
          skipped.push(f.rel);
        }
      }
      const rest = files.filter((f) => !listed.includes(f.rel) && !images.some((i) => i.rel === f.rel)).map((f) => f.rel);
      parts.push({ text: `\n===== DESIGN FOLDER: ${a.name} — ${files.length} files =====\nShown above: ${listed.length} source files${images.length ? ` and ${images.length} images` : ''}.${skipped.length ? ` Not shown (size budget): ${skipped.slice(0, 30).join(', ')}.` : ''}${rest.length ? ` Other assets: ${rest.slice(0, 80).join(', ')}${rest.length > 80 ? ` … (+${rest.length - 80})` : ''}.` : ''}` });
      continue;
    }
    const label = `${isDesign(a) ? 'DESIGN FILE' : 'ATTACHED DOCUMENT'}: ${a.name}`;
    if (a.kind === 'text' || (a.kind === 'asset' && DESIGN_TEXT_EXT.has(ext))) {
      if (isDesign(a)) {
        if (!textPart(label, a.path, a.size)) parts.push({ text: `\n===== ${label} (not shown: size budget) =====` });
      } else parts.push({ text: `\n===== ${label} =====` }, { text: fs.readFileSync(a.path, 'utf8') });
    } else if (a.kind === 'docx') {
      const mammoth = require('mammoth');
      const { value } = await mammoth.extractRawText({ path: a.path });
      parts.push({ text: `\n===== ${label} =====` }, { text: value });
    } else if (a.kind === 'pdf' || a.kind === 'image') {
      inline(label, a.path, a.size);
    } else if (a.kind === 'asset') {
      parts.push({ text: `\n===== ${label} (binary asset, ${Math.round(a.size / 1024)} KB — copied into the project) =====` });
    }
  }
  return parts;
}

// Aynı adlı ikinci dosya öncekini ezmez: "ad-2.uzantı".
function uniqueName(used, raw) {
  let name = path.basename(String(raw || 'dosya')) || 'dosya';
  for (let n = 2; used.has(name.toLowerCase()); n++) {
    const ext = path.extname(name);
    name = `${path.basename(name, ext).replace(/-\d+$/, '')}-${n}${ext}`;
  }
  used.add(name.toLowerCase());
  return name;
}

// Klasörü kopyalar (bağımlılık/derleme klasörleri ve sembolik bağlar hariç). Kopyalanan dosyaların göreli yollarını döner.
function copyFolder(src, dest) {
  const { files } = walkFolder(src);
  for (const f of files) {
    const to = path.join(dest, f.rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(src, f.rel), to);
  }
  return files.map((f) => f.rel);
}

/**
 * Tasarım dosyalarını projeye yazar: docs/sonda/design/<dosya> ve docs/sonda/design/<klasör>/…
 * Dönen: { refs: tüm dosyaların göreli yolları, pages: HTML sayfalarının göreli yolları (index önce) }.
 */
function writeDesign(projectDir, attachments) {
  const design = (attachments || []).filter(isDesign);
  if (!design.length) return { refs: [], pages: [] };
  const base = path.join(projectDir, DOC_DIR, DESIGN_DIR);
  fs.mkdirSync(base, { recursive: true });
  const refs = [];
  const used = new Set([PREVIEW_DIR]);
  for (const a of design) {
    try {
      const name = uniqueName(used, a.name || a.path);
      if (a.kind === 'folder') {
        const dest = path.join(base, name);
        fs.rmSync(dest, { recursive: true, force: true });
        for (const rel of copyFolder(a.path, dest)) refs.push(`${DOC_POSIX}/${DESIGN_DIR}/${name}/${rel}`);
      } else {
        fs.copyFileSync(a.path, path.join(base, name));
        refs.push(`${DOC_POSIX}/${DESIGN_DIR}/${name}`);
      }
    } catch {
      /* dosya taşınmış/silinmiş olabilir */
    }
  }
  const pages = refs
    .filter((r) => /\.html?$/i.test(r))
    .sort((a, b) => (/\/index\.html?$/i.test(b) - /\/index\.html?$/i.test(a)) || a.split('/').length - b.split('/').length || a.localeCompare(b));
  return { refs, pages };
}

// Tasarım sayfalarının Sonda tarafından alınan görüntüleri: docs/sonda/design/_onizleme/<ad>-masaustu.jpg
function previewDir(projectDir) {
  return path.join(projectDir, DOC_DIR, DESIGN_DIR, PREVIEW_DIR);
}

// Orijinal dokümanları (docs/sonda/references), tasarım dosyalarını (docs/sonda/design) ve Gemini'nin
// şartnamesini projeye yazar; ajanlar buradan okur.
function writeToProject(projectDir, attachments, specMarkdown) {
  const base = path.join(projectDir, DOC_DIR);
  fs.mkdirSync(path.join(base, 'references'), { recursive: true });
  const refs = [];
  const used = new Set();
  for (const a of (attachments || []).filter((x) => !isDesign(x))) {
    try {
      // Yalnızca dosya adı kullanılır (klasör dışına yazılamaz); aynı adlı ikinci dosya öncekini ezmez.
      const name = uniqueName(used, a.name || a.path);
      fs.copyFileSync(a.path, path.join(base, 'references', name));
      refs.push(`${DOC_POSIX}/references/${name}`);
    } catch {
      /* dosya taşınmış/silinmiş olabilir */
    }
  }
  const design = writeDesign(projectDir, attachments);
  if (specMarkdown) fs.writeFileSync(path.join(base, 'SPEC.md'), specMarkdown);
  return { specPath: `${DOC_POSIX}/SPEC.md`, refs, designRefs: design.refs, designPages: design.pages };
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
  const docsList = (job.attachments || []).filter((a) => !isDesign(a)).map((a) => `docs/sonda/references/${a.name}`);
  const designList = (job.attachments || []).filter(isDesign).map((a) => `docs/sonda/design/${a.name}${a.kind === 'folder' ? '/' : ''}`);
  const notes = `${docsList.length ? `\n\nEkli dokümanlar: ${docsList.join(', ')}` : ''}${designList.length ? `\n\nEkli tasarım dosyaları (arayüzün görünümünü belirler): ${designList.join(', ')}` : ''}`;
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
    // İşlevle değiştirilir: standartlar metnindeki "$&", "$1" gibi diziler yer tutucu sanılmasın.
    text = re.test(text) ? text.replace(re, () => block) : `${text.trim() ? `${text.trimEnd()}\n\n` : ''}${block}\n`;
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

module.exports = { FILTERS, DESIGN_FILTERS, inspect, sanitizeAttachments, isDesign, isDesignFile, toGeminiParts, writeDesign, previewDir, writeToProject, writeRequest, readMemory, writeMemory, appendProgress, writeAgentGuides, readSondaContext };
