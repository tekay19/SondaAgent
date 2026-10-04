// .env dosyası yardımcıları (Electron'dan bağımsız, test edilebilir).
// Kullanıcının girdiği değerleri projenin .env dosyasına Sonda yazar; ajanlar yalnızca adları bilir.
// Okuma ve yazma kuralları `dotenv` (Node) ile birebir aynıdır: Next.js, Vite ve Prisma dosyayı onunla okur.
const fs = require('fs');
const path = require('path');

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;
// Bir atama ve kapladığı alan (tırnaklı değerler birden çok satıra yayılabilir — dotenv ile aynı kural).
// 1: girinti + "export", 2: ad, 3: değer (tırnaklarıyla), 4: satır sonu yorumu.
const ASSIGN_RE = /^([ \t]*(?:export[ \t]+)?)([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*('(?:\\'|[^'])*'|"(?:\\"|[^"])*"|`(?:\\`|[^`])*`|[^#\r\n]*)?([ \t]*(?:#.*)?)$/gm;
const EXAMPLE_FILES = ['.env.example', '.env.sample', '.env.template', '.env.dist'];
const HEADER = '# --- Sonda: kullanıcının girdiği değerler (Sonda Agent > Anahtarlar) ---';
// Değerlerin yazıldığı dosyalar: .env her zaman; .env.local ve .env.development.local varsa onlar da
// (Next.js / Vite bunları .env'den önce okur; eski bir yer tutucu değer gerçek değeri gölgelemesin).
// Genelde commit'lenen .env.development / .env.production'a gizli değer yazılmaz.
const TARGETS = ['.env', '.env.local', '.env.development.local'];

// Ham değeri dotenv gibi çözer: baştaki ve sondaki aynı tırnak atılır; yalnızca çift tırnakta \n ve \r açılır.
function unquote(raw) {
  let v = String(raw ?? '').trim();
  const q = v[0];
  if (v.length >= 2 && (q === '"' || q === "'" || q === '`') && v.endsWith(q)) {
    v = v.slice(1, -1);
    if (q === '"') v = v.replace(/\\n/g, '\n').replace(/\\r/g, '\r');
  }
  return v;
}

// Tek satırlık değer ve satır sonu yorumu: KEY="a b"   # açıklama  →  { value: 'a b', comment: 'açıklama' }
function splitValue(raw) {
  const v = String(raw || '').trim();
  const q = v[0];
  if (q === '"' || q === "'" || q === '`') {
    let i = 1;
    while (i < v.length && !(v[i] === q && v[i - 1] !== '\\')) i++;
    if (i < v.length) {
      const rest = v.slice(i + 1).trim();
      return { value: unquote(v.slice(0, i + 1)), comment: rest.startsWith('#') ? rest.replace(/^#+\s*/, '') : '' };
    }
  }
  const m = v.match(/^(.*?)\s+#\s*(.*)$/);
  return m ? { value: m[1].trim(), comment: m[2].trim() } : { value: v, comment: '' };
}

/** .env metnini nesneye çevirir (yorumlar ve boş satırlar atlanır; çok satırlı tırnaklı değerler desteklenir). */
function parseEnv(text) {
  const out = {};
  for (const m of String(text || '').replace(/\r\n?/g, '\n').matchAll(ASSIGN_RE)) out[m[2]] = unquote(m[3]);
  return out;
}

const PLACEHOLDER = /x{3,}|your[_-]|change[_-]?me|<[^>]+>|\.\.\.|example\.(com|org)|placeholder|replace[_-]?me|todo|user:pass(word)?@|^sk_(test|live)_x|^\s*$/i;
const clip = (t, n) => (t.length > n ? `${t.slice(0, n).replace(/\s+\S*$/, '')}…` : t);

/**
 * .env.example içeriğinden projenin beklediği değişkenler: ad, bölüm ("# --- Veritabanı ---"),
 * açıklama (üstteki ya da satır sonundaki yorum), örnek değer, "# KEY=" ise isteğe bağlı olduğu ve
 * kullanıcıdan değer gerekip gerekmediği (örnek değer yer tutucuysa ya da ad gizli bir bilgiye aitse).
 */
function parseExample(text) {
  const vars = [];
  const seen = new Set();
  let comments = [];
  let section = '';
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      comments = [];
      continue;
    }
    const commented = line.match(/^#\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    const m = commented || line.match(LINE_RE);
    if (m) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      const { value, comment } = splitValue(m[2]);
      const hint = clip([...comments, comment].filter(Boolean).join(' '), 200);
      const optional = !!commented;
      const needs = !optional && (PLACEHOLDER.test(value) || (secretName(m[1]) && !TRIVIAL.test(value)));
      vars.push({ name: m[1], section, hint, example: value.slice(0, 120), optional, needs });
      comments = [];
      continue;
    }
    if (!line.startsWith('#')) continue;
    const c = line.replace(/^#+\s?/, '');
    const head = c.match(/^[-=*]{2,}\s*(.+?)\s*[-=*]{2,}\s*$/) || c.match(/^#+\s*(.+)$/);
    if (head) {
      section = clip(head[1], 60);
      comments = [];
    } else if (!/^[-=*\s]*$/.test(c)) {
      comments.push(c);
    }
  }
  return vars;
}

/**
 * Next.js / Vite / Prisma .env dosyalarında `$` değişken genişletmesi yapar (dotenv-expand);
 * bu projelerde `$` kaçışlanır. Düz dotenv kullanan projelerde kaçış karakteri değere karışacağı için kaçışlanmaz.
 */
function expandsDollar(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return ['next', 'vite', 'nuxt', 'dotenv-expand', '@next/env', 'prisma', '@remix-run/dev', 'astro'].some((d) => d in deps);
  } catch {
    return false;
  }
}

// Dosyayı kim okuyacak? Node projeleri `dotenv` ile; diğerleri (python-dotenv, docker compose, Ruby…)
// çift tırnak içinde \" \\ \n kaçışlarını açan ayrıştırıcılarla.
function dialectOf(dir) {
  return fs.existsSync(path.join(dir, 'package.json')) ? 'dotenv' : 'escaped';
}

/**
 * Değeri .env satırına yazılacak biçime çevirir; okunduğunda birebir aynı değer geri gelir.
 * dotenv çift tırnakta yalnızca \n ve \r açar — \" ve \\ açılmaz. Bu yüzden " ya da \ içeren değerler
 * (JSON kimlik bilgileri, Windows yolları, parolalar) içeriği aynen alınan tek tırnakla yazılır.
 */
function serializeValue(value, { escapeDollar = false, dialect = 'dotenv' } = {}) {
  const raw = String(value ?? '');
  const dollar = (s) => (escapeDollar ? s.replace(/\$/g, '\\$') : s);
  const multiline = /[\r\n]/.test(raw);
  if (raw !== '' && !multiline && !/[\s#"'`\\]/.test(raw) && !(escapeDollar && raw.includes('$'))) return raw;
  const oneLine = (s) => s.replace(/\r\n/g, '\n').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
  if (dialect !== 'dotenv') return `"${dollar(oneLine(raw.replace(/\\/g, '\\\\').replace(/"/g, '\\"')))}"`;
  if (!raw.includes('"') && !raw.includes('\\')) return `"${dollar(oneLine(raw))}"`;
  if (!raw.includes("'")) return `'${dollar(raw)}'`;
  if (!raw.includes('`')) return `\`${dollar(raw)}\``;
  // Üç tırnak türünü de içeren değer: tırnaksız yazılabiliyorsa öyle; değilse en az zararlı biçim.
  if (!multiline && !raw.includes('#') && raw === raw.trim() && !(/^['"`]/.test(raw) && raw.endsWith(raw[0]))) return dollar(raw);
  return `"${dollar(oneLine(raw))}"`;
}

// Değer .env'ye yazılıp okunduğunda aynen geri geliyor mu? (dotenv'de üç tırnak türünü ve # / satır sonu /
// kenar boşluğunu birlikte içeren bir değer hiçbir biçimde yazılamaz; sessizce bozmak yerine kullanıcıya söylenir.)
function representable(value, opts = {}) {
  if (opts.dialect && opts.dialect !== 'dotenv') return true; // kaçışları açan ayrıştırıcılar her değeri okuyabilir
  const back = parseEnv(`X=${serializeValue(value, opts)}`).X;
  return (opts.escapeDollar ? String(back).replace(/\\\$/g, '$') : back) === String(value ?? '').replace(/\r\n/g, '\n');
}

/**
 * Mevcut .env metninde verilen anahtarları günceller, olmayanları Sonda bölümüne ekler; diğer satırlara
 * (yorumlar, boş satırlar, başka değişkenler, "export" ön eki, satır sonu yorumları) dokunmaz.
 */
function upsertEnv(text, vars, opts = {}) {
  const seen = new Set();
  let body = String(text || '').replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  // Aynı ad dosyada birden çok kez geçiyorsa hepsi güncellenir (dotenv'de son satır kazanır; eski değer gölgelemesin).
  body = body.replace(ASSIGN_RE, (all, pre, name, _value, comment) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) return all;
    seen.add(name);
    const note = (comment || '').trim();
    return `${pre}${name}=${serializeValue(vars[name], opts)}${note ? ` ${note}` : ''}`;
  });
  const pending = Object.entries(vars).filter(([k]) => !seen.has(k));
  if (pending.length) {
    const lines = body ? body.split('\n') : [];
    const added = pending.map(([k, v]) => `${k}=${serializeValue(v, opts)}`);
    let at = lines.indexOf(HEADER);
    if (at < 0) {
      if (lines.length && lines[lines.length - 1].trim()) lines.push('');
      lines.push(HEADER, ...added);
    } else {
      // Sonda bölümünün sonu: başlıktan sonraki ilk boş satır (çok satırlı değerler bölünmez).
      let end = at + 1;
      while (end < lines.length && lines[end].trim()) end++;
      lines.splice(end, 0, ...added);
    }
    body = lines.join('\n');
  }
  return `${body}\n`;
}

/** Verilen anahtarların satırlarını .env metninden siler (Sonda bölümü boş kalırsa başlığı da). */
function removeFromEnv(text, names) {
  const drop = new Set(names || []);
  if (!drop.size) return String(text || '');
  const MARK = '\u0000sonda-removed\u0000';
  const body = String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(ASSIGN_RE, (all, _pre, name) => (drop.has(name) ? MARK : all));
  const lines = body.split('\n').filter((l) => l !== MARK);
  const at = lines.indexOf(HEADER);
  if (at >= 0 && (at + 1 >= lines.length || !lines[at + 1].trim())) {
    lines.splice(at, 1);
    if (at > 0 && !lines[at - 1].trim() && (at >= lines.length || !lines[at].trim())) lines.splice(at - 1, 1);
  }
  const out = lines.join('\n').replace(/\n+$/, '');
  return out ? `${out}\n` : '';
}

/** Projenin .env.example (ya da benzeri) dosyasını bulur: kök ve (varsa) uygulama klasörü. */
function findExample(dirs) {
  for (const d of dirs) {
    for (const f of EXAMPLE_FILES) {
      const p = path.join(d, f);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function writePrivate(file, text) {
  fs.writeFileSync(file, text, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600); // yalnızca sahibi okuyabilsin (var olan dosyalar dahil)
  } catch {
    /* Windows */
  }
}

/** Değerleri projenin .env dosyalarına yazar. Değişen dosya yollarını döner. */
function writeEnvFiles(dirs, vars) {
  const written = [];
  if (!Object.keys(vars).length) return written;
  for (const d of [...new Set(dirs.map((x) => path.resolve(x)))]) {
    const opts = { escapeDollar: expandsDollar(d), dialect: dialectOf(d) };
    for (const name of TARGETS) {
      const file = path.join(d, name);
      const exists = fs.existsSync(file);
      if (!exists && name !== '.env') continue;
      const text = exists ? fs.readFileSync(file, 'utf8') : '';
      const next = upsertEnv(text, vars, opts);
      if (next !== text) {
        writePrivate(file, next);
        written.push(file);
      }
    }
  }
  return written;
}

// Uygulamanın KENDİ gizli değerleri: yerel geliştirmede rastgele üretilebilir (oturum / çerez / JWT sırrı, yönetici parolası).
// Üçüncü taraf anahtarları (OPENAI_API_KEY, *_CLIENT_SECRET…) üretilemez: boş kalır, kullanıcıdan istenir.
// APP_KEY / ENCRYPTION_KEY gibi biçimi belirli (base64, tam 32 bayt) anahtarlar bilerek yok.
const OWN_SECRET = /^(?:ADMIN_PASSWORD|(?:[A-Z0-9]+_)*(?:SESSION|COOKIE|JWT|CSRF|NEXTAUTH|AUTH)_SECRET|SECRET_KEY(?:_BASE)?)$/;
const randomHex = (name) => require('crypto').randomBytes(name === 'ADMIN_PASSWORD' ? 16 : 32).toString('hex');

/**
 * Yerel geliştirme .env'sini tamamlar. Doğrulama kapısı servisleri (docker compose, veritabanı) kurar ve bunlar .env ister;
 * Sonda ise .env'ye yalnızca kullanıcının girdiği değerleri yazar, projenin .env.example varsayılanlarını yazmazdı.
 *  - .env yoksa: .env.example'ın kopyası (yorumlar ve varsayılanlar korunur) + kullanıcının değerleri + uygulamanın kendi
 *    sırlarından boş kalanlar için rastgele değerler.
 *  - .env varsa: yalnızca EKSİK değişkenler (varsayılanı olanlar, kullanıcı değerleri, üretilebilen sırlar) eklenir.
 * Var olan hiçbir satıra dokunulmaz. Değerler hiçbir yere döndürülmez, yalnızca adları. Dönen: null (örnek dosya yok) |
 * { file, created, generated: [ad], added: [ad] }
 */
function fillLocalEnv(dirs, userVars = {}, rnd = randomHex) {
  const exFile = findExample(dirs);
  if (!exFile) return null;
  const exampleText = fs.readFileSync(exFile, 'utf8');
  const dir = path.dirname(exFile);
  const target = path.join(dir, '.env');
  const exists = fs.existsSync(target);
  const current = exists ? parseEnv(fs.readFileSync(target, 'utf8')) : {};
  const defaults = parseEnv(exampleText);
  const add = {};
  const generated = [];
  for (const v of parseExample(exampleText)) {
    if (v.optional || v.name in current) continue;
    let value = userVars[v.name];
    const blank = !defaults[v.name] || v.needs;
    if (value === undefined && blank && OWN_SECRET.test(v.name)) {
      value = rnd(v.name);
      generated.push(v.name);
    }
    if (value === undefined && exists && !blank) value = defaults[v.name]; // dosya varsa: örnekteki varsayılan eksik satıra eklenir
    if (value !== undefined) add[v.name] = value;
  }
  // Kullanıcının örnekte olmayan değerleri de (yeni dosyada) yazılır.
  if (!exists) for (const [k, v] of Object.entries(userVars)) if (!(k in add) && !(k in defaults)) add[k] = v;
  if (exists && !Object.keys(add).length) return { file: target, created: false, generated: [], added: [] };
  const opts = { escapeDollar: expandsDollar(dir), dialect: dialectOf(dir) };
  writePrivate(target, upsertEnv(exists ? fs.readFileSync(target, 'utf8') : exampleText, add, opts));
  return { file: target, created: !exists, generated, added: Object.keys(add) };
}

/** Kullanıcının Sonda'dan sildiği anahtarları projenin .env dosyalarından da kaldırır. Değişen dosyaları döner. */
function removeFromEnvFiles(dirs, names) {
  const changed = [];
  if (!names?.length) return changed;
  for (const d of [...new Set(dirs.map((x) => path.resolve(x)))]) {
    for (const name of TARGETS) {
      const file = path.join(d, name);
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const next = removeFromEnv(text, names);
      if (next !== text.replace(/\r\n?/g, '\n')) {
        writePrivate(file, next);
        changed.push(file);
      }
    }
  }
  return changed;
}

// Tarayıcı testinde Basic Auth korumalı sayfaları açabilmek için kullanıcı adı / parola çifti.
function basicAuthCreds(vars) {
  const names = Object.keys(vars);
  const pick = (re) => names.find((n) => re.test(n) && vars[n]);
  const user = pick(/BASIC_?AUTH_?(USER|USERNAME|LOGIN)$/i) || pick(/^(ADMIN|AUTH)_(USER|USERNAME)$/i);
  if (!user) return null;
  const prefix = user.replace(/(USER|USERNAME|LOGIN)$/i, '');
  const pass = names.find((n) => n.startsWith(prefix) && /(PASS|PASSWORD|PASSWD)$/i.test(n) && vars[n]);
  return pass ? { username: vars[user], password: vars[pass] } : null;
}

// ---------- gizlilik ----------
// Ad parçalarına (alt çizgiyle ayrılmış) bakılır, alt dizeye değil: NEXTAUTH_URL, SESSION_TTL, COOKIE_NAME,
// CACHE_KEY_PREFIX gizli değildir; NEXTAUTH_SECRET, SESSION_SECRET, STRIPE_API_KEY gizlidir.
const SECRET_ANYWHERE = new Set(['SECRET', 'SECRETS', 'PRIVATE', 'CREDENTIAL', 'CREDENTIALS']);
const SECRET_LAST = new Set(['KEY', 'APIKEY', 'TOKEN', 'PASS', 'PASSWORD', 'PASSWD', 'PWD', 'SALT']);
function secretName(name) {
  const parts = String(name || '').toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  return parts.some((p) => SECRET_ANYWHERE.has(p)) || SECRET_LAST.has(parts[parts.length - 1]);
}

const TRIVIAL = /^(true|false|null|none|yes|no|on|off|development|production|staging|test|debug|info|warn|error|localhost|\d{1,6})$/i;
// Rastgele görünen uzun dizi: büyük harf, küçük harf ve rakamı birlikte içeren 20+ karakter (anahtar, jeton, imza).
const tokenLike = (s) => (s.match(/[A-Za-z0-9_\-+/=]{20,}/g) || []).some((t) => /[a-z]/.test(t) && /[A-Z]/.test(t) && /\d/.test(t));

// Değer gizli mi? Ada (…_KEY, …_TOKEN, …_PASSWORD, …SECRET…) ve değerin biçimine (kimlik bilgili URL,
// telefon, e-posta, rastgele görünen uzun dizi) bakılır. PORT=3000, NODE_ENV, NEXTAUTH_URL=http://localhost:3000,
// DATABASE_URL=file:./dev.db gibi ayarlar gizli değildir.
function isSensitive(name, value) {
  if (typeof value !== 'string' || value.length < 6) return false;
  if (TRIVIAL.test(value)) return false;
  if (secretName(name)) return true;
  if (/:\/\/[^/\s@]+@/.test(value)) return true; // kullanıcı adı / parola içeren URL
  if (/^\+?\d[\d\s-]{7,}$/.test(value) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return tokenLike(value.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '')); // URL / yol: yalnızca gizli parçası varsa
  return !/\s/.test(value) && value.length >= 20 && /[A-Za-z]/.test(value) && /\d/.test(value);
}

const PEM_MARK = /^-----(BEGIN|END) [A-Z0-9 ]+-----$/;

// Bir gizli değerin metinlerde görülebileceği biçimler: ham hali, çok satırlı değerlerin uzun satırları
// (satır satır akan loglar), .env / JSON içindeki kaçışlı hali ve URL kodlanmış hali.
function variantsOf(value) {
  const out = new Set([value]);
  if (/[\r\n]/.test(value)) {
    for (const line of value.split(/\r?\n/)) {
      const t = line.trim();
      if (t.length >= 12 && !PEM_MARK.test(t)) out.add(t);
    }
    out.add(value.replace(/\r?\n/g, '\\n'));
  }
  const json = JSON.stringify(value).slice(1, -1);
  if (json !== value) out.add(json);
  try {
    const enc = encodeURIComponent(value);
    if (enc !== value) out.add(enc);
  } catch {
    /* geçersiz UTF-16 */
  }
  return [...out].filter((v) => v.length >= 6);
}

// Gizli değerleri metinden ayıklar (Gemini'ye giden metin, loglar).
function makeRedactor(vars) {
  const pairs = Object.entries(vars || {})
    .filter(([k, v]) => isSensitive(k, v))
    .flatMap(([k, v]) => variantsOf(v).map((variant) => [k, variant]))
    .sort((a, b) => b[1].length - a[1].length);
  if (!pairs.length) return (s) => s;
  return (s) => {
    if (typeof s !== 'string' || !s) return s;
    let out = s;
    for (const [k, v] of pairs) if (out.includes(v)) out = out.split(v).join(`‹gizli:${k}›`);
    return out;
  };
}

// Commit ve zip taramasında aranacak parçalar (çok satırlı değerlerin uzun satırları dahil).
function needlesOf(vars) {
  const out = new Set();
  for (const [k, v] of Object.entries(vars || {})) {
    if (!isSensitive(k, v)) continue;
    if (/[\r\n]/.test(v)) {
      for (const line of v.split(/\r?\n/)) {
        const t = line.trim();
        if (t.length >= 12 && !PEM_MARK.test(t)) out.add(t);
      }
    } else if (v.trim().length >= 8) {
      out.add(v.trim());
    }
  }
  return [...out];
}

module.exports = { NAME_RE, HEADER, TARGETS, OWN_SECRET, fillLocalEnv, parseEnv, parseExample, serializeValue, representable, upsertEnv, removeFromEnv, findExample, writeEnvFiles, removeFromEnvFiles, basicAuthCreds, isSensitive, makeRedactor, needlesOf, expandsDollar, dialectOf };
