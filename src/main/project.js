// Proje klasörünü inceleme ve git yardımcıları.
const fs = require('fs');
const path = require('path');
const runner = require('./runner');
const { findExecutable, agentEnv } = require('./env');

const IGNORE = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', '.turbo', '.cache', 'coverage', '.venv', 'venv', '__pycache__', '.vercel', '.idea', '.vscode', 'target']);

// Yalnızca gizli dosyalar / derleme önbellekleri / bağımlılık klasörleri içeren klasör "boş" sayılır
// (ör. kullanıcı proje dosyalarını silmiş ama .git, .env, .next kalmış).
const LEFTOVER = new Set(['.DS_Store', '.git', '.gitignore', '.env', '.env.local', '.next', 'node_modules', '.turbo', '.cache', 'dist', 'build', 'out', 'coverage', 'Thumbs.db', '.vercel']);
function isEmptyDir(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => !LEFTOVER.has(f)).length === 0;
  } catch {
    return true;
  }
}

function fileTree(dir, { maxEntries = 250, maxDepth = 4 } = {}) {
  const lines = [];
  const walk = (d, depth, prefix) => {
    if (lines.length >= maxEntries || depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    entries = entries
      .filter((e) => !IGNORE.has(e.name) && e.name !== '.DS_Store')
      .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of entries) {
      if (lines.length >= maxEntries) {
        lines.push(`${prefix}…`);
        return;
      }
      lines.push(`${prefix}${e.name}${e.isDirectory() ? '/' : ''}`);
      if (e.isDirectory()) walk(path.join(d, e.name), depth + 1, prefix + '  ');
    }
  };
  walk(dir, 0, '');
  return lines.join('\n');
}

function readText(file, max = 4000) {
  try {
    const s = fs.readFileSync(file, 'utf8');
    return s.length > max ? s.slice(0, max) + '\n…' : s;
  } catch {
    return null;
  }
}

// Mevcut proje için Gemini'ye verilecek bağlam.
function describe(dir) {
  if (isEmptyDir(dir)) return null;
  const parts = [`File tree:\n${fileTree(dir)}`];
  const pkg = readText(path.join(dir, 'package.json'), 4000);
  if (pkg) parts.push(`package.json:\n${pkg}`);
  for (const f of ['README.md', 'readme.md', 'pyproject.toml', 'requirements.txt']) {
    const t = readText(path.join(dir, f), 2500);
    if (t) parts.push(`${f}:\n${t}`);
  }
  const previous = require('./docs').readSondaContext(dir);
  if (previous) parts.push(`# Memory from previous Sonda builds in this folder\n${previous}`);
  return parts.join('\n\n');
}

// Teknik brif için "sözleşme" niteliğindeki dosyalar: şemalar, paylaşılan tipler, paket tanımları,
// yapılandırma. Bütçe dolana kadar önem sırasıyla eklenir.
const KEY_FILE_RULES = [
  [/(^|\/)schema\.prisma$|(^|\/)drizzle\/schema\.ts$|(^|\/)db\/schema\.ts$/, 1],
  [/(^|\/)package\.json$/, 2],
  [/(^|\/)(docker-compose[^/]*\.ya?ml|compose\.ya?ml)$|(^|\/)\.env\.example$/, 3],
  [/(^|\/)packages\/(types|validation|api-client|config)\/src\/.+\.(ts|tsx)$/, 4],
  [/(^|\/)(src\/)?(types|schemas|validation|lib\/validations?)\/[^/]+\.(ts|tsx)$/, 5],
  [/(^|\/)(turbo\.json|pnpm-workspace\.yaml|tsconfig(\.base)?\.json|next\.config\.[mc]?[jt]s|nest-cli\.json|vitest\.config\.[mc]?[jt]s|playwright\.config\.[mc]?[jt]s|tailwind\.config\.[mc]?[jt]s)$/, 6],
  [/(^|\/)app\.module\.ts$|(^|\/)main\.ts$|(^|\/)app\/layout\.tsx$|(^|\/)globals\.css$/, 7],
];

function keyFiles(dir, budget = 70000) {
  const found = [];
  const walk = (d, rel, depth) => {
    if (depth > 7 || found.length > 400) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (IGNORE.has(e.name) || (e.name.startsWith('.') && e.name !== '.env.example')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r, depth + 1);
      else {
        const rule = KEY_FILE_RULES.find(([re]) => re.test(r));
        if (rule) found.push({ rel: r, rank: rule[1], depth });
      }
    }
  };
  walk(dir, '', 0);
  found.sort((a, b) => a.rank - b.rank || a.depth - b.depth || a.rel.localeCompare(b.rel));
  const out = [];
  let used = 0;
  for (const f of found) {
    const text = readText(path.join(dir, f.rel), 16000);
    if (!text || /docs\/sonda\//.test(f.rel)) continue;
    const block = `### ${f.rel}\n\`\`\`\n${text}\n\`\`\``;
    if (used + block.length > budget) continue;
    out.push(block);
    used += block.length;
  }
  return out.join('\n\n');
}

