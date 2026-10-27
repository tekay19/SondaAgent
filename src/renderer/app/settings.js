// Ayarlar penceresi. Dört sekme: Modeller (kim ne yapar: yönetici / kodlayıcı / inceleyici ve modelleri),
// Bağlantılar (hesaplar, anahtarlar, sunucular), Süreç (akış ve kalite), Genel (görünüm, standartlar).
// Form alanları `name` ile ayara bağlıdır: doldurma ve toplama genel döngüyle yapılır; yalnızca anahtar alanları ve
// türetilmiş seçimler (kodlayıcı = defaultAgent + codexProvider) özel ele alınır.
import { api, $, $$, esc, AGENT_LABEL, state, toast, attempt, ico, semverOf } from './core.js';
import { refreshAgents, renderAgentStatus, connectionHtml, onConnClick, connectAgent } from './agents.js';
import { renderThemeBtn } from './theme.js';
import { renderReadiness } from './compose.js';

const dlg = $('#settingsDialog');
const form = $('#settingsForm');

// Anahtar alanları forma geri yazılmaz (yalnızca maskeli özet gösterilir); boş bırakılınca kayıtlı anahtar korunur.
const KEY_FIELDS = ['localApiKey', 'nimApiKey', 'anthropicKey'];
// Eski sekme adları (dışarıdan çağrılar): ajanlar → bağlantılar.
const PANE_ALIAS = { agents: 'connections', standards: 'general' };

// Sunuculardan getirilen model listeleri (pencere açık kaldığı sürece hatırlanır).
const lists = { local: [], nim: [], anthropic: [], opencode: [] };
// NIM listesinde kodlama / planlama için güçlü olanlar üstte "önerilen" grubunda gösterilir.
const NIM_CODING = /coder|codestral|devstral|deepseek|kimi|glm|qwen3|nemotron-ultra|nemotron-super|mistral-large|gpt-oss|llama-3\.[1-3]-(70b|405b)|llama-4/i;

const opt = (value, label = value) => `<option value="${esc(value)}">${esc(label)}</option>`;

// ---------- doldurma ----------
function fillSettings() {
  const s = state.settings;
  for (const el of form.elements) {
    if (!el.name || KEY_FIELDS.includes(el.name) || el.name === 'standards') continue;
    if (el.type === 'checkbox') el.checked = !!s[el.name];
    else if (s[el.name] !== undefined) el.value = s[el.name];
  }
  for (const k of KEY_FIELDS) form.elements[k].value = '';
  form.elements.localApiKey.placeholder = s.hasLocalKey ? `kayıtlı: ${s.localKeyMasked}` : 'gerekmiyorsa boş bırak';
  form.elements.nimApiKey.placeholder = s.hasNimKey ? `kayıtlı: ${s.nimKeyMasked}` : 'nvapi-…';
  form.elements.anthropicKey.placeholder = s.hasAnthropicKey ? `kayıtlı: ${s.anthropicKeyMasked}` : 'sk-ant-…';
  $('#anthropicKeyHint').textContent = s.hasAnthropicKey ? '' : s.anthropicKeyInvalid ? 'Kayıtlı anahtar okunamadı (bozuk); yeniden yapıştır.' : 'Anahtar kayıtlı değil.';
  $('#standardsInput').value = s.standards || s.defaultStandards;
  setThemeSeg(s.theme || 'system');
  $('#coderSel').value = s.defaultAgent === 'codex' ? `codex:${s.codexProvider || 'openai'}` : s.defaultAgent === 'opencode' ? 'opencode' : 'claude';
  fillClaudeModel(s);
  fillManagerClaudeModel(s);
  fillRoleSelects(s);
  fillServerSelects(s);
  syncVisibility();
  syncProcess();
}

// Claude kodlayıcı modeli: katalog + "Özel" kimlik.
const modelSel = $('#claudeModelSel');
const modelCustom = $('#claudeModelCustom');
function fillClaudeModel(s) {
  const models = s.claudeModels || [];
  const def = s.claudeDefaultModel;
  const saved = String(s.claudeModel || '').trim();
  modelSel.innerHTML = models.map((m) => opt(m.id === def ? '' : m.id, `${m.label}${m.id === def ? ' — varsayılan' : m.note ? ` — ${m.note}` : ''}`)).join('') + opt('__custom', 'Özel model kimliği…');
  const known = !saved || saved === def || models.some((m) => m.id === saved);
  modelSel.value = !saved || saved === def ? '' : known ? saved : '__custom';
  modelCustom.value = known ? '' : saved;
  syncClaudeModelField();
}
function syncClaudeModelField() {
  const custom = modelSel.value === '__custom';
  $('#claudeModelCustomField').hidden = !custom || $('#coderSel').value !== 'claude';
  form.elements.claudeModel.value = custom ? modelCustom.value.trim() : modelSel.value;
}
modelSel.addEventListener('change', () => {
  syncClaudeModelField();
  if (modelSel.value === '__custom') modelCustom.focus();
  fillRoleSelects(state.settings);
  fillManagerClaudeModel(state.settings);
  renderSummary();
});
modelCustom.addEventListener('input', () => {
  syncClaudeModelField();
  fillRoleSelects(state.settings);
  fillManagerClaudeModel(state.settings);
  renderSummary();
});

