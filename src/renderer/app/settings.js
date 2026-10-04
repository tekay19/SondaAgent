// Ayarlar penceresi: Gemini, ajanlar, süreç, standartlar.
import { api, $, $$, esc, AGENT_LABEL, state, toast, attempt, ico, semverOf } from './core.js';
import { refreshAgents, renderAgentStatus, connectionHtml, onConnClick, connectAgent } from './agents.js';
import { renderThemeBtn } from './theme.js';
import { renderReadiness } from './compose.js';

// ---------- ayarlar ----------
const dlg = $('#settingsDialog');
const form = $('#settingsForm');

function fillSettings() {
  const s = state.settings;
  for (const el of form.elements) {
    if (!el.name || el.name === 'geminiKey' || el.name === 'standards') continue;
    if (el.type === 'checkbox') el.checked = !!s[el.name];
    else if (s[el.name] !== undefined) el.value = s[el.name];
  }
  form.elements.geminiKey.value = '';
  form.elements.geminiKey.placeholder = s.hasGeminiKey ? 'Yeni anahtar girmek için yazın' : 'AIza…';
  const where = { keychain: 'işletim sisteminin anahtar zincirinde şifreli', file: 'ayar dosyasında (bu sistemde şifreleme yok)', env: 'GEMINI_API_KEY ortam değişkeninden' }[s.geminiKeySource] || '';
  $('#keyHint').textContent = s.hasGeminiKey
    ? `Kayıtlı anahtar: ${s.geminiKeyMasked}${where ? ` (${where})` : ''}`
    : s.geminiKeyInvalid
      ? 'Kayıtlı anahtar okunamadı (bozuk ya da eski sürümden kalma). Anahtarı yeniden yapıştırıp kaydedin.'
      : 'Anahtar kayıtlı değil.';
  $('#keyHint').style.color = !s.hasGeminiKey && s.geminiKeyInvalid ? 'var(--warn)' : '';
  $('#standardsInput').value = s.standards || s.defaultStandards;
  setThemeSeg(s.theme || 'system');
  fillModelSelect(s);
}

// Claude modeli: açık bir seçim listesi. İlk seçenek varsayılandır (Opus 5.5); "Özel" kimlik alanını açar.
const modelSel = $('#claudeModelSel');
const modelCustom = $('#claudeModelCustom');
function fillModelSelect(s) {
  const models = s.claudeModels || [];
  const def = s.claudeDefaultModel;
  const saved = String(s.claudeModel || '').trim();
  modelSel.innerHTML = models
    .map((m) => `<option value="${m.id === def ? '' : esc(m.id)}">${esc(m.label)}${m.id === def ? ' — varsayılan (önerilen)' : m.note ? ` — ${esc(m.note)}` : ''}</option>`)
    .join('') + '<option value="__custom">Özel model kimliği…</option>';
  const known = !saved || saved === def || models.some((m) => m.id === saved);
  modelSel.value = !saved || saved === def ? '' : known ? saved : '__custom';
  modelCustom.value = known ? '' : saved;
  syncModelField();
}
function syncModelField() {
  const custom = modelSel.value === '__custom';
  $('#claudeModelCustomField').hidden = !custom;
  form.elements.claudeModel.value = custom ? modelCustom.value.trim() : modelSel.value;
  const s = state.settings || {};
  const id = form.elements.claudeModel.value || s.claudeDefaultModel || '';
  $('#claudeModelHint').textContent = `Planlama, kodlama ve incelemeler bu modelle çalışır: ${id}`;
}
modelSel.addEventListener('change', () => {
  syncModelField();
  if (modelSel.value === '__custom') modelCustom.focus();
});
modelCustom.addEventListener('input', syncModelField);

function setThemeSeg(v) {
  form.elements.theme.value = v;
  $$('#themeSeg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.theme === v)));
}
$('#themeSeg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-theme]');
  if (b) setThemeSeg(b.dataset.theme);
});

function selectSettingsPane(pane) {
  $$('#settingsTabs .dtab').forEach((b) => b.classList.toggle('active', b.dataset.pane === pane));
  $$('#settingsForm .dpane').forEach((x) => x.classList.toggle('active', x.dataset.pane === pane));
}
$('#settingsTabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-pane]');
  if (b) selectSettingsPane(b.dataset.pane);
});

