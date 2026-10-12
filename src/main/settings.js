// Ayarlar: userData/settings.json. Gemini API anahtarı işletim sisteminin
// anahtar zinciriyle (macOS Keychain / Windows DPAPI) şifrelenerek saklanır.
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const { DEFAULT_STANDARDS } = require('./prompts');
const { DEFAULT_CLAUDE_MODEL, CLAUDE_MODELS, claudeModelOf, claudeModelLabel } = require('./models');
const { writeFileAtomic } = require('./fsx');

const DEFAULTS = {
  geminiModel: 'gemini-pro-latest',
  // "Yönetici" (ürün tanımı, plan onayı, son kabul, rapor) kim olsun: gemini | anthropic (Claude API anahtarı).
  // Kodlayan ve inceleyen Claude oturumları bundan bağımsızdır: onlar hep Claude CLI ve abonelikle çalışır.
  managerBy: 'gemini',
  // Yönetici işleri (onay, son kabul, rapor) için çok pahalı olmayan model; daha ucuzu: claude-haiku-4-5-20251001.
  anthropicModel: 'claude-sonnet-5-5',
  defaultAgent: 'claude',
  claudeModel: '', // boş = varsayılan (Opus 5.5); bkz. models.js
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
  freshCloneCheck: true, // faz kapılarında ve teslimde: proje yeni bir klonda sıfırdan kurulup test edilir
  autoApprove: false,
  planSelfReview: true,
  taskBriefing: true,
  securityReview: true,
  reviewPanel: true, // faz sonlarında ve teslimde Claude uzman paneli (güvenlik, iş kuralları, mimari/test) + Claude doğrulayıcı
  reviewLevel: 'deep', // standard | deep | max
  // Bağımsız denetim: her `auditEvery` görevde bir Claude bitmiş kodun tamamını kalan görevlerle birlikte denetler;
  // doğrulanan önerileri sonraki görevden önce uygulatır (bkz. orchestrator/audit.js).
  independentAudit: true,
  auditEvery: 3,
  planner: 'claude', // claude: Claude mühendis planlar, Gemini yönetici onaylar | gemini: Gemini planlar, Claude eleştirir
  // Gemini'nin rolü. manager: ürün tanımı, plan onayı ve teslim (son kabul + rapor) — yapım döngüsünü (brif, görev
  // incelemesi, hafıza, faz kapısı) ajanlar yürütür. full: Gemini her görevi ve fazı da inceler, hafızayı yazar.
  geminiRole: 'manager',
  // Teknik brifi kim yazar. fable: Claude Fable 5.1 (kodu gezerek) | coder: kodlama modeliyle Claude | gemini
  briefBy: 'fable',
  tddMode: false,
  claudeAllowMcp: false,
  gitCommit: true,
  agentTimeoutMin: 90,
  maxParallelJobs: 3, // aynı anda çalışabilecek iş sayısı (her iş ayrı klasörde)
  strictPhaseGates: true,
  lastProjectDir: '',
  theme: 'system', // system | light | dark
  standards: '', // boşsa varsayılan senior mühendislik standartları kullanılır
};

// Seçenekli ayarların geçerli değerleri: arayüzden (ya da elle düzenlenmiş dosyadan) gelen başka bir değer yok sayılır.
const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
const ENUMS = {
  defaultAgent: ['claude', 'codex'],
  claudeEffort: EFFORTS,
  reviewEffort: EFFORTS,
  claudePermission: ['full', 'safe'],
  codexPermission: ['full', 'safe'],
  reviewLevel: ['standard', 'deep', 'max'],
  planner: ['claude', 'gemini'],
  managerBy: ['gemini', 'anthropic'],
  geminiRole: ['manager', 'full'],
  briefBy: ['fable', 'coder', 'gemini'],
  theme: ['system', 'light', 'dark'],
};

// Bir ayar değerini varsayılanının tipine göre doğrular; geçersizse `undefined` (değer değişmez).
function sanitize(key, value) {
  const def = DEFAULTS[key];
  if (typeof def === 'boolean') return typeof value === 'boolean' ? value : undefined;
  if (typeof def === 'number') {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? n : undefined;
  }
  if (typeof value !== 'string') return undefined;
  if (ENUMS[key]) return ENUMS[key].includes(value) ? value : undefined;
  return key === 'standards' ? value : value.trim();
}

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
  cache = { ...DEFAULTS };
  for (const [k, v] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    if (k === 'geminiKeyEnc' || k === 'geminiKeyPlain' || k === 'anthropicKeyEnc' || k === 'anthropicKeyPlain') cache[k] = v;
    else if (k in DEFAULTS) {
      const clean = sanitize(k, v);
      if (clean !== undefined) cache[k] = clean;
    }
  }
  clampNumbers(cache);
  return cache;
}

function persist() {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  writeFileAtomic(file(), JSON.stringify(cache, null, 2), { mode: 0o600 });
}