// Yönetici için Claude modeli: boş = genel Claude modeli (Kodlayıcı kartındaki ya da Claude rollerindeki seçim).
// (OpenCode yöneticisinin modeli düz metin alanıdır: `opencodeManagerModel`, genel döngüyle dolar.)
function fillManagerClaudeModel(s) {
  const sel = $('#managerClaudeModelSel');
  const saved = String(sel.value || s.managerClaudeModel || '').trim();
  const models = s.claudeModels || [];
  const base = models.find((m) => m.id === (form.elements.claudeModel.value || s.claudeDefaultModel))?.label || form.elements.claudeModel.value || s.claudeModelLabel || 'Opus 5.5';
  sel.innerHTML = opt('', `Claude modeli (${base})`) + models.map((m) => opt(m.id, `${m.label}${m.note ? ` — ${m.note}` : ''}`)).join('') + (saved && !models.some((m) => m.id === saved) ? opt(saved) : '');
  sel.value = saved;
}

// Claude rol modelleri: boş = kodlayıcı modeli (brifte: Süreç'teki "Teknik brif" seçimine göre Fable 5.1 ya da kodlayıcı modeli).
function fillRoleSelects(s) {
  const models = s.claudeModels || [];
  const base = models.find((m) => m.id === (form.elements.claudeModel.value || s.claudeDefaultModel))?.label || form.elements.claudeModel.value || s.claudeModelLabel || 'Opus 5.5';
  const briefFollow = form.elements.briefBy.value === 'coder' ? `Kodlayıcı modeli (${base}) — Süreç sekmesindeki seçim` : 'Fable 5.1 — Süreç sekmesindeki seçim';
  for (const sel of $$('[data-role-model]')) {
    const saved = String(sel.value || s[sel.name] || '').trim();
    const follow = sel.dataset.roleDefault === 'brief' ? briefFollow : `Claude modeli (${base})`;
    sel.innerHTML = opt('', follow) + models.map((m) => opt(m.id, m.label)).join('') + (saved && !models.some((m) => m.id === saved) ? opt(saved) : '');
    sel.value = saved;
  }
  // Kodlayıcı Claude değilken Claude rollerinin temel modeli (Kodlayıcı kartındaki seçim o durumda gizlidir).
  const baseSel = $('#claudeBaseSel');
  const cur = form.elements.claudeModel.value;
  baseSel.innerHTML = models.map((m) => opt(m.id === s.claudeDefaultModel ? '' : m.id, `${m.label}${m.id === s.claudeDefaultModel ? ' — varsayılan' : ''}`)).join('') + (cur && !models.some((m) => m.id === cur) ? opt(cur) : '');
  baseSel.value = cur === s.claudeDefaultModel ? '' : cur;
}
$('#claudeBaseSel').addEventListener('change', () => {
  const v = $('#claudeBaseSel').value;
  if ([...modelSel.options].some((o) => o.value === v && o.value !== '__custom')) modelSel.value = v;
  else {
    modelSel.value = '__custom';
    modelCustom.value = v;
  }
  syncClaudeModelField();
  fillRoleSelects(state.settings);
  fillManagerClaudeModel(state.settings);
  renderSummary();
});

