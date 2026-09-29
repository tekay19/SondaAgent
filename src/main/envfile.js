// .env dosyası yardımcıları (Electron'dan bağımsız, test edilebilir).
// Kullanıcının girdiği değerleri projenin .env dosyasına Sonda yazar; ajanlar yalnızca adları bilir.
const fs = require('fs');
const path = require('path');

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;
const EXAMPLE_FILES = ['.env.example', '.env.sample', '.env.template', '.env.dist'];
const HEADER = '# --- Sonda: kullanıcının girdiği değerler (Sonda Agent > Anahtarlar) ---';
const SECRET_NAME = /(KEY|SECRET|TOKEN|PASS|PASSWD|PRIVATE|CREDENTIAL|AUTH|SID|DSN|SIGNING|SALT|COOKIE|SESSION|WEBHOOK|DATABASE_URL|CONNECTION|PHONE)/i;
// Değerlerin yazıldığı dosyalar: .env her zaman; .env.local ve .env.development.local varsa onlar da
// (Next.js / Vite bunları .env'den önce okur; eski bir yer tutucu değer gerçek değeri gölgelemesin).
// Genelde commit'lenen .env.development / .env.production'a gizli değer yazılmaz.
const TARGETS = ['.env', '.env.local', '.env.development.local'];

// Değer ve satır sonu yorumu: KEY="a b"   # açıklama  →  { value: 'a b', comment: 'açıklama' }
function splitValue(raw) {
  const v = String(raw || '').trim();
  const q = v[0];
  if (q === '"' || q === "'" || q === '`') {
    let i = 1;
    while (i < v.length && !(v[i] === q && v[i - 1] !== '\\')) i++;
    if (i < v.length) {
      let value = v.slice(1, i);
      if (q === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\$/g, '$').replace(/\\\\/g, '\\');
      const rest = v.slice(i + 1).trim();
      return { value, comment: rest.startsWith('#') ? rest.replace(/^#+\s*/, '') : '' };
    }
  }
  const m = v.match(/^(.*?)\s+#\s*(.*)$/);
  return m ? { value: m[1].trim(), comment: m[2].trim() } : { value: v, comment: '' };
}
const unquote = (raw) => splitValue(raw).value;

/** "KEY=value" satırlarını nesneye çevirir (yorumlar ve boş satırlar atlanır). */
function parseEnv(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(LINE_RE);
    if (m) out[m[1]] = unquote(m[2]);
  }
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
      const needs = !optional && (PLACEHOLDER.test(value) || (SECRET_NAME.test(m[1]) && !/^(true|false|\d+)$/i.test(value)));
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

function serializeValue(value, { escapeDollar = false } = {}) {
  let v = String(value ?? '');
  const needsQuotes = /[\s#"'`\\]|^$/.test(v) || v.includes('\n') || (escapeDollar && v.includes('$'));
  if (!needsQuotes) return v;
  v = v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n');
  if (escapeDollar) v = v.replace(/\$/g, '\\$');
  return `"${v}"`;
}

/** Mevcut .env metninde verilen anahtarları günceller, olmayanları Sonda bölümüne ekler; diğer satırlara dokunmaz. */
function upsertEnv(text, vars, opts = {}) {
  const lines = String(text || '').split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const pending = new Map(Object.entries(vars));
  const out = lines.map((line) => {
    const m = line.match(LINE_RE);
    if (!m || !pending.has(m[1])) return line;
    const v = pending.get(m[1]);
    pending.delete(m[1]);
    return `${m[1]}=${serializeValue(v, opts)}`;
  });
  if (pending.size) {
    if (!out.includes(HEADER)) {
      if (out.length && out[out.length - 1].trim()) out.push('');
      out.push(HEADER);
    }
    const at = out.indexOf(HEADER) + 1;
    let end = at;
    while (end < out.length && out[end].match(LINE_RE)) end++;
    out.splice(end, 0, ...[...pending].map(([k, v]) => `${k}=${serializeValue(v, opts)}`));
  }
  return `${out.join('\n')}\n`;
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

/** Değerleri projenin .env dosyalarına yazar. Değişen dosya yollarını döner. */
function writeEnvFiles(dirs, vars) {
  const written = [];
  if (!Object.keys(vars).length) return written;
  for (const d of [...new Set(dirs.map((x) => path.resolve(x)))]) {
    const escapeDollar = expandsDollar(d);
    for (const name of TARGETS) {
      const file = path.join(d, name);
      const exists = fs.existsSync(file);
      if (!exists && name !== '.env') continue;
      const text = exists ? fs.readFileSync(file, 'utf8') : '';
      const next = upsertEnv(text, vars, { escapeDollar });
      if (next !== text) {
        fs.writeFileSync(file, next, { mode: 0o600 });
        try {
          fs.chmodSync(file, 0o600); // yalnızca sahibi okuyabilsin (var olan dosyalar dahil)
        } catch {
          /* Windows */
        }
        written.push(file);
      }
    }
  }
  return written;
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

// Değer gizli mi? Ada (…_KEY, …_TOKEN, …_PASSWORD) ve değerin biçimine (kimlik bilgili URL,
// telefon, e-posta, rastgele görünen uzun dizi) bakılır. PORT=3000, NODE_ENV gibi ayarlar gizli değildir.
function isSensitive(name, value) {
  if (typeof value !== 'string' || value.length < 6) return false;
  if (/^(true|false|null|yes|no|on|off|development|production|test|debug|info|warn|error)$/i.test(value)) return false;
  if (/^\d{1,6}$/.test(value)) return false;
  if (SECRET_NAME.test(name)) return true;
  if (/:\/\/[^/\s]*@/.test(value)) return true;
  if (/^\+?\d[\d\s-]{7,}$/.test(value) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return true;
  return value.length >= 20 && /[A-Za-z]/.test(value) && /\d/.test(value) && !/\s/.test(value) && !/^https?:\/\//.test(value);
}

// Gizli değerleri metinden ayıklar (Gemini'ye giden metin, loglar).
function makeRedactor(vars) {
  const pairs = Object.entries(vars || {})
    .filter(([k, v]) => isSensitive(k, v))
    .sort((a, b) => b[1].length - a[1].length);
  if (!pairs.length) return (s) => s;
  return (s) => {
    if (typeof s !== 'string' || !s) return s;
    let out = s;
    for (const [k, v] of pairs) if (out.includes(v)) out = out.split(v).join(`‹gizli:${k}›`);
    return out;
  };
}

module.exports = { NAME_RE, HEADER, TARGETS, parseEnv, parseExample, splitValue, serializeValue, upsertEnv, findExample, writeEnvFiles, basicAuthCreds, isSensitive, makeRedactor, expandsDollar };