function clampNumbers(s) {
  s.maxFixAttempts = clampInt(s.maxFixAttempts, 0, 5, DEFAULTS.maxFixAttempts);
  s.finalFixAttempts = clampInt(s.finalFixAttempts, 0, 6, DEFAULTS.finalFixAttempts);
  s.agentTimeoutMin = clampInt(s.agentTimeoutMin, 5, 240, DEFAULTS.agentTimeoutMin);
  s.maxParallelJobs = clampInt(s.maxParallelJobs, 1, 6, DEFAULTS.maxParallelJobs);
  s.auditEvery = clampInt(s.auditEvery, 1, 10, DEFAULTS.auditEvery);
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

let anthropicKeyInvalid = false;

// Yalnızca Sonda'ya girilen anahtar kullanılır; ANTHROPIC_API_KEY ortam değişkeni bilerek okunmaz (başka bir
// amaçla ayarlanmış bir anahtar sessizce ayrı faturalanmasın; ajanların ortamından da zaten ayıklanır).
function getAnthropicKey() {
  const s = load();
  anthropicKeyInvalid = false;
  let key = '';
  if (s.anthropicKeyEnc && safeStorage.isEncryptionAvailable()) {
    try {
      key = cleanKey(safeStorage.decryptString(Buffer.from(s.anthropicKeyEnc, 'base64')));
    } catch {
      key = '';
    }
  } else {
    key = cleanKey(s.anthropicKeyPlain || '');
  }
  if (key && !isValidKey(key)) {
    anthropicKeyInvalid = true;
    return '';
  }
  return key;
}

function anthropicKeySource() {
  const s = load();
  if (s.anthropicKeyEnc) return 'keychain';
  return s.anthropicKeyPlain ? 'file' : null;
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
  return { ...load(), geminiKey: getGeminiKey(), anthropicKey: getAnthropicKey() };
}

// Arayüze gönderilen ayarlar: ham anahtar yerine maskelenmiş hali.
function getPublic() {
  const { geminiKeyEnc, geminiKeyPlain, anthropicKeyEnc, anthropicKeyPlain, ...rest } = load();
  const key = getGeminiKey();
  const anthropicKey = getAnthropicKey();
  const model = claudeModelOf(rest);
  return {
    ...rest,
    hasGeminiKey: !!key,
    geminiKeyInvalid: keyInvalid,
    geminiKeyMasked: mask(key),
    geminiKeySource: keySource(),
    hasAnthropicKey: !!anthropicKey,
    anthropicKeyInvalid,
    anthropicKeyMasked: mask(anthropicKey),
    anthropicKeySource: anthropicKeySource(),
    defaultStandards: DEFAULT_STANDARDS,
    // Claude modeli: kullanılan model, varsayılan ve Ayarlar'daki seçenekler (arayüz bunları gösterir).
    claudeModelEffective: model,
    claudeModelLabel: claudeModelLabel(model),
    claudeDefaultModel: DEFAULT_CLAUDE_MODEL,
    claudeModels: CLAUDE_MODELS,
  };
}

function save(patch = {}) {
  const s = load();
  const { geminiKey, clearGeminiKey, anthropicKey, clearAnthropicKey, ...rest } = patch || {};
  for (const [k, v] of Object.entries(rest)) {
    if (!(k in DEFAULTS)) continue;
    const clean = sanitize(k, v);
    if (clean !== undefined) s[k] = clean;
  }
  // Varsayılan modelin kimliği açıkça yazıldıysa "varsayılan" olarak saklanır (varsayılan değişirse onu izler).
  if (s.claudeModel === DEFAULT_CLAUDE_MODEL) s.claudeModel = '';
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
  if (clearAnthropicKey) {
    delete s.anthropicKeyEnc;
    delete s.anthropicKeyPlain;
  } else if (typeof anthropicKey === 'string' && cleanKey(anthropicKey)) {
    const key = cleanKey(anthropicKey);
    if (!isValidKey(key)) throw new Error('Anthropic API anahtarı geçersiz karakter içeriyor. Anahtarı console.anthropic.com\'dan tekrar kopyalayıp yapıştırın.');
    if (safeStorage.isEncryptionAvailable()) {
      s.anthropicKeyEnc = safeStorage.encryptString(key).toString('base64');
      delete s.anthropicKeyPlain;
    } else {
      s.anthropicKeyPlain = key;
      delete s.anthropicKeyEnc;
    }
  }
  clampNumbers(s);
  if (typeof s.standards === 'string' && s.standards.trim() === DEFAULT_STANDARDS.trim()) s.standards = '';
  persist();
  return getPublic();
}

function clampInt(v, min, max, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

// Yönetici (Gemini ya da Claude API) kullanıma hazır mı: seçili sağlayıcının anahtarı var mı.
const managerReady = (s = get()) => (s.managerBy === 'anthropic' ? !!s.anthropicKey : !!s.geminiKey);
const managerMissingMessage = (s = get()) => (s.managerBy === 'anthropic' ? 'Anthropic API anahtarı yok. Ayarlar\'dan ekleyin.' : 'Gemini API anahtarı yok. Ayarlar\'dan ekleyin.');
// Günlük satırlarında sağlayıcı adını belirlemek için: anahtarı çözmeden yalnızca seçimi okur.
const managerBy = () => (load().managerBy === 'anthropic' ? 'anthropic' : 'gemini');

module.exports = { get, getPublic, save, managerReady, managerMissingMessage, managerBy };