// Sunucu listeleri: yerel model (tek seçim) ve NIM (yönetici + roller; önerilenler üstte). Yönetici model seçicisi iki
// yerde görünür (Bağlantılar kartı: #…ModelPick, Modeller → Yönetici: #…ModelSel); ikisi aynı değeri taşır, kaydedilen
// Modeller'deki (name'li) seçicidir.
const MIRROR = { local: ['#localModelSel', '#localModelPick'], nim: ['#nimModelSel', '#nimModelPick'] };
function fillServerSelects(s) {
  const localIds = [...new Set(lists.local.map((m) => m.id))];
  const localSaved = String($('#localModelSel').value || s.localModel || '').trim();
  for (const id of MIRROR.local) {
    $(id).innerHTML = opt('', '— model seç —') + localIds.map((m) => opt(m)).join('') + (localSaved && !localIds.includes(localSaved) ? opt(localSaved) : '');
    $(id).value = localSaved;
  }
  // Codex yerel modelle kodlarken model adı da bu listeden seçilebilir.
  $('#localModelList').innerHTML = localIds.map((m) => opt(m)).join('');
  $('#localModelHint').textContent = localIds.length ? `${localIds.length} model bulundu; yanındaki listeden seç, Test et ile dene. Kaydet ile kalıcı olur.` : 'Adresi girip "Modelleri getir"e bas (Ollama 11434 · LM Studio 1234 · llama.cpp 8080).';

  const nimIds = [...new Set(lists.nim.map((m) => m.id))];
  const good = nimIds.filter((id) => NIM_CODING.test(id));
  const rest = nimIds.filter((id) => !NIM_CODING.test(id));
  const groups = (good.length ? `<optgroup label="Kodlama / planlama için önerilen">${good.map((id) => opt(id)).join('')}</optgroup>` : '') + (rest.length ? `<optgroup label="Diğer">${rest.map((id) => opt(id)).join('')}</optgroup>` : '');
  const nimSaved = String($('#nimModelSel').value || s.nimModel || '').trim();
  for (const id of MIRROR.nim) {
    $(id).innerHTML = opt('', '— model seç —') + groups + (nimSaved && !nimIds.includes(nimSaved) ? opt(nimSaved) : '');
    $(id).value = nimSaved;
  }
  for (const sel of $$('[data-nim-role]')) {
    const saved = String(sel.value || s[sel.name] || '').trim();
    const mgr = nimSaved || s.nimModel;
    sel.innerHTML = opt('', `Yöneticinin NIM modeli${mgr ? ` (${mgr})` : ''}`) + groups + (saved && !nimIds.includes(saved) ? opt(saved) : '');
    sel.value = saved;
  }
  $('#nimModelHint').textContent = nimIds.length ? `${nimIds.length} model; ${good.length} tanesi kodlama / planlama için uygun. Yanındaki listeden seç; roller Modeller sekmesinde.` : 'Anahtarı girip "Modelleri getir"e bas; liste build.nvidia.com\'dan gelir.';
}
// Aynalı seçiciler birlikte değişir.
for (const [a, b] of Object.values(MIRROR)) {
  $(a).addEventListener('change', () => {
    $(b).value = $(a).value;
    fillServerSelects(state.settings); // NIM rol listelerindeki "yöneticinin modeli" etiketi
  });
  $(b).addEventListener('change', () => {
    $(a).value = $(b).value;
    fillServerSelects(state.settings);
    renderSummary();
  });
}

// Sunucu listeleri kendiliğinden gelir: yerel model ya da NIM kadroda seçiliyse pencere açılınca (ve seçim o yöne
// çevrilince) liste sessizce çekilir; sunucu kapalıysa uyarı yok, düğme yine elle çalışır.
const prefetching = { local: false, nim: false };
async function prefetchServerModels() {
  const by = $('#managerBySel').value;
  const coder = $('#coderSel').value;
  const want = { local: by === 'local' || coder === 'codex:local', nim: by === 'nim' || coder === 'codex:nim' };
  for (const kind of ['local', 'nim']) {
    if (!want[kind] || lists[kind].length || prefetching[kind]) continue;
    if (kind === 'nim' && !state.settings?.hasNimKey && !form.elements.nimApiKey.value.trim()) continue;
    prefetching[kind] = true;
    try {
      const models = await (kind === 'local' ? api.listLocalModels(serverArgs('local')) : api.listNimModels(serverArgs('nim'))).catch(() => null);
      if (models?.length && dlg.open) applyServerModels(kind, models);
    } finally {
      prefetching[kind] = false;
    }
  }
}

// ---------- hazır kurulumlar ve uyumluluk uyarıları ----------
// Kullanıcı en başta ne seçeceğini bilmek zorunda kalmasın: üç hazır kurulum rolleri tek tıkla ayarlar.
const PRESETS = {
  claude: { managerBy: 'claudecli', coder: 'claude', reviewerBy: 'auto' },
  opencode: { managerBy: 'claudecli', coder: 'opencode', reviewerBy: 'auto' },
  allopencode: { managerBy: 'opencode', coder: 'opencode', reviewerBy: 'agent' },
  noclaude: { managerBy: 'nim', coder: 'opencode', reviewerBy: 'agent' },
};
function applyPreset(name) {
  const p = PRESETS[name];
  if (!p) return;
  $('#managerBySel').value = p.managerBy;
  $('#coderSel').value = p.coder;
  $('#reviewerBySel').value = p.reviewerBy;
  syncVisibility();
}

