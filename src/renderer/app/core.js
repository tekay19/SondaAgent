// Ortak durum ve yardımcılar: köprü (window.sonda), DOM kısayolları, sabitler, biçimleyiciler, bildirim.

const api = window.sonda;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const md = (s) => window.renderMarkdown(s);
// Yapıştırılmış uzun metinlerden yalnızca ilk dolu satır (üst bilgi, tarih, "@kullanıcı" gibi artıklar görünmesin).
const firstLine = (s, max = 100) => {
  const line = String(s ?? '').split(/\r?\n/).map((x) => x.trim()).find(Boolean) || '';
  return line.length > max ? `${line.slice(0, max).trimEnd()}…` : line;
};
const IS_MAC = api.platform === 'darwin';

const PHASES = {
  planning: ['Planlanıyor', 'running'],
  awaiting_answers: ['Cevap bekliyor', 'waiting'],
  awaiting_approval: ['Onay bekliyor', 'waiting'],
  running: ['Kodlanıyor', 'running'],
  verifying: ['Doğrulanıyor', 'running'],
  testing: ['Tarayıcı testi', 'running'],
  reviewing: ['İnceleniyor', 'running'],
  fixing: ['Düzeltiliyor', 'running'],
  reporting: ['Rapor yazılıyor', 'running'],
  done: ['Teslime hazır', 'done'],
  incomplete: ['Teslime hazır değil', 'failed'],
  failed: ['Hata', 'failed'],
  stopped: ['Durduruldu', ''],
  cancelled: ['İptal edildi', ''],
};
const ACTIVE = new Set(['planning', 'running', 'verifying', 'testing', 'reviewing', 'fixing', 'reporting']);
// Durum baklavaları: bekliyor (boş), bitti (dolu, tik), sorunlu (dolu, çarpı), atlandı (boş, çizgi); çalışanlar CSS ile dönen baklavadır.
const stIcon = (name) => `<svg class="ico" aria-hidden="true"><use href="#st-${name}"/></svg>`;
const TASK_STATUS = {
  pending: [stIcon('pending'), 'pending', ''],
  running: ['', 'active', 'Kodlanıyor'],
  verifying: ['', 'active', 'Test ediliyor'],
  reviewing: ['', 'active', 'İnceleniyor'],
  fixing: ['', 'active', 'Düzeltiliyor'],
  done: [stIcon('done'), 'done', ''],
  failed: [stIcon('failed'), 'failed', 'Sorunlu'],
  skipped: [stIcon('skip'), 'pending', 'Atlandı'],
};
const AGENT_LABEL = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' };
const KIND_LABEL = { feature: 'Özellik ekleme', bugfix: 'Hata düzeltme', refactor: 'Refactor' };
const FINDING_LABEL = { bug: 'hata', refactor: 'refactor', design: 'tasarım' };
const SEV_LABEL = { critical: 'kritik', high: 'yüksek', medium: 'orta', low: 'düşük' };
const AGENT_SHORT = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' };
// Kadro: bir işte kimin ne yapacağı — { managerBy, agent, codexProvider, reviewerBy }. Seçenek etiketleri yeni iş
// ekranında, iş özetinde ve geçmişte aynı. Kodlayıcı seçeneği ajan + Codex sağlayıcısının birleşimidir ("codex:local"
// = Codex yerel modelle kodlar); bkz. coderKey / coderOf.
const STACK_OPTIONS = {
  managerBy: [['claudecli', 'Claude (abonelik)'], ['anthropic', 'Claude API'], ['local', 'Yerel model'], ['nim', 'NVIDIA NIM'], ['opencode', 'OpenCode']],
  coder: [['claude', 'Claude Code'], ['codex:openai', 'Codex — OpenAI'], ['codex:local', 'Codex — yerel model (Ollama / LM Studio)'], ['codex:nim', 'Codex — NVIDIA NIM'], ['opencode', 'OpenCode']],
  reviewerBy: [['auto', 'Claude Code'], ['agent', 'Kodlayıcıyla aynı']],
};
const coderKey = (stack) => (stack?.agent === 'codex' ? `codex:${stack.codexProvider || 'openai'}` : stack?.agent || 'claude');
const coderOf = (key) => {
  const [agent, provider] = String(key || 'claude').split(':');
  return agent === 'codex' ? { agent, codexProvider: provider || 'openai' } : { agent };
};
const stackLabel = (role, value) => STACK_OPTIONS[role].find(([v]) => v === value)?.[1] || value || '';
// "Yönetici: … · Kodlayıcı: … · İnceleyici: …" — inceleyici "kodlayıcıyla aynı" ise kodlayıcının adı yazılır.
const stackText = (stack) => {
  if (!stack) return '';
  const coder = stackLabel('coder', coderKey(stack));
  const reviewer = stack.reviewerBy === 'agent' ? coder : stackLabel('reviewerBy', stack.reviewerBy);
  return `Yönetici: ${stackLabel('managerBy', stack.managerBy)} · Kodlayıcı: ${coder} · İnceleyici: ${reviewer}`;
};
const SRC_LABEL = { manager: 'Yönetici', test: 'Test', system: 'Sonda', review: 'Denetçi' };
// Yönetici (ürün tanımı, plan onayı, son kabul, rapor): Claude CLI (abonelik), Claude API ya da yerel model. Etiketler
// seçime göre yazılır. Claude CLI'de "hazır" demek Claude Code'un kurulu olmasıdır (ajan algılaması gelmeden hazır sayılır).
const managerOf = (s) => {
  if (s?.managerBy === 'anthropic') return { id: 'anthropic', name: 'Claude API', model: s.anthropicModel, has: !!s.hasAnthropicKey, invalid: !!s.anthropicKeyInvalid };
  if (s?.managerBy === 'local') return { id: 'local', name: 'Yerel model', model: s.localModel, has: !!String(s.localModel || '').trim(), invalid: false, local: true };
  if (s?.managerBy === 'nim') return { id: 'nim', name: 'NVIDIA NIM', model: s.nimModel, has: !!s.hasNimKey && !!String(s.nimModel || '').trim(), invalid: false, nim: true };
  // OpenCode yöneticisi: kurulu olması yeter (sağlayıcı anahtarları OpenCode'un kendi deposunda; ücretsiz modeller anahtarsız çalışır).
  if (s?.managerBy === 'opencode') return { id: 'opencode', name: 'OpenCode', model: s.opencodeManagerModel || s.opencodeModel || '', has: state.agents ? !!state.agents.opencode?.found : true, invalid: false, opencode: true };
  return { id: 'claudecli', name: 'Claude', model: s?.managerClaudeModelLabel || '', has: state.agents ? !!state.agents.claude?.found : true, invalid: false, cli: true };
};

