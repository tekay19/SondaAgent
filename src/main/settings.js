// Ayarlar: userData/settings.json. API anahtarları işletim sisteminin anahtar zinciriyle (macOS Keychain /
// Windows DPAPI) şifrelenerek saklanır.
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const { DEFAULT_STANDARDS } = require('./prompts');
const { DEFAULT_CLAUDE_MODEL, CLAUDE_MODELS, claudeModelOf, claudeModelLabel, roleModelOf } = require('./models');
const { writeFileAtomic, readStore } = require('./fsx');

const DEFAULTS = {
  // "Yönetici" (ürün tanımı, plan onayı, son kabul, rapor) kim olsun: claudecli (Claude Code CLI, abonelikle;
  // varsayılan — anahtar gerekmez) | anthropic (Claude API anahtarı) | local (bilgisayardaki OpenAI uyumlu sunucu:
  // Ollama, LM Studio, llama.cpp…) | nim (NVIDIA NIM API) | opencode (OpenCode CLI, kendi sağlayıcı anahtarlarıyla).
  // Kodlayan ve inceleyen Claude oturumları bundan bağımsızdır: onlar hep Claude CLI ve abonelikle çalışır.
  managerBy: 'claudecli',
  // Claude CLI yöneticisinin modeli; boşsa Modeller'deki kodlayıcı Claude modeli (Opus 5.5).
  managerClaudeModel: '',
  // Yönetici işleri (onay, son kabul, rapor) için çok pahalı olmayan model; daha ucuzu: claude-haiku-4-5-20251001.
  anthropicModel: 'claude-sonnet-5-5',
  // Yerel model sunucusu (OpenAI uyumlu): adres, model adı ve (sunucu isterse) anahtar.
  localBaseUrl: 'http://localhost:11434/v1',
  localModel: '',
  // NVIDIA NIM (build.nvidia.com) ya da başka bir harici OpenAI uyumlu API: adres, model ve anahtar (şifreli).
  nimBaseUrl: 'https://integrate.api.nvidia.com/v1',
  nimModel: '',
  // Codex NIM ile kodlarken rol başına NIM modeli (boş = nimModel): planlayıcı, kodlayıcı, inceleyici.
  nimPlannerModel: '',
  nimCoderModel: '',
  nimReviewerModel: '',
  defaultAgent: 'claude',
  claudeModel: '', // boş = varsayılan (Opus 5.5); bkz. models.js
  // Rol başına model (boş = Ajanlar'daki genel Claude modeli; brif için boş = briefBy'a göre Fable 5.1 / kodlama modeli).
  plannerModel: '',
  coderModel: '',
  reviewerModel: '',
  briefModel: '',
  claudeEffort: 'high', // '' | low | medium | high | xhigh | max
  reviewEffort: 'medium', // derin inceleme oturumları için (hız)
  claudePermission: 'full', // full | safe
  claudePath: '',
  // Kullanıcının kişisel Claude Code ayarları (~/.claude: CLAUDE.md, hafıza, eklentiler, hook'lar) ajan oturumlarına
  // yüklensin mi. Kapalı (varsayılan): her oturuma yalnızca projenin kendi CLAUDE.md'si girer; kişisel talimatlar
  // ve eklenti tanımları her oturumun bağlamına binlerce token ekliyor ve otonom işe karışabiliyordu.
  claudeUserSettings: false,
  codexModel: '',
  codexPermission: 'full', // full | safe
  codexPath: '',
  // Codex hangi sağlayıcıyla kodlasın: openai (hesap girişi) | local (codex --oss: Ollama / LM Studio) | nim (NVIDIA NIM API).
  codexProvider: 'openai',
  codexLocalProvider: 'ollama', // ollama | lmstudio
  // OpenCode: model "sağlayıcı/model" biçiminde (boş = OpenCode'un varsayılanı); salt okunur oturumlar için ayrı model.
  opencodeModel: '',
  opencodeReviewModel: '',
  // OpenCode yöneticisinin modeli (managerBy: opencode); boşsa kodlayıcı OpenCode modeli.
  opencodeManagerModel: '',
  opencodePath: '',
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
  planner: 'claude', // claude: Claude mühendis planlar, yönetici onaylar | manager: yönetici planlar, Claude eleştirir
  // Yöneticinin rolü. manager: ürün tanımı, plan onayı ve teslim (son kabul + rapor) — yapım döngüsünü (brif, görev
  // incelemesi, hafıza, faz kapısı) ajanlar yürütür. full: yönetici her görevi ve fazı da inceler, hafızayı yazar.
  managerRole: 'manager',
  // Teknik brifi kim yazar. fable: Claude Fable 5.1 (kodu gezerek) | coder: kodlama modeliyle Claude
  briefBy: 'fable',
  // Salt okunur oturumları (plan yazımı, brif, incelemeler, uzmanlar, doğrulama, hafıza) kim yapar: auto → Claude kuruluysa
  // Claude, değilse kodlayan ajan | agent → her zaman kodlayan ajan (Claude'suz çalışma: Codex + NIM / yerel model).
  reviewerBy: 'auto',
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
  defaultAgent: ['claude', 'codex', 'opencode'],
  claudeEffort: EFFORTS,
  reviewEffort: EFFORTS,
  claudePermission: ['full', 'safe'],
  codexPermission: ['full', 'safe'],
  codexLocalProvider: ['ollama', 'lmstudio'],
  codexProvider: ['openai', 'local', 'nim'],
  reviewLevel: ['standard', 'deep', 'max'],
  planner: ['claude', 'manager'],
  managerBy: ['claudecli', 'anthropic', 'local', 'nim', 'opencode'],
  managerRole: ['manager', 'full'],
  briefBy: ['fable', 'coder'],
  reviewerBy: ['auto', 'agent'],
  theme: ['system', 'light', 'dark'],
};