// Seçilen rollerin çalışması için eksik olanlar (anahtar, kurulum, giriş, model): kaydetmeden önce görünür.
function renderWarnings() {
  const s = state.settings || {};
  const ag = state.agents || {};
  const by = $('#managerBySel').value;
  const coder = $('#coderSel').value;
  const reviewer = $('#reviewerBySel').value;
  const claudeOk = ag.claude ? !!ag.claude.found : true; // algılama henüz gelmediyse uyarılmaz
  // Forma yapıştırılmış ama henüz kaydedilmemiş anahtar da sayılır (Kaydet ile kalıcı olur).
  const hasAnthropicKey = s.hasAnthropicKey || !!form.elements.anthropicKey.value.trim();
  const hasNimKey = s.hasNimKey || !!form.elements.nimApiKey.value.trim();
  const list = [];
  if (coder === 'claude' && !claudeOk) list.push('Kodlayıcı Claude Code ama kurulu değil: Bağlantılar → "Claude\'u kur ve bağla" ya da kodlayıcıyı değiştir.');
  if (by === 'claudecli' && !claudeOk) list.push('Yönetici Claude CLI ama Claude Code kurulu değil: Bağlantılar → "Claude\'u kur ve bağla" ya da yöneticiyi değiştir.');
  if (by === 'anthropic' && !hasAnthropicKey) list.push('Yönetici Claude API ama anahtar yok: Bağlantılar → Claude API.');
  if (by === 'local' && !$('#localModelSel').value) list.push('Yönetici yerel model ama model seçilmemiş: Bağlantılar → Yerel model sunucusu → "Modelleri getir", sonra yukarıdan seç.');
  if (by === 'nim' && !hasNimKey) list.push('Yönetici NVIDIA NIM ama API anahtarı yok: Bağlantılar → NVIDIA NIM.');
  if (by === 'nim' && hasNimKey && !$('#nimModelSel').value) list.push('NIM modeli seçilmemiş: Bağlantılar → NVIDIA NIM → "Modelleri getir", sonra yukarıdan seç.');
  if (by === 'opencode' && ag.opencode && !ag.opencode.found) list.push('Yönetici OpenCode ama kurulu değil: npm install -g opencode-ai (Bağlantılar → OpenCode).');
  if (by === 'opencode' && ag.opencode?.found) {
    const m = form.elements.opencodeManagerModel.value.trim() || (coder === 'opencode' ? form.elements.opencodeModel.value.trim() : '');
    if (!m) list.push('Yönetici OpenCode modeli boş: OpenCode kendi varsayılanını kullanır. Yönetici işleri uzun bağlam ve sağlam JSON ister; güçlü bir model seç (ör. nvidia/deepseek-ai/deepseek-v4-pro).');
    else if (!/^opencode\//.test(m) && ag.opencode.loggedIn !== true) list.push(`"${m}" için sağlayıcı anahtarı yok: Bağlantılar → OpenCode → Giriş yap (opencode auth login).`);
  }
  if (coder === 'opencode') {
    if (ag.opencode && !ag.opencode.found && by !== 'opencode') list.push('OpenCode kurulu değil: npm install -g opencode-ai (Bağlantılar → OpenCode).');
    const m = form.elements.opencodeModel.value.trim();
    if (!m) list.push('OpenCode modeli boş: OpenCode kendi varsayılan modelini kullanır. Takılır ya da hata verirse ücretsiz bir model seç (ör. opencode/big-pickle).');
    else if (!/^opencode\//.test(m) && ag.opencode?.found && ag.opencode.loggedIn !== true) list.push(`"${m}" için sağlayıcı anahtarı yok: Bağlantılar → OpenCode → Giriş yap (opencode auth login).`);
  }
  if (coder.startsWith('codex') && ag.codex && !ag.codex.found) list.push('Codex kurulu değil: npm install -g @openai/codex (Bağlantılar → Codex).');
  if (coder === 'codex:openai' && ag.codex?.found && ag.codex.loggedIn === false) list.push('Codex için OpenAI girişi gerekli: Bağlantılar → Codex → Giriş yap.');
  if (coder === 'codex:nim' && !hasNimKey) list.push('Codex NIM ile kodlayacak ama NIM anahtarı yok: Bağlantılar → NVIDIA NIM.');
  if (coder === 'codex:local' && !form.elements.codexModel.value.trim()) list.push('Codex yerel modelde model adı boş: Ollama / LM Studio\'daki modelin adını yaz (ör. qwen3-coder:30b).');
  if (reviewer === 'auto' && coder !== 'claude' && !claudeOk) list.push('İnceleyici Claude seçili ama Claude Code kurulu değil: incelemeleri kodlayıcı ajan yapacak. Bu bilinçliyse "Kodlayıcıyla aynı ajan" seç.');
  const el = $('#modelsWarn');
  el.hidden = !list.length;
  el.innerHTML = list.map((t) => `<div>⚠ ${esc(t)}</div>`).join('');
}

// ---------- görünürlük ve özet ----------
// Seçime göre yalnızca ilgili model alanları ve rol grupları görünür; ipuçları seçimi açıklar.
function syncVisibility() {
  const by = $('#managerBySel').value;
  for (const el of $$('[data-manager]')) el.hidden = el.dataset.manager !== by;
  const coder = $('#coderSel').value;
  const [agent, provider] = coder.split(':');
  form.elements.defaultAgent.value = agent;
  if (provider) form.elements.codexProvider.value = provider;
  for (const el of $$('[data-coder]')) el.hidden = !el.dataset.coder.split(' ').includes(coder);
  syncClaudeModelField();
  const reviewer = $('#reviewerBySel').value;
  const claudeReviews = reviewer === 'auto';
  $('[data-stack="claude"]').hidden = !(coder === 'claude' || claudeReviews);
  $('#claudeBaseField').hidden = coder === 'claude';
  $('[data-stack="nim"]').hidden = !(coder === 'codex:nim' && !claudeReviews);
  $('[data-stack="opencode"]').hidden = !(coder === 'opencode' && !claudeReviews);
  $('#managerHint').textContent = {
    claudecli: 'Bağlantılar → Claude Code hesabıyla, araçsız kısa oturumlarda; kullanım limitini az yorar.',
    anthropic: 'Anthropic Messages API ile; anahtar Bağlantılar → Claude API\'de.',
    local: 'Bilgisayarındaki sunucu; model listesi Bağlantılar → Yerel model sunucusu → "Modelleri getir" ile dolar. 30B+ ve ≥ 32K bağlam önerilir; PDF ek verilemez.',
    nim: 'build.nvidia.com modelleri; anahtar ve liste Bağlantılar → NVIDIA NIM\'de.',
    opencode: 'OpenCode CLI, salt okunur "plan" ajanıyla, geçici klasörde; sağlayıcı anahtarları OpenCode\'un kendi deposunda (opencode auth login). Model "sağlayıcı/model" biçiminde; boşsa kodlayıcı OpenCode modeli. Şemalı sonuç istemle istenir: sağlam JSON üreten güçlü bir model seç.',
  }[by] || '';
  $('#coderHint').textContent = {
    claude: 'Planlama, kodlama ve incelemelerin varsayılan modeli. Rol başına farklı model için 3. karta bak.',
    'codex:openai': 'Codex, OpenAI hesabıyla (Bağlantılar → Codex → giriş). Model boşsa Codex varsayılanı.',
    'codex:local': 'codex --oss: Ollama / LM Studio\'daki model kodlar; hesap gerekmez. Model alanına Ollama\'daki adı yaz.',
    'codex:nim': 'Codex, NIM modeliyle kodlar; anahtar Bağlantılar → NVIDIA NIM\'de. Boş = yöneticinin NIM modeli.',
    opencode: 'OpenCode kendi sağlayıcı anahtarlarıyla (opencode auth login) çalışır; model "sağlayıcı/model" biçiminde. Liste için Bağlantılar → OpenCode → Modelleri getir.',
  }[coder] || '';
  $('#reviewerHint').textContent = claudeReviews
    ? 'Claude Code kurulu değilse kodlayıcı ajan devralır. Claude rolleri yalnızca Claude çalıştığında geçerlidir.'
    : coder === 'claude'
      ? 'Kodlayıcı Claude olduğu için incelemeler de Claude Code ile yapılır.'
      : `İncelemeler ${coder === 'codex:nim' ? 'NIM modelleriyle' : coder === 'codex:local' ? 'yerel modelle' : coder === 'opencode' ? 'OpenCode (plan ajanı) ile' : 'Codex ile'}; Claude Code hiç kullanılmaz.`;
  renderSummary();
  if (dlg.open) prefetchServerModels();
}

// Başlıktaki tek satırlık özet: "Yönetici: … · Kodlayıcı: … · İnceleme: …" — kafa karışıklığını baştan keser.
function renderSummary() {
  const s = state.settings || {};
  const by = $('#managerBySel').value;
  const label = (sel) => sel.selectedOptions[0]?.textContent.replace(/ — .*$/, '') || '';
  const mgrModel = { claudecli: () => label($('#managerClaudeModelSel')), anthropic: () => form.elements.anthropicModel.value, local: () => $('#localModelSel').value, nim: () => $('#nimModelSel').value, opencode: () => form.elements.opencodeManagerModel.value || form.elements.opencodeModel.value }[by]?.() || '';
  const mgrName = { claudecli: 'Claude CLI', anthropic: 'Claude API', local: 'Yerel', nim: 'NIM', opencode: 'OpenCode' }[by];
  const coder = $('#coderSel').value;
  const codexModel = form.elements.codexModel.value;
  const coderName = {
    claude: `Claude Code · ${label(modelSel) || s.claudeModelLabel || ''}`,
    'codex:openai': `Codex${codexModel ? ` · ${codexModel}` : ''}`,
    'codex:local': `Codex · yerel${codexModel ? ` · ${codexModel}` : ''}`,
    'codex:nim': `Codex · NIM${form.elements.nimCoderModel.value ? ` · ${form.elements.nimCoderModel.value}` : ''}`,
    opencode: `OpenCode${form.elements.opencodeModel.value ? ` · ${form.elements.opencodeModel.value}` : ''}`,
  }[coder];
  const revSel = form.elements.reviewerModel;
  const claudeBase = (s.claudeModels || []).find((m) => m.id === (form.elements.claudeModel.value || s.claudeDefaultModel))?.label || form.elements.claudeModel.value || '';
  const revModel = revSel.value ? label(revSel) : coder === 'claude' ? '' : claudeBase;
  const reviewer = $('#reviewerBySel').value === 'auto' ? `Claude${revModel ? ` · ${revModel}` : ''}` : 'kodlayıcı';
  $('#stackSummary').textContent = `Yönetici: ${mgrName}${mgrModel ? ` · ${mgrModel}` : ''}   |   Kodlayıcı: ${coderName}   |   İnceleme: ${reviewer}`;
  renderWarnings();
}
for (const id of ['#managerBySel', '#coderSel', '#reviewerBySel']) $(id).addEventListener('change', syncVisibility);
form.addEventListener('change', (e) => {
  if (e.target.matches('select, input[name="codexModel"], input[name="anthropicModel"], input[name="opencodeModel"], input[name="opencodeManagerModel"], input[name="anthropicKey"], input[name="nimApiKey"]')) renderSummary();
  // Brif seçimi rol kartındaki "boş = …" etiketini belirler.
  if (e.target.name === 'briefBy') fillRoleSelects(state.settings);
  if (e.target.name === 'reviewLevel') syncProcess();
});

// Süreç sekmesi: "Standart" inceleme gücünde uzman paneli ve bağımsız denetim çalışmaz (bkz. orchestrator/pipeline.js,
// audit.js); kutular işaretli görünüp sessizce atlanmasın diye kapatılır ve nedeni yazılır.
function syncProcess() {
  const standard = form.elements.reviewLevel.value === 'standard';
  for (const el of $$('[data-deep-only]')) {
    el.classList.toggle('disabled', standard);
    el.querySelector('input').disabled = standard;
  }
  $('#reviewLevelHint').textContent = standard ? 'Standart güçte uzman paneli ve bağımsız denetim çalışmaz; ikisini de açmak için Derin ya da Maksimum seç.' : '';
}

function setThemeSeg(v) {
  form.elements.theme.value = v;
  $$('#themeSeg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.theme === v)));
}
$('#themeSeg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-theme]');
  if (b) setThemeSeg(b.dataset.theme);
});

// ---------- sekmeler ----------
function selectSettingsPane(pane) {
  pane = PANE_ALIAS[pane] || pane;
  $$('#settingsTabs .dtab').forEach((b) => b.classList.toggle('active', b.dataset.pane === pane));
  $$('#settingsForm .dpane').forEach((x) => x.classList.toggle('active', x.dataset.pane === pane));
}
$('#settingsTabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-pane]');
  if (b) selectSettingsPane(b.dataset.pane);
});