const state = {
  settings: null,
  agents: null,
  compose: { projectDir: '', agent: 'claude', attachments: [] },
  view: 'compose',
  job: null,
  followId: null,
  running: new Set(), // çalışan işlerin kimlikleri (paralel)
  maxParallel: 3,
  expanded: new Set(), // kenar çubuğunda alt işleri tümüyle açılmış projeler
  collapsed: new Set(), // alt işleri gizlenmiş projeler (kenar çubuğu; tarayıcıda hatırlanır)
  logs: [],
  shots: [],
  logFilter: 'all',
  tab: 'logs',
  history: [],
  openTasks: new Set(),
  skip: new Set(),
  app: { state: 'stopped' },
  actionsKey: '',
  contentKey: '',
  summaryOpen: false,
  folds: new Map(), // kullanıcının açıp kapadığı katlanır bölümler (yeniden çizimde korunur)
  loadingId: null, // yüklenmekte olan iş (bkz. history.openJob)
  pendingLogs: [], // yükleme sırasında gelen log satırları
  env: null,
  envDir: '',
  envPending: { set: {}, remove: new Set() },
  connect: null, // süren bağlantı kurulumu: { id, step: 'install' | 'login' | 'test', lines, cancelled }
  connTest: {}, // ajan → son bağlantı testi: { ok, model, error }
};

// ---------- yardımcılar ----------
let toastTimer;
function toast(msg, isError = false, ms = 0) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms || (isError ? 7000 : 3500));
}
async function attempt(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg);
    return r;
  } catch (e) {
    toast(e.message || String(e), true);
    return undefined;
  }
}
const baseName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || p;
const ico = (name) => `<svg class="ico" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const semverOf = (v) => String(v || '').match(/\d+\.\d+\.\d+/)?.[0] || String(v || '');
const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const fmtTime = (t) => new Date(t).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtDur = (ms) => {
  const m = Math.floor(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)} sa ${m % 60} dk` : m ? `${m} dk` : `${Math.floor(ms / 1000)} sn`;
};
function relDate(t) {
  const d = (Date.now() - t) / 1000;
  if (d < 60) return 'az önce';
  if (d < 3600) return `${Math.floor(d / 60)} dk önce`;
  if (d < 86400) return `${Math.floor(d / 3600)} sa önce`;
  return new Date(t).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' });
}
// Paralel işler: "meşgul" artık işe özeldir.
const normDir = (d) => String(d || '').replace(/[\\/]+$/, '');
const busyHere = () => !!state.job && state.running.has(state.job.id);
const dirBusy = (dir) => state.history.some((j) => state.running.has(j.id) && normDir(j.projectDir) === normDir(dir));
const isLiveJob = () => busyHere() && ACTIVE.has(state.job.phase);

export { api, $, $$, esc, md, firstLine, stIcon, IS_MAC, PHASES, ACTIVE, TASK_STATUS, AGENT_LABEL, KIND_LABEL, FINDING_LABEL, SEV_LABEL, AGENT_SHORT, SRC_LABEL, STACK_OPTIONS, coderKey, coderOf, stackLabel, stackText, managerOf, state, toast, attempt, baseName, ico, semverOf, fmtSize, fmtTime, fmtDur, relDate, normDir, busyHere, dirBusy, isLiveJob };
