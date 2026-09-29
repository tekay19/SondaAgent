// Ayarlar: userData/settings.json. Gemini API anahtarı işletim sisteminin
// anahtar zinciriyle (macOS Keychain / Windows DPAPI) şifrelenerek saklanır.
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const { DEFAULT_STANDARDS } = require('./prompts');

const DEFAULTS = {
  geminiModel: 'gemini-pro-latest',
  defaultAgent: 'claude',
  claudeModel: '',
  claudeEffort: 'high', // '' | low | medium | high | xhigh | max
  reviewEffort: 'medium', // derin inceleme oturumları için (hız)
  claudePermission: 'full', // full | safe
  claudePath: '',
  codexModel: '',
  codexPermission: 'full', // full | safe
  codexPath: '',
  maxFixAttempts: 2,
  finalFixAttempts: 3,
  verifyEachTask: true,
  visualTest: true,
  autoApprove: false,
  planSelfReview: true,
  taskBriefing: true,
  securityReview: true,
  reviewPanel: true, // faz sonlarında ve teslimde Claude uzman paneli (güvenlik, iş kuralları, mimari/test) + Claude doğrulayıcı
  reviewLevel: 'deep', // standard | deep | max
  planner: 'claude', // claude: Claude mühendis planlar, Gemini yönetici onaylar | gemini: Gemini planlar, Claude eleştirir
  tddMode: false,
  claudeAllowMcp: false,
  gitCommit: true,
  agentTimeoutMin: 90,
  strictPhaseGates: true,
  lastProjectDir: '',
  theme: 'system', // system | light | dark
  standards: '', // boşsa varsayılan senior mühendislik standartları kullanılır
};

let cache = null;

function file() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function load() {
  if (cache) return cache;
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    /* ilk açılış */
  }
  cache = { ...DEFAULTS, ...raw };
  return cache;
}

function persist() {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(cache, null, 2));
}

// API anahtarları yalnızca yazdırılabilir ASCII içerir; kopyala-yapıştırda gelen boşluk,
// satır sonu ve görünmez karakterleri temizle.
function cleanKey(key) {
  return String(key || '').replace(/[\s\u00A0\u200B-\u200D\u2060\uFEFF]/g, '');
}
const isValidKey = (key) => /^[\x21-\x7E]{10,}$/.test(key);

let keyInvalid = false;

function getGeminiKey() {
  const s = load();
  keyInvalid = false;
  let key = '';
  if (s.geminiKeyEnc && safeStorage.isEncryptionAvailable()) {
    try {
      key = cleanKey(safeStorage.decryptString(Buffer.from(s.geminiKeyEnc, 'base64')));
    } catch {
      key = '';
    }
  } else {
    key = cleanKey(s.geminiKeyPlain || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '');
  }
  // Çözülemeyen / bozuk kayıt (ör. eski sürümden taşınmış) hiç kullanılmasın; kullanıcıdan yeniden istenir.
  if (key && !isValidKey(key)) {
    keyInvalid = true;
    return '';
  }
  return key;
}

function keySource() {
  const s = load();
  if (s.geminiKeyEnc) return 'keychain';
  if (s.geminiKeyPlain) return 'file';
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY ? 'env' : null;
}

function mask(key) {
  if (!key) return '';
  return key.length <= 10 ? '••••' : `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

// Ana süreç için tam ayarlar (anahtar dahil).
function get() {
  return { ...load(), geminiKey: getGeminiKey() };
}

// Arayüze gönderilen ayarlar: ham anahtar yerine maskelenmiş hali.
function getPublic() {
  const { geminiKeyEnc, geminiKeyPlain, ...rest } = load();
  const key = getGeminiKey();
  return { ...rest, hasGeminiKey: !!key, geminiKeyInvalid: keyInvalid, geminiKeyMasked: mask(key), geminiKeySource: keySource(), defaultStandards: DEFAULT_STANDARDS };
}

function save(patch = {}) {
  const s = load();
  const { geminiKey, clearGeminiKey, hasGeminiKey, geminiKeyInvalid, geminiKeyMasked, geminiKeySource, defaultStandards, ...rest } = patch;
  for (const [k, v] of Object.entries(rest)) {
    if (k in DEFAULTS) s[k] = v;
  }
  if (clearGeminiKey) {
    delete s.geminiKeyEnc;
    delete s.geminiKeyPlain;
  } else if (typeof geminiKey === 'string' && cleanKey(geminiKey)) {
    const key = cleanKey(geminiKey);
    if (!isValidKey(key)) throw new Error('Gemini API anahtarı geçersiz karakter içeriyor. Anahtarı AI Studio\'dan tekrar kopyalayıp yapıştırın.');
    if (safeStorage.isEncryptionAvailable()) {
      s.geminiKeyEnc = safeStorage.encryptString(key).toString('base64');
      delete s.geminiKeyPlain;
    } else {
      s.geminiKeyPlain = key;
      delete s.geminiKeyEnc;
    }
  }
  s.maxFixAttempts = clampInt(s.maxFixAttempts, 0, 5, DEFAULTS.maxFixAttempts);
  s.finalFixAttempts = clampInt(s.finalFixAttempts, 0, 6, DEFAULTS.finalFixAttempts);
  if (typeof s.standards === 'string' && s.standards.trim() === DEFAULT_STANDARDS.trim()) s.standards = '';
  s.agentTimeoutMin = clampInt(s.agentTimeoutMin, 5, 240, DEFAULTS.agentTimeoutMin);
  persist();
  return getPublic();
}

function clampInt(v, min, max, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

module.exports = { get, getPublic, save, DEFAULTS };