// ---------- toplama ve kaydetme ----------
function collectSettings() {
  const patch = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') patch[el.name] = el.checked;
    else if (el.type === 'number') patch[el.name] = Number(el.value);
    else patch[el.name] = el.value;
  }
  for (const k of KEY_FIELDS) if (!patch[k]) delete patch[k];
  // Claude kodlayıcı modeli Kodlayıcı kartındaki seçimdir; ayrı bir "kodlayıcı rolü" geçersiz kılması arayüzde yoktur.
  patch.coderModel = '';
  return patch;
}

async function saveSettings(patch) {
  const s = await attempt(() => api.saveSettings(patch));
  if (s) {
    state.settings = s;
    state.maxParallel = s.maxParallelJobs || state.maxParallel;
    renderAgentStatus();
    renderReadiness();
    renderThemeBtn();
  }
  return s;
}

$('#saveSettingsBtn').addEventListener('click', async (e) => {
  e.preventDefault();
  if (await saveSettings(collectSettings())) {
    dlg.close();
    toast('Ayarlar kaydedildi');
    refreshAgents();
  }
});

// ---------- bağlantılar: ajan kartları ----------
function renderAgentDetect() {
  if (!state.agents) return;
  const claude = state.agents.claude;
  if (claude) $('#agentDetect').innerHTML = connectionHtml(claude);
  const codex = state.agents.codex;
  if (codex) {
    const provider = form.elements.codexProvider.value || state.settings?.codexProvider || 'openai';
    const needsLogin = provider === 'openai';
    const status = !codex.found ? 'Kurulu değil' : needsLogin ? (codex.loggedIn === false ? 'Giriş gerekli' : 'Oturum açık') : provider === 'local' ? 'Yerel modelle (giriş gerekmez)' : 'NVIDIA NIM ile (giriş gerekmez)';
    $('#codexDetect').innerHTML = agentCardHtml(codex, { status, needsLogin });
  }
  const oc = state.agents.opencode;
  if (oc) {
    const status = !oc.found ? 'Kurulu değil' : oc.loggedIn ? `Sağlayıcı: ${oc.plan || 'var'}` : 'Sağlayıcı anahtarı yok (ücretsiz modeller yine çalışabilir)';
    $('#opencodeDetect').innerHTML = agentCardHtml(oc, { status, needsLogin: true, ok: oc.found });
  }
  // Algılama sonucu uyarıları etkiler (kurulum / giriş durumu).
  if (dlg.open) renderWarnings();
}