function collectSettings() {
  const patch = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') patch[el.name] = el.checked;
    else if (el.type === 'number') patch[el.name] = Number(el.value);
    else patch[el.name] = el.value;
  }
  if (!patch.geminiKey) delete patch.geminiKey;
  return patch;
}

function renderAgentDetect() {
  const el = $('#agentDetect');
  if (!el || !state.agents) return;
  el.innerHTML = Object.values(state.agents)
    .map((a) => {
      if (a.id === 'claude') return connectionHtml(a);
      // Codex isteğe bağlıdır: yalnızca kodlayan ajan olarak seçilirse gerekir.
      return `<div class="agent-card">
        <div class="top"><span class="dot ${a.found && a.loggedIn !== false ? 'done' : a.found ? 'waiting' : ''}"></span><b>${esc(a.label)}</b><span class="count">${a.found ? esc(semverOf(a.version)) : 'isteğe bağlı'}${a.installedVia ? ` · ${esc(a.installedVia)}` : ''}</span></div>
        ${a.found ? `<code>${esc(a.path)}</code>` : `<span>Kurulu değil. Kurulum:</span><code>${esc(a.install)}</code>`}
        ${a.updateAvailable ? `<div class="update-line">${ico('arrow-up')} Yeni sürüm var: <b>${esc(a.latest)}</b>${a.canUpdate ? ` <button type="button" class="btn sm" data-update-agent="${a.id}">Güncelle</button>` : ''}</div>` : ''}
        ${a.found && a.loggedIn === false ? '<span style="color:var(--warn-text)">Oturum açık değil.</span>' : a.loggedIn ? '<span style="color:var(--ok-text)">Oturum açık</span>' : ''}
        ${a.found ? `<div class="row"><button type="button" class="btn sm" data-test-agent="${a.id}">Bağlantıyı test et</button><button type="button" class="btn sm" data-login-agent="${a.id}">Giriş yap</button></div>` : ''}
      </div>`;
    })
    .join('');
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

$('#agentDetect').addEventListener('click', async (e) => {
  const up = e.target.closest('[data-update-agent]');
  if (up) return updateAgent(up.dataset.updateAgent, up);
  if (onConnClick(e)) return;
  const login = e.target.closest('[data-login-agent]');
  if (login) return connectAgent(login.dataset.loginAgent);
  const b = e.target.closest('[data-test-agent]');
  if (!b) return;
  b.disabled = true;
  b.textContent = 'Test ediliyor…';
  const r = await attempt(() => api.testAgent(b.dataset.testAgent));
  b.disabled = false;
  b.textContent = 'Bağlantıyı test et';
  if (r) toast(`${AGENT_LABEL[b.dataset.testAgent]} çalışıyor ve oturum açık. Yanıt: ${r.reply}`);
  refreshAgents();
});

function openSettings(pane = 'general') {
  fillSettings();
  renderAgentDetect();
  selectSettingsPane(pane);
  if (!dlg.open) dlg.showModal();
  document.activeElement?.blur();
  // Bağlantı kartı güncel durumu göstersin (giriş / çıkış Sonda dışında yapılmış olabilir).
  if (pane === 'agents' && !state.connect) refreshAgents(true);
}
$('#settingsBtn').addEventListener('click', () => openSettings());

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
$('#clearKeyBtn').addEventListener('click', async () => {
  if (!confirm('Kayıtlı Gemini API anahtarı silinsin mi?')) return;
  if (await saveSettings({ clearGeminiKey: true })) fillSettings();
});
$('#loadModelsBtn').addEventListener('click', async () => {
  const key = form.elements.geminiKey.value.trim();
  if (key && !(await saveSettings({ geminiKey: key }))) return;
  const models = await attempt(() => api.listModels());
  if (!models) return;
  $('#modelList').innerHTML = models.map((m) => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join('');
  toast(`${models.length} model bulundu.`);
  fillSettings();
});
$('#testGeminiBtn').addEventListener('click', async () => {
  const patch = { geminiModel: form.elements.geminiModel.value.trim() };
  const key = form.elements.geminiKey.value.trim();
  if (key) patch.geminiKey = key;
  if (!(await saveSettings(patch))) return;
  fillSettings();
  const r = await attempt(() => api.testGemini());
  if (r) toast(`Gemini çalışıyor (${r.model}): "${r.reply}"`);
});
$('#resetStandardsBtn').addEventListener('click', () => {
  $('#standardsInput').value = state.settings.defaultStandards;
});

export { dlg, renderAgentDetect, updateAgent, openSettings, saveSettings };
