// Proje başına ortam değişkenleri (.env değerleri). Değerler işletim sisteminin anahtar zinciriyle
// (macOS Keychain / Windows DPAPI) şifrelenip userData/secrets.json'da saklanır.
// Arayüze ham değer gönderilmez (yalnızca maskeli hali); ajan istemlerine ve Gemini'ye yalnızca adlar gider.
// Değerleri projenin .env dosyasına Sonda yazar.
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const envfile = require('./envfile');
const project = require('./project');
const { writeFileAtomic, readStore } = require('./fsx');

const MANIFESTS = ['package.json', 'pyproject.toml', 'requirements.txt', 'go.mod', 'Cargo.toml', 'composer.json', 'Gemfile', 'pom.xml', 'build.gradle', 'deno.json'];

const file = () => path.join(app.getPath('userData'), 'secrets.json');
const keyOf = (dir) => path.resolve(String(dir || ''));
const cache = new Map();
const unreadable = new Set(); // şifresi çözülemeyen kayıtlar (anahtar zinciri erişimi reddedildi vb.)
let version = 0;

// Bozuk dosya kenara alınır (bkz. fsx.readStore): üzerine yazılıp diğer projelerin değerleri silinmez.
function readAll() {
  return readStore(file()) || {};
}

function writeAll(data) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  writeFileAtomic(file(), JSON.stringify(data, null, 2), { mode: 0o600 });
}

const encrypted = () => safeStorage.isEncryptionAvailable();

function get(dir) {
  if (!dir) return {};
  const k = keyOf(dir);
  if (!cache.has(k)) {
    let vars = {};
    let rec = null;
    unreadable.delete(k);
    try {
      rec = readAll()[k];
    } catch {
      // Depo dosyası okunamadı (izin, disk hatası): değerler yok sayılır, kayıt üzerine yazılmaz (bkz. update).
      unreadable.add(k);
    }
    if (rec?.enc) {
      try {
        vars = JSON.parse(safeStorage.decryptString(Buffer.from(rec.enc, 'base64')));
      } catch {
        // Çözülemedi: değerler yok sayılır ama kayıt silinmez (bkz. update).
        vars = {};
        unreadable.add(k);
      }
    } else if (rec?.plain && typeof rec.plain === 'object') {
      vars = rec.plain;
    }
    cache.set(k, vars);
  }
  return { ...cache.get(k) };
}

function update(dir, { set = {}, remove = [] } = {}) {
  if (!dir) throw new Error('Önce proje klasörünü seçin.');
  const vars = get(dir);
  const k = keyOf(dir);
  // Kayıtlı değerler okunamıyorken üzerine yazmak hepsini sessizce silerdi.
  if (unreadable.has(k)) {
    cache.delete(k);
    throw new Error('Bu projenin kayıtlı değerleri şu anda okunamıyor (anahtar deposu dosyası ya da işletim sisteminin anahtar zinciri okunamadı). Uygulamayı yeniden açıp tekrar deneyin; kayıtlı değerler korunuyor.');
  }
  const dirs = appDirs(dir);
  const removed = [];
  for (const n of remove || []) {
    if (n in vars) removed.push(n);
    delete vars[n];
  }
  for (const [rawName, v] of Object.entries(set || {})) {
    const name = String(rawName).trim();
    if (!envfile.NAME_RE.test(name)) throw new Error(`Geçersiz değişken adı: "${name}". Harf, rakam ve _ kullanın; rakamla başlamasın.`);
    if (v == null) continue;
    const value = String(v);
    const bad = dirs.find((d) => !envfile.representable(value, { escapeDollar: envfile.expandsDollar(d), dialect: envfile.dialectOf(d) }));
    if (bad) throw new Error(`${name}: bu değer .env dosyasına bozulmadan yazılamıyor (tek tırnak, çift tırnak ve ters tırnağı birlikte içeriyor). Değeri bu üç karakterden en az biri olmadan yeniden üretin.`);
    vars[name] = value;
  }
  const all = readAll();
  if (!Object.keys(vars).length) delete all[k];
  else all[k] = record(vars);
  writeAll(all);
  cache.set(k, vars);
  version++;
  // Sonda'dan silinen anahtar projenin .env dosyalarından da kalkar (değer diskte unutulmasın).
  const gone = removed.filter((n) => !(n in vars));
  if (gone.length) envfile.removeFromEnvFiles(dirs, gone);
  return vars;
}

// Şifreleme yoksa (anahtar zinciri kullanılamıyor) değerler yalnızca sahibine açık dosyada düz durur; şifreleme
// kullanılabilir olunca migratePlain onları şifreler.
function record(vars) {
  return encrypted() ? { enc: safeStorage.encryptString(JSON.stringify(vars)).toString('base64'), updatedAt: Date.now() } : { plain: vars, updatedAt: Date.now() };
}