// Codex ve OpenCode kartı: sürüm, yol, güncelleme, test ve giriş düğmeleri.
function agentCardHtml(a, { status, needsLogin, ok = a.found && (!needsLogin || a.loggedIn !== false) }) {
  return `<div class="agent-card">
      <div class="top"><span class="dot ${ok ? 'done' : a.found ? 'waiting' : ''}"></span><b>${esc(a.label)}</b><span class="count">${a.found ? esc(semverOf(a.version)) : 'isteğe bağlı'}${a.installedVia ? ` · ${esc(a.installedVia)}` : ''}</span><span class="conn-state">${status}</span></div>
      ${a.found ? `<code>${esc(a.path)}</code>` : `<span>Kurulu değil. Kurulum:</span><code>${esc(a.install)}</code>`}
      ${a.updateAvailable ? `<div class="update-line">${ico('arrow-up')} Yeni sürüm var: <b>${esc(a.latest)}</b>${a.canUpdate ? ` <button type="button" class="btn sm" data-update-agent="${a.id}">Güncelle</button>` : ''}</div>` : ''}
      ${a.found ? `<div class="row"><button type="button" class="btn sm" data-test-agent="${a.id}">Bağlantıyı test et</button>${needsLogin ? `<button type="button" class="btn sm ghost" data-login-agent="${a.id}">Giriş yap</button>` : ''}</div>` : ''}
    </div>`;
}