// Eski sürümlerin (Gemini'li) ayar dosyası: adlar ve değerler bugünkü karşılığına çevrilir, Gemini alanları atılır.
const LEGACY_KEYS = { geminiRole: 'managerRole' };
const LEGACY_VALUES = { managerBy: { gemini: 'claudecli' }, planner: { gemini: 'manager' }, briefBy: { gemini: 'fable' } };
const DROPPED_KEYS = new Set(['geminiModel', 'geminiKeyEnc', 'geminiKeyPlain', 'codexLocal']);

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
    raw = readStore(file()) || {}; // yoksa ilk açılış; bozuksa kenara alınır (anahtarlar yedek dosyada kalır)
  } catch {
    /* okunamadı: varsayılanlar */
  }
  cache = { ...DEFAULTS };
  for (let [k, v] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    if (k === 'codexLocal' && v === true && !raw.codexProvider) cache.codexProvider = 'local'; // eski onay kutusu
    if (DROPPED_KEYS.has(k)) continue;
    if (LEGACY_KEYS[k]) k = LEGACY_KEYS[k];
    if (LEGACY_VALUES[k] && typeof v === 'string' && LEGACY_VALUES[k][v]) v = LEGACY_VALUES[k][v];
    if (/^(anthropic|local|nim)Key(Enc|Plain)$/.test(k)) cache[k] = v;
    else if (k === 'projectStacks') {
      if (v && typeof v === 'object' && !Array.isArray(v)) cache.projectStacks = v;
    } else if (k in DEFAULTS) {
      const clean = sanitize(k, v);
      if (clean !== undefined) cache[k] = clean;
    }
  }
  normalize(cache);
  return cache;
}