/** Düz saklanmış kayıtları şifreler (uygulama açılışında; şifreleme o an kullanılabiliyorsa). Şifrelenen kayıt sayısı. */
function migratePlain() {
  if (!encrypted()) return 0;
  const all = readAll();
  let n = 0;
  for (const [k, rec] of Object.entries(all)) {
    if (rec?.plain && typeof rec.plain === 'object' && !rec.enc) {
      all[k] = record(rec.plain);
      n++;
    }
  }
  if (n) writeAll(all);
  return n;
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

// Projenin .env dosyalarında tanımlı tüm değişken adları (değerler alınmaz).
function presentNames(dir) {
  const names = new Set();
  for (const d of appDirs(dir)) {
    for (const f of envfile.TARGETS) {
      try {
        for (const k of Object.keys(envfile.parseEnv(fs.readFileSync(path.join(d, f), 'utf8')))) names.add(k);
      } catch {
        /* dosya yok */
      }
    }
  }
  return [...names].sort();
}

// Adlar ve eksikler (değer yok): ajan istemleri ve Gemini için.
function summary(dir) {
  const vars = get(dir);
  const ex = example(dir);
  return {
    names: Object.keys(vars).sort(),
    missing: ex.vars.filter((v) => v.needs && !(v.name in vars)).map((v) => v.name),
    present: presentNames(dir),
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
    unreadable: unreadable.has(keyOf(dir)),
    projectReady: hasManifest(dir),
    required: ex.vars.map((v) => ({ ...v, set: v.name in vars, masked: v.name in vars ? mask(vars[v.name]) : '' })),
    extra: Object.keys(vars)
      .filter((n) => !exNames.has(n))
      .sort()
      .map((n) => ({ name: n, set: true, masked: mask(vars[n]) })),
  };
}

/**
 * Değerleri projenin .env dosyasına yazar. Proje henüz iskelet almadıysa (package.json vb. yoksa)
 * yazmaz: bazı iskelet araçları (create-next-app) .env bulunan klasörü reddeder. Yazılan dosyaları döner.
 */
function sync(dir) {
  const vars = get(dir);
  if (!Object.keys(vars).length || !hasManifest(dir)) return [];
  project.ensureGitignore(dir); // .env ve .env*.local commit'e girmesin
  return envfile.writeEnvFiles(appDirs(dir), vars);
}

/**
 * Doğrulama kapısı için yerel .env'yi tamamlar (bkz. envfile.fillLocalEnv). Proje henüz iskelet almadıysa dokunmaz.
 * Dönen: null | { file, created, generated, added } (değer yok, yalnızca adlar).
 */
function ensureLocalEnv(dir) {
  if (!dir || !hasManifest(dir)) return null;
  const r = envfile.fillLocalEnv(appDirs(dir), get(dir));
  if (r && (r.created || r.added.length)) {
    project.ensureGitignore(dir); // .env commit'e girmesin
    version++; // üretilen sırlar maskeleyiciye ve taramaya girsin (bkz. sensitive)
  }
  return r;
}

// Sonda'nın projenin .env dosyalarına kendi ürettiği sırlar (yönetici parolası, oturum sırrı…).
function generated(dir) {
  const out = {};
  for (const d of appDirs(dir)) {
    for (const f of envfile.TARGETS) {
      try {
        Object.assign(out, envfile.generatedSecrets(envfile.parseEnv(fs.readFileSync(path.join(d, f), 'utf8'))));
      } catch {
        /* dosya yok */
      }
    }
  }
  return out;
}

// Gerçekten gizli olan değerler: kullanıcının girdikleri ve Sonda'nın ürettikleri. Projenin .env.example dosyasındaki
// örnek değerle aynı olan bir değer (ör. yerel geliştirme veritabanı adresi) zaten depoda açıkça durur; gizli sayılmaz.
function sensitive(dir) {
  const examples = new Map(example(dir).vars.map((v) => [v.name, v.example]));
  const user = Object.fromEntries(Object.entries(get(dir)).filter(([k, v]) => envfile.isSensitive(k, v) && examples.get(k) !== v));
  return { ...generated(dir), ...user };
}

// Commit ve zip taramasında aranacak gizli parçalar (çok satırlı değerlerin uzun satırları dahil).
const needles = (dir) => envfile.needlesOf(sensitive(dir));

module.exports = { get, update, view, summary, sync, ensureLocalEnv, sensitive, needles, mask, encrypted, migratePlain, version: () => version };