async function updateAgent(id, btn) {
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Güncelleniyor…';
  }
  const r = await attempt(() => api.updateAgent(id));
  if (r) toast(r.after && r.before && r.after !== r.before ? `${AGENT_LABEL[id]} ${r.before} → ${r.after} güncellendi` : `${AGENT_LABEL[id]} bu kurulum yoluyla alınabilecek en yeni sürümde (${r.after || r.before}).`);
  await refreshAgents(true);
}

async function onAgentCardClick(e) {
  const up = e.target.closest('[data-update-agent]');
  if (up) return updateAgent(up.dataset.updateAgent, up);
  if (onConnClick(e)) return;
  const login = e.target.closest('[data-login-agent]');
  if (login) return connectAgent(login.dataset.loginAgent);
  const b = e.target.closest('[data-test-agent]');
  if (!b) return;
  await busy(b, 'Test ediliyor…', async () => {
    const r = await attempt(() => api.testAgent(b.dataset.testAgent));
    if (r) toast(`${AGENT_LABEL[b.dataset.testAgent]} çalışıyor. Yanıt: ${r.reply}`);
  });
  refreshAgents();
}
$('#agentDetect').addEventListener('click', onAgentCardClick);
$('#codexDetect').addEventListener('click', onAgentCardClick);
$('#opencodeDetect').addEventListener('click', onAgentCardClick);
// OpenCode modelleri: Bağlantılar'daki düğme ve Modeller'deki alan yanındaki düğmeler aynı listeyi çeker; ücretsiz ve
// NVIDIA modelleri üstte gelir, liste alana yazmaya başlayınca (ya da boş alana tıklayınca) öneri olarak açılır.
const OPENCODE_FIRST = /^(opencode|nvidia)\//;
async function loadOpencodeModels(btn) {
  await busy(btn, 'Getiriliyor…', async () => {
    const models = await attempt(() => api.listOpencodeModels());
    if (!models) return;
    lists.opencode = models.slice().sort((x, y) => (OPENCODE_FIRST.test(y.id) ? 1 : 0) - (OPENCODE_FIRST.test(x.id) ? 1 : 0));
    $('#opencodeModelList').innerHTML = lists.opencode.map((m) => opt(m.id)).join('');
    $('#opencodeModelHint').textContent = `${models.length} model; Modeller sekmesindeki OpenCode model alanlarına (yönetici / kodlayıcı) yazmaya başlayınca önerilir.`;
    toast(`${models.length} OpenCode modeli bulundu; alana yazmaya başlayınca liste açılır.`);
  });
}
form.addEventListener('click', (e) => {
  const b = e.target.closest('[data-load-opencode]');
  if (b) loadOpencodeModels(b);
  const p = e.target.closest('[data-preset]');
  if (p) applyPreset(p.dataset.preset);
});
$('#loadOpencodeModelsBtn').addEventListener('click', (e) => loadOpencodeModels(e.currentTarget));

