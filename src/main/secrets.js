// Proje başına ortam değişkenleri (.env değerleri). Değerler işletim sisteminin anahtar zinciriyle
// (macOS Keychain / Windows DPAPI) şifrelenip userData/secrets.json'da saklanır.
// Arayüze ham değer gönderilmez (yalnızca maskeli hali); ajan istemlerine ve Gemini'ye yalnızca adlar gider.
// Değerleri projenin .env dosyasına Sonda yazar.
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const envfile = require('./envfile');
const project = require('./project');

const MANIFESTS = ['package.json', 'pyproject.toml', 'requirements.txt', 'go.mod', 'Cargo.toml', 'composer.json', 'Gemfile', 'pom.xml', 'build.gradle', 'deno.json'];

const file = () => path.join(app.getPath('userData'), 'secrets.json');
const keyOf = (dir) => path.resolve(String(dir || ''));
const cache = new Map();
let version = 0;

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    return {};
  }
}

function writeAll(data) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(data, null, 2), { mode: 0o600 });
}

const encrypted = () => safeStorage.isEncryptionAvailable();

function get(dir) {
  if (!dir) return {};
  const k = keyOf(dir);
  if (!cache.has(k)) {
    const rec = readAll()[k];
    let vars = {};
    if (rec?.enc && encrypted()) {
      try {
        vars = JSON.parse(safeStorage.decryptString(Buffer.from(rec.enc, 'base64')));
      } catch {
        vars = {};
      }
    } else if (rec?.plain) {
      vars = rec.plain;
    }
    cache.set(k, vars);
  }
  return { ...cache.get(k) };
}

function update(dir, { set = {}, remove = [] } = {}) {
  if (!dir) throw new Error('Önce proje klasörünü seçin.');
  const vars = get(dir);
  for (const n of remove || []) delete vars[n];
  for (const [rawName, v] of Object.entries(set || {})) {
    const name = String(rawName).trim();
    if (!envfile.NAME_RE.test(name)) throw new Error(`Geçersiz değişken adı: "${name}". Harf, rakam ve _ kullanın; rakamla başlamasın.`);
    if (v == null) continue;
    vars[name] = String(v);
  }
  const all = readAll();
  const k = keyOf(dir);
  if (!Object.keys(vars).length) delete all[k];
  else if (encrypted()) all[k] = { enc: safeStorage.encryptString(JSON.stringify(vars)).toString('base64'), updatedAt: Date.now() };
  else all[k] = { plain: vars, updatedAt: Date.now() };
  writeAll(all);
  cache.set(k, vars);
  version++;
  return vars;
}

function mask(v) {
  const s = String(v ?? '');
  if (!s) return '(boş)';
  if (s.length <= 10) return '•'.repeat(Math.min(s.length, 8));
  return `${s.slice(0, 3)}••••${s.slice(-2)}`;
}

function appDirs(dir) {
  const app = project.nodeApp(dir);
  return [dir, app && path.resolve(app.appDir) !== path.resolve(dir) ? app.appDir : null].filter(Boolean);
}

const hasManifest = (dir) => appDirs(dir).some((d) => MANIFESTS.some((f) => fs.existsSync(path.join(d, f))));

function example(dir) {
  const exFile = envfile.findExample(appDirs(dir));
  if (!exFile) return { file: null, vars: [] };
  try {
    return { file: path.relative(dir, exFile) || path.basename(exFile), vars: envfile.parseExample(fs.readFileSync(exFile, 'utf8')) };
  } catch {
    return { file: null, vars: [] };
  }
}

// Adlar ve eksikler (değer yok): ajan istemleri ve Gemini için.
function summary(dir) {
  const vars = get(dir);
  const ex = example(dir);
  return {
    names: Object.keys(vars).sort(),
    missing: ex.vars.filter((v) => v.needs && !(v.name in vars)).map((v) => v.name),
    exampleFile: ex.file,
  };
}

// Arayüz görünümü: projenin istedikleri (.env.example) + kullanıcının ekledikleri, değerler maskeli.
function view(dir) {
  if (!dir) throw new Error('Önce proje klasörünü seçin.');
  const vars = get(dir);
  const ex = example(dir);
  const exNames = new Set(ex.vars.map((v) => v.name));
  return {
    dir,
    exampleFile: ex.file,
    encrypted: encrypted(),
    projectReady: hasManifest(dir),
    required: ex.vars.map((v) => ({ ...v, set: v.name in vars, masked: v.name in vars ? mask(vars[v.name]) : '' })),
    extra: Object.keys(vars)
      .filter((n) => !exNames.has(n))
      .sort()
      .map((n) => ({ name: n, set: true, masked: mask(vars[n]) })),
  };
}

// .gitignore .env ve .env*.local dosyalarını kapsamıyorsa ekler (değerler asla commit'lenmesin).
function ensureIgnored(dir) {
  const gi = path.join(dir, '.gitignore');
  let text = '';
  try {
    text = fs.readFileSync(gi, 'utf8');
  } catch {
    /* yok */
  }
  const has = (re) => re.test(text);
  const all = has(/^\s*\/?\.env\*\s*$/m);
  const add = [];
  if (!all && !has(/^\s*\/?\.env\s*$/m)) add.push('.env');
  if (!all && !has(/^\s*\/?\.env(\*\.local|\.local|\*)\s*$/m)) add.push('.env*.local');
  if (add.length) fs.writeFileSync(gi, `${text.trimEnd()}${text.trim() ? '\n\n' : ''}# Sonda: gizli değerler\n${add.join('\n')}\n`);
}

/**
 * Değerleri projenin .env dosyasına yazar. Proje henüz iskelet almadıysa (package.json vb. yoksa)
 * yazmaz: bazı iskelet araçları (create-next-app) .env bulunan klasörü reddeder. Yazılan dosyaları döner.
 */
function sync(dir) {
  const vars = get(dir);
  if (!Object.keys(vars).length || !hasManifest(dir)) return [];
  ensureIgnored(dir);
  return envfile.writeEnvFiles(appDirs(dir), vars);
}

// Commit taraması için aranacak gizli parçalar (çok satırlı değerlerin uzun satırları dahil).
function needles(dir) {
  const out = new Set();
  for (const [k, v] of Object.entries(get(dir))) {
    if (!envfile.isSensitive(k, v)) continue;
    for (const line of v.split(/\r?\n/)) if (line.trim().length >= 12 || (!v.includes('\n') && line.length >= 6)) out.add(line.trim());
  }
  return [...out];
}

module.exports = { get, update, view, summary, sync, needles, mask, encrypted, version: () => version };