// Node projesini bulur: kökte ya da tek bir alt klasörde package.json.
function nodeApp(dir) {
  const tryDir = (d) => {
    const txt = readText(path.join(d, 'package.json'), 1e6);
    if (!txt) return null;
    try {
      const pkg = JSON.parse(txt);
      return { appDir: d, pkg, scripts: pkg.scripts || {}, pm: packageManager(d) };
    } catch {
      return null;
    }
  };
  const root = tryDir(dir);
  if (root) return root;
  let subs = [];
  try {
    subs = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !IGNORE.has(e.name) && !e.name.startsWith('.'));
  } catch {
    /* yok */
  }
  const found = subs.map((e) => tryDir(path.join(dir, e.name))).filter(Boolean);
  return found.length === 1 ? found[0] : null;
}

function packageManager(dir) {
  const has = (f) => fs.existsSync(path.join(dir, f));
  if (has('pnpm-lock.yaml')) return 'pnpm';
  if (has('yarn.lock')) return 'yarn';
  if (has('bun.lockb') || has('bun.lock')) return 'bun';
  return 'npm';
}

// ---------- git ----------
const gitBin = () => findExecutable('git');

async function git(dir, args, timeoutMs = 60000) {
  const bin = gitBin();
  if (!bin) return { code: -1, stdout: '', stderr: 'git yok' };
  return runner.run({ command: bin, args, cwd: dir, env: agentEnv({ GIT_TERMINAL_PROMPT: '0' }), timeoutMs, tailSize: 600000 });
}

async function ensureRepo(dir) {
  if (!gitBin()) return false;
  const r = await git(dir, ['rev-parse', '--is-inside-work-tree']);
  if (r.code === 0 && r.stdout.trim() === 'true') return true;
  const init = await git(dir, ['init']);
  return init.code === 0;
}

const DEFAULT_GITIGNORE = ['node_modules/', '.next/', 'dist/', 'build/', 'out/', 'coverage/', '.env', '.env*.local', '.DS_Store', '*.log', '.venv/', '__pycache__/', ''].join('\n');

async function identityArgs(dir) {
  const r = await git(dir, ['config', 'user.email']);
  return r.stdout.trim() ? [] : ['-c', 'user.name=Sonda', '-c', 'user.email=sonda@localhost'];
}

// node_modules gibi klasörlerin commit'e girmemesi için kökte .gitignore yoksa oluştur.
function ensureGitignore(dir) {
  const gi = path.join(dir, '.gitignore');
  if (!fs.existsSync(gi) && !isEmptyDir(dir)) fs.writeFileSync(gi, DEFAULT_GITIGNORE);
}

const LOCK_EXCLUDES = [':(exclude)package-lock.json', ':(exclude)pnpm-lock.yaml', ':(exclude)yarn.lock', ':(exclude)bun.lock'];