// Düğmeyi işlem bitene kadar kilitler ve etiketini değiştirir (çift tıklama ve "çalışıyor mu?" belirsizliği olmasın).
async function busy(btn, label, fn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try {
    await fn();
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

// ---------- bağlantılar: sunucular ve anahtarlar ----------
// "Modelleri getir" ve "Test et" formdaki (henüz kaydedilmemiş) adres, anahtar ve model seçimiyle çalışır; hiçbir şey
// kaydetmez. Kaydetme yalnızca "Kaydet" ile olur: "Vazgeç" denince denenen adres ya da anahtar kalıcı olmaz. Boş alan ana
// süreçte kayıtlı ayardan tamamlanır (ör. anahtar alanı boşsa kayıtlı anahtar).
const serverArgs = (prefix) => ({
  baseUrl: form.elements[`${prefix}BaseUrl`].value.trim(),
  apiKey: form.elements[`${prefix}ApiKey`].value.trim(),
  model: $(`#${prefix}ModelSel`).value,
});

// Getirilen liste seçicilere yazılır; seçim yoksa ilk (NIM'de ilk önerilen) model seçilir.
function applyServerModels(kind, models) {
  lists[kind] = models;
  fillServerSelects(state.settings);
  const sel = $(MIRROR[kind][0]);
  if (!sel.value && models.length) {
    sel.value = (kind === 'nim' && models.map((m) => m.id).find((id) => NIM_CODING.test(id))) || models[0].id;
    fillServerSelects(state.settings); // aynalı seçici ve NIM rol listelerindeki "yöneticinin modeli" etiketi
  }
  renderSummary();
}

$('#loadLocalModelsBtn').addEventListener('click', (e) => busy(e.currentTarget, 'Getiriliyor…', async () => {
  const models = await attempt(() => api.listLocalModels(serverArgs('local')));
  if (!models) return;
  applyServerModels('local', models);
  toast(models.length ? `${models.length} yerel model bulundu; yandaki listeden seç. Kaydet ile kalıcı olur.` : 'Sunucuda model yok. Ollama için: ollama pull <model>', !models.length);
}));
$('#testLocalBtn').addEventListener('click', (e) => busy(e.currentTarget, 'Test ediliyor…', async () => {
  const r = await attempt(() => api.testLocal(serverArgs('local')));
  if (r) toast(`Yerel model çalışıyor (${r.model}): "${r.reply}"`);
}));
$('#clearLocalKeyBtn').addEventListener('click', async () => {
  if (await saveSettings({ clearLocalKey: true })) fillSettings();
});

$('#loadNimModelsBtn').addEventListener('click', (e) => busy(e.currentTarget, 'Getiriliyor…', async () => {
  const models = await attempt(() => api.listNimModels(serverArgs('nim')));
  if (!models) return;
  applyServerModels('nim', models);
  toast(`${models.length} NIM modeli bulundu; yandaki listeden seç. Kaydet ile kalıcı olur.`);
}));
$('#testNimBtn').addEventListener('click', (e) => busy(e.currentTarget, 'Test ediliyor…', async () => {
  const r = await attempt(() => api.testNim(serverArgs('nim')));
  if (r) toast(`NVIDIA NIM çalışıyor (${r.model}): "${r.reply}"`);
}));
$('#clearNimKeyBtn').addEventListener('click', async () => {
  if (await saveSettings({ clearNimKey: true })) fillSettings();
});

$('#loadAnthropicModelsBtn').addEventListener('click', (e) => busy(e.currentTarget, 'Getiriliyor…', async () => {
  const models = await attempt(() => api.listAnthropicModels({ apiKey: form.elements.anthropicKey.value.trim() }));
  if (!models) return;
  lists.anthropic = models;
  $('#anthropicModelList').innerHTML = models.map((m) => opt(m.id, m.label)).join('');
  toast(`${models.length} model bulundu; Modeller → Yönetici → Model alanına yaz.`);
}));
$('#testAnthropicBtn').addEventListener('click', (e) => busy(e.currentTarget, 'Test ediliyor…', async () => {
  const r = await attempt(() => api.testAnthropic({ apiKey: form.elements.anthropicKey.value.trim(), model: form.elements.anthropicModel.value.trim() }));
  if (r) toast(`Claude API çalışıyor (${r.model}): "${r.reply}"`);
}));
$('#clearAnthropicKeyBtn').addEventListener('click', async () => {
  if (!confirm('Kayıtlı Anthropic API anahtarı silinsin mi?')) return;
  if (await saveSettings({ clearAnthropicKey: true })) fillSettings();
});

$('#resetStandardsBtn').addEventListener('click', () => {
  $('#standardsInput').value = state.settings.defaultStandards;
});

// ---------- açma ----------
function openSettings(pane = 'models') {
  fillSettings();
  renderAgentDetect();
  selectSettingsPane(pane);
  if (!dlg.open) dlg.showModal();
  document.activeElement?.blur();
  // Bağlantı kartları güncel durumu göstersin (giriş / çıkış Sonda dışında yapılmış olabilir).
  if (!state.connect) refreshAgents(true);
  prefetchServerModels();
}
$('#settingsBtn').addEventListener('click', () => openSettings());

export { dlg, renderAgentDetect, updateAgent, openSettings, saveSettings };