// Boş bırakılınca çalışmayı bozacak alanlar varsayılanına döner (elle düzenlenmiş dosya ya da temizlenmiş form alanı):
// Claude API yöneticisinin modeli boşsa istek 400 ile düşerdi; sunucu adresleri boşsa istemci adres üretemezdi.
function normalize(s) {
  if (!String(s.anthropicModel || '').trim()) s.anthropicModel = DEFAULTS.anthropicModel;
  if (!s.localBaseUrl) s.localBaseUrl = DEFAULTS.localBaseUrl;
  if (!s.nimBaseUrl) s.nimBaseUrl = DEFAULTS.nimBaseUrl;
  clampNumbers(s);
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
const isValidKey = (key, min = 10) => new RegExp(`^[\\x21-\\x7E]{${min},}$`).test(key);
// Anahtarın en az uzunluğu: API anahtarları uzundur; yerel sunucu anahtarı kısa bir dizge olabilir (LM Studio: "lm-studio").
const KEY_MIN = { anthropic: 10, nim: 10, local: 1 };

// Şifreli saklanan anahtarlar: anthropic (Claude API), local (yerel sunucu isteğe bağlı anahtar).
const KEY_LABEL = { anthropic: 'Anthropic API', local: 'Yerel sunucu', nim: 'NVIDIA NIM' };
const keyInvalid = { anthropic: false, local: false, nim: false };

// Yalnızca Sonda'ya girilen anahtar kullanılır; ANTHROPIC_API_KEY ortam değişkeni bilerek okunmaz (başka bir
// amaçla ayarlanmış bir anahtar sessizce ayrı faturalanmasın; ajanların ortamından da zaten ayıklanır).
function getKey(name) {
  const s = load();
  keyInvalid[name] = false;
  let key = '';
  if (s[`${name}KeyEnc`] && safeStorage.isEncryptionAvailable()) {
    try {
      key = cleanKey(safeStorage.decryptString(Buffer.from(s[`${name}KeyEnc`], 'base64')));
    } catch {
      key = '';
    }
  } else {
    key = cleanKey(s[`${name}KeyPlain`] || '');
  }
  // Çözülemeyen / bozuk kayıt hiç kullanılmasın; kullanıcıdan yeniden istenir.
  if (key && !isValidKey(key, KEY_MIN[name])) {
    keyInvalid[name] = true;
    return '';
  }
  return key;
}
const getAnthropicKey = () => getKey('anthropic');

function keySource(name) {
  const s = load();
  if (s[`${name}KeyEnc`]) return 'keychain';
  return s[`${name}KeyPlain`] ? 'file' : null;
}

function mask(key) {
  if (!key) return '';
  return key.length <= 10 ? '••••' : `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

// Ana süreç için tam ayarlar (anahtarlar dahil).
function get() {
  return { ...load(), anthropicKey: getAnthropicKey(), localApiKey: getKey('local'), nimApiKey: getKey('nim') };
}

// Anahtarsız ayarlar: anahtar gerektirmeyen sık çağrılar (ajan seçimi, CLI yolu) için; her çağrıda üç anahtar
// çözülmez (işletim sistemi anahtar zinciri çağrısı).
function peek() {
  const { anthropicKeyEnc, anthropicKeyPlain, localKeyEnc, localKeyPlain, nimKeyEnc, nimKeyPlain, ...rest } = load();
  return rest;
}

// Arayüze gönderilen ayarlar: ham anahtar yerine maskelenmiş hali.
function getPublic() {
  // Proje kadroları arayüze toptan gitmez; yeni iş ekranı seçili klasörünkini sorar (settings:projectStack).
  const { anthropicKeyEnc, anthropicKeyPlain, localKeyEnc, localKeyPlain, nimKeyEnc, nimKeyPlain, projectStacks, ...rest } = load();
  const nimKey = getKey('nim');
  const anthropicKey = getAnthropicKey();
  const localKey = getKey('local');
  const model = claudeModelOf(rest);
  return {
    ...rest,
    hasAnthropicKey: !!anthropicKey,
    anthropicKeyInvalid: keyInvalid.anthropic,
    anthropicKeyMasked: mask(anthropicKey),
    anthropicKeySource: keySource('anthropic'),
    hasLocalKey: !!localKey,
    localKeyMasked: mask(localKey),
    hasNimKey: !!nimKey,
    nimKeyMasked: mask(nimKey),
    defaultStandards: DEFAULT_STANDARDS,
    // Claude modeli: kullanılan model, varsayılan ve Ayarlar'daki seçenekler (arayüz bunları gösterir).
    claudeModelEffective: model,
    claudeModelLabel: claudeModelLabel(model),
    claudeDefaultModel: DEFAULT_CLAUDE_MODEL,
    claudeModels: CLAUDE_MODELS,
    // Claude CLI yöneticisi: kullanılan model (boş ayar → Ajanlar'daki model).
    managerClaudeModelEffective: managerClaudeModelOf(rest),
    managerClaudeModelLabel: claudeModelLabel(managerClaudeModelOf(rest)),
    managerLabel: managerLabel(rest),
    // Rollerin kullanacağı modeller (etiketleriyle): arayüz özet satırında gösterir.
    roleModels: Object.fromEntries(['planner', 'coder', 'reviewer', 'brief'].map((r) => [r, { id: roleModelOf(rest, r), label: claudeModelLabel(roleModelOf(rest, r)) }])),
  };
}

function storeKey(s, name, key, clear) {
  if (clear) {
    delete s[`${name}KeyEnc`];
    delete s[`${name}KeyPlain`];
    return;
  }
  if (typeof key !== 'string' || !cleanKey(key)) return;
  const clean = cleanKey(key);
  if (!isValidKey(clean, KEY_MIN[name])) throw new Error(`${KEY_LABEL[name]} anahtarı geçersiz karakter içeriyor ya da çok kısa. Anahtarı yeniden kopyalayıp yapıştırın.`);
  if (safeStorage.isEncryptionAvailable()) {
    s[`${name}KeyEnc`] = safeStorage.encryptString(clean).toString('base64');
    delete s[`${name}KeyPlain`];
  } else {
    s[`${name}KeyPlain`] = clean;
    delete s[`${name}KeyEnc`];
  }
}

function save(patch = {}) {
  const s = load();
  const { anthropicKey, clearAnthropicKey, localApiKey, clearLocalKey, nimApiKey, clearNimKey, ...rest } = patch || {};
  for (const [k, v] of Object.entries(rest)) {
    if (!(k in DEFAULTS)) continue;
    const clean = sanitize(k, v);
    if (clean !== undefined) s[k] = clean;
  }
  // Varsayılan modelin kimliği açıkça yazıldıysa "varsayılan" olarak saklanır (varsayılan değişirse onu izler).
  // Rol modelleri böyle sadeleştirilmez: "inceleyici her zaman Opus" seçimi, genel model o sırada Opus olsa da açık bir
  // seçimdir; genel model sonradan değişince rol onu izlememeli.
  if (s.claudeModel === DEFAULT_CLAUDE_MODEL) s.claudeModel = '';
  storeKey(s, 'anthropic', anthropicKey, clearAnthropicKey);
  storeKey(s, 'local', localApiKey, clearLocalKey);
  storeKey(s, 'nim', nimApiKey, clearNimKey);
  normalize(s);
  if (typeof s.standards === 'string' && s.standards.trim() === DEFAULT_STANDARDS.trim()) s.standards = '';
  persist();
  return getPublic();
}

function clampInt(v, min, max, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

// Seçili yönetici: anahtarı çözmeden yalnızca seçimi okur (tanınmayan değer varsayılana düşer).
const managerBy = (s = load()) => (ENUMS.managerBy.includes(s.managerBy) ? s.managerBy : DEFAULTS.managerBy);
// CLI yöneticileri (Claude CLI, OpenCode) anahtar değil kurulu bir CLI ister (tembel require: agents → runner → env zinciri).
const cliReady = (id, s) => !!require('./agents').resolveBin(id, s);
const chosen = (v) => !!String(v || '').trim();
// Yönetici sağlayıcıları: arayüz / günlük adı, hazır olma koşulu ve eksikse kullanıcıya ileti. Yeni sağlayıcı = bir satır
// (ENUMS.managerBy'a da eklenir).
const MANAGERS = {
  claudecli: { label: 'Claude CLI', ready: (s) => cliReady('claude', s), missing: () => 'Claude Code bulunamadı. Ayarlar → Bağlantılar\'dan "Claude\'u kur ve bağla" ile bağlayın.' },
  anthropic: { label: 'Claude API', ready: (s) => !!s.anthropicKey, missing: () => 'Anthropic API anahtarı yok. Ayarlar\'dan ekleyin.' },
  local: { label: 'Yerel model', ready: (s) => chosen(s.localModel), missing: () => 'Yerel model seçilmemiş. Ayarlar → Bağlantılar → Yerel model sunucusu\'ndan listeyi çekip Modeller → Yönetici\'den seçin.' },
  nim: {
    label: 'NVIDIA NIM',
    ready: (s) => !!s.nimApiKey && chosen(s.nimModel),
    missing: (s) => (!s.nimApiKey ? 'NVIDIA NIM API anahtarı yok. Ayarlar → Bağlantılar → NVIDIA NIM\'den ekleyin (build.nvidia.com).' : 'NVIDIA NIM modeli seçilmemiş. Ayarlar → Bağlantılar → NVIDIA NIM\'den "Modelleri getir" ile seçin.'),
  },
  opencode: { label: 'OpenCode', ready: (s) => cliReady('opencode', s), missing: () => 'OpenCode bulunamadı. Kurulum: npm install -g opencode-ai (Ayarlar → Bağlantılar → OpenCode).' },
};
// Günlükte ve arayüzde görünen ad.
const managerLabel = (s = load()) => MANAGERS[managerBy(s)].label;
// Yönetici kullanıma hazır mı (CLI kurulu / anahtar var / model seçilmiş); değilse neden.
const managerReady = (s = get()) => MANAGERS[managerBy(s)].ready(s);
const managerMissingMessage = (s = get()) => MANAGERS[managerBy(s)].missing(s);
// Claude CLI yöneticisinin modeli: ayarı boşsa Ajanlar'daki Claude modeli.
const managerClaudeModelOf = (s = get()) => String(s.managerClaudeModel || '').trim() || claudeModelOf(s);

// ---------- proje kadrosu ----------
// Kadro: bir işte kimin ne yapacağı — yönetici (managerBy), kodlayıcı (agent), inceleyici (reviewerBy). Yeni iş ekranında
// proje klasörü başına seçilir ve hatırlanır; Ayarlar → Modeller'deki seçimler yalnızca varsayılandır. İş kendi çözülmüş
// kadrosunu taşır (job.stack): iş sürerken ya da sürdürülürken Ayarlar değişse de roller değişmez.
// codexProvider: kodlayıcı Codex ise hangi modelle kodlar (openai | local: Ollama / LM Studio | nim); yerel modelle kodlama
// böylece proje başına seçilir. Model adları (codexModel, nimCoderModel…) Ayarlar'dan gelir.
const STACK_KEYS = { agent: ENUMS.defaultAgent, codexProvider: ENUMS.codexProvider, managerBy: ENUMS.managerBy, reviewerBy: ENUMS.reviewerBy };
const MAX_PROJECT_STACKS = 60;
const stackDirKey = (dir) => {
  const p = path.resolve(String(dir || ''));
  return process.platform === 'win32' ? p.toLowerCase() : p;
};

// Yalnızca tanınan alanlar ve geçerli değerler kalır (arayüzden ya da eski kayıttan gelen başka bir şey yok sayılır).
function cleanStack(stack) {
  const out = {};
  for (const [k, allowed] of Object.entries(STACK_KEYS)) {
    const v = stack?.[k];
    if (typeof v === 'string' && allowed.includes(v)) out[k] = v;
  }
  return out;
}

// Ayarların kadroyla ezilmiş hali: yönetici / kodlayıcı / inceleyici seçimleri kadrodan, gerisi ayarlardan.
function withStack(s, stack) {
  const { agent, ...rest } = cleanStack(stack);
  return { ...s, ...(agent ? { defaultAgent: agent } : {}), ...rest };
}

// Ayarlardan çözülmüş tam kadro (iş kaydına yazılır).
const resolveStack = (s) => ({ agent: s.defaultAgent, codexProvider: ENUMS.codexProvider.includes(s.codexProvider) ? s.codexProvider : 'openai', managerBy: managerBy(s), reviewerBy: s.reviewerBy === 'agent' ? 'agent' : 'auto' });

// Bu klasör için hatırlanan kadro (yoksa boş nesne: Ayarlar'daki varsayılanlar geçerli).
const projectStack = (dir) => (dir ? cleanStack(load().projectStacks?.[stackDirKey(dir)]) : {});

function rememberProjectStack(dir, stack) {
  if (!dir) return;
  const s = load();
  const all = { ...(s.projectStacks || {}), [stackDirKey(dir)]: { ...cleanStack(stack), at: Date.now() } };
  // En son kullanılan projeler kalır; dosya sınırsız büyümez.
  s.projectStacks = Object.fromEntries(Object.entries(all).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, MAX_PROJECT_STACKS));
  persist();
}

/**
 * Şifreleme yokken düz saklanmış API anahtarlarını şifreler. Uygulama hazır olduktan sonra çağrılır (Windows ve Linux'ta
 * şifreleme ancak o zaman kullanılabilir). Şifrelenen anahtar sayısı.
 */
function migratePlain() {
  const s = load();
  if (!safeStorage.isEncryptionAvailable()) return 0;
  let n = 0;
  for (const name of ['anthropic', 'local', 'nim']) {
    const plain = cleanKey(s[`${name}KeyPlain`] || '');
    if (!plain || s[`${name}KeyEnc`]) continue;
    s[`${name}KeyEnc`] = safeStorage.encryptString(plain).toString('base64');
    delete s[`${name}KeyPlain`];
    n++;
  }
  if (n) persist();
  return n;
}

module.exports = { get, peek, getPublic, save, migratePlain, managerReady, managerMissingMessage, managerBy, managerLabel, managerClaudeModelOf, cleanStack, withStack, resolveStack, projectStack, rememberProjectStack };