// Kullanıcının gizli değerlerinden biri (ör. API anahtarı) koda yazılmışsa o dosyaları commit dışında bırakır.
async function unstageSecrets(dir, needles) {
  if (!needles?.length) return [];
  const leaked = new Set();
  let file = null;
  await runner.run({
    command: gitBin(),
    args: ['-c', 'core.quotePath=false', 'diff', '--cached', '--no-color', '--no-ext-diff', '-U0', '--', '.', ...LOCK_EXCLUDES],
    cwd: dir,
    env: agentEnv({ GIT_TERMINAL_PROMPT: '0' }),
    timeoutMs: 60000,
    tailSize: 1000,
    onStdout: (line) => {
      if (line.startsWith('+++ ')) file = line.slice(4).replace(/^"|"$/g, '').replace(/^b\//, '');
      else if (file && file !== '/dev/null' && line.startsWith('+') && needles.some((n) => line.includes(n))) leaked.add(file);
    },
  });
  const list = [...leaked];
  if (list.length) await git(dir, ['reset', '-q', '--', ...list]);
  return list;
}

async function commitAll(dir, message, { secretNeedles, onLeak } = {}) {
  if (!gitBin()) return null;
  ensureGitignore(dir);
  await git(dir, ['add', '-A']);
  const leaked = await unstageSecrets(dir, secretNeedles);
  if (leaked.length) onLeak?.(leaked);
  const r = await git(dir, [...(await identityArgs(dir)), 'commit', '-m', message, '--no-verify']);
  if (r.code !== 0) return null;
  const h = await git(dir, ['rev-parse', '--short', 'HEAD']);
  return h.stdout.trim();
}

async function headCommit(dir) {
  if (!gitBin()) return null;
  const r = await git(dir, ['rev-parse', '--verify', 'HEAD']);
  return r.code === 0 ? r.stdout.trim() : null;
}

// `base` commit'inden (yoksa son commit'ten) bu yana değişiklikler, yeni dosyalar dahil.
// Kilit dosyaları ve ikonlar hariç.
async function diffSince(dir, base, maxChars = 120000) {
  if (!gitBin()) return null;
  ensureGitignore(dir);
  await git(dir, ['add', '-A']);
  const excludes = [':(exclude)package-lock.json', ':(exclude)pnpm-lock.yaml', ':(exclude)yarn.lock', ':(exclude)bun.lock', ':(exclude)*.svg', ':(exclude)*.ico'];
  const from = base || (await headCommit(dir));
  const range = from ? ['--cached', from] : ['--cached'];
  const stat = await git(dir, ['diff', ...range, '--stat', '--', '.', ...excludes]);
  const diff = await git(dir, ['diff', ...range, '--', '.', ...excludes], 120000);
  let body = diff.stdout;
  if (body.length > maxChars) body = body.slice(0, maxChars) + '\n… (diff kısaltıldı)';
  return { stat: stat.stdout.trim(), diff: body };
}

// Çalışma ağacında commit'lenmemiş değişiklik var mı?
async function isClean(dir) {
  if (!gitBin()) return false;
  const r = await git(dir, ['status', '--porcelain']);
  return r.code === 0 && !r.stdout.trim();
}

// Son commit'e döner (yalnızca inceleyicinin istemeden bıraktığı değişiklikler için; yok sayılan dosyalara dokunmaz).
async function discardChanges(dir) {
  if (!gitBin()) return;
  await git(dir, ['reset', '--hard', 'HEAD']);
  await git(dir, ['clean', '-fd']);
}

// Belirli dosyaların `base`'ten bu yana farkı (ör. TDD testleri uygulayıcı tarafından değişti mi).
async function diffPaths(dir, base, paths, maxChars = 20000) {
  if (!gitBin() || !base || !paths?.length) return '';
  await git(dir, ['add', '-A']);
  const r = await git(dir, ['diff', '--cached', base, '--', ...paths]);
  const t = r.stdout.trim();
  return t.length > maxChars ? `${t.slice(0, maxChars)}\n… (kısaltıldı)` : t;
}

// Kurulu bağımlılık sürümleri (node_modules'ten): incelemecinin eski API bilgisini kanıtla düzeltmek için.
function installedVersions(dir) {
  const app = nodeApp(dir);
  if (!app) return {};
  const names = Object.keys({ ...(app.pkg.dependencies || {}), ...(app.pkg.devDependencies || {}) }).slice(0, 80);
  const out = {};
  for (const name of names) {
    try {
      const v = JSON.parse(readText(path.join(app.appDir, 'node_modules', name, 'package.json'), 400000) || '{}').version;
      if (v) out[name] = v;
    } catch {
      /* kurulu değil */
    }
  }
  return out;
}

// ---------- Gemini denetimi için kod içeriği ----------
const TEXT_SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|json|css|scss|html|md|mdx|prisma|sql|ya?ml|toml|py|go|rs|java|kt|swift|rb|php|vue|svelte|sh|env\.example)$|(^|\/)(Dockerfile|Makefile|\.env\.example)$/;
const SKIP_SOURCE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|next-env\.d\.ts)$|(^|\/)(docs\/sonda|dist|build|out|coverage|\.next|node_modules)\//;

async function trackedFiles(dir) {
  if (!gitBin()) return [];
  ensureGitignore(dir);
  await git(dir, ['add', '-A']);
  const r = await git(dir, ['ls-files'], 60000);
  return r.stdout.split('\n').map((l) => l.trim()).filter((f) => f && TEXT_SOURCE.test(f) && !SKIP_SOURCE.test(f));
}

// `base`'ten (yoksa son commit'ten) bu yana değişen metin dosyaları.
async function changedFiles(dir, base) {
  if (!gitBin()) return [];
  await git(dir, ['add', '-A']);
  const from = base || (await headCommit(dir));
  const r = await git(dir, ['diff', '--cached', '--name-only', '--diff-filter=AM', ...(from ? [from] : [])]);
  return r.stdout.split('\n').map((l) => l.trim()).filter((f) => f && TEXT_SOURCE.test(f) && !SKIP_SOURCE.test(f));
}

// Dosyaların tam içeriği; bütçe dolunca kalanlar yalnızca adıyla listelenir.
function fileContents(dir, files, budget = 200000) {
  const out = [];
  const skipped = [];
  let used = 0;
  for (const f of files) {
    const text = readText(path.join(dir, f), 40000);
    if (text == null) continue;
    const block = `### ${f}\n\`\`\`\n${text}\n\`\`\``;
    if (used + block.length > budget) {
      skipped.push(f);
      continue;
    }
    out.push(block);
    used += block.length;
  }
  if (skipped.length) out.push(`(Bütçe nedeniyle içeriği eklenmeyen dosyalar: ${skipped.join(', ')})`);
  return out.join('\n\n');
}

// Faz kapısı / son inceleme için kodun anlık görüntüsü: önce değişenler, sonra diğerleri.
async function sourceSnapshot(dir, { priority = [], budget = 450000 } = {}) {
  const all = await trackedFiles(dir);
  const first = new Set(priority);
  const ordered = [...priority.filter((f) => all.includes(f)), ...all.filter((f) => !first.has(f))];
  return fileContents(dir, ordered, budget);
}

module.exports = { isEmptyDir, describe, fileTree, keyFiles, nodeApp, ensureRepo, commitAll, headCommit, diffSince, changedFiles, fileContents, sourceSnapshot, isClean, discardChanges, diffPaths, installedVersions };
