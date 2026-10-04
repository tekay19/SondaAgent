// Ajan durumu ve bağlantı: kurulum → giriş → model testi.
import { stIcon, api, $, esc, AGENT_LABEL, AGENT_SHORT, state, toast, attempt, ico, semverOf } from './core.js';
import { show } from './history.js';
import { KLOADER } from './theme.js';
import { renderReadiness } from './compose.js';
import { dlg, renderAgentDetect, openSettings } from './settings.js';

// ---------- ajan durumu ----------
async function refreshAgents(force = false) {
  state.agents = (await attempt(() => api.detectAgents({ force }))) || null;
  renderAgentStatus();
  renderReadiness();
  renderAgentDetect();
}

function renderAgentStatus() {
  const s = state.settings;
  const items = [`<span class="as" title="Gemini ${esc(s?.geminiModel || '')}${s?.hasGeminiKey ? '' : ' — API anahtarı yok'}"><span class="dot ${s?.hasGeminiKey ? 'done' : 'failed'}"></span>Gemini</span>`];
  for (const a of Object.values(state.agents || {})) {
    // Codex isteğe bağlıdır: kurulu değilse ve seçili ajan da değilse durum satırını kalabalıklaştırmaz.
    if (a.id !== 'claude' && !a.found && state.compose.agent !== a.id) continue;
    const ok = a.found && a.loggedIn !== false;
    const tip = !a.found
      ? `${a.label} kurulu değil — bağlamak için tıklayın`
      : a.loggedIn === false
        ? `${a.label}: giriş gerekli — bağlamak için tıklayın`
        : `${a.label} ${semverOf(a.version)}${a.plan ? ` · ${a.plan} aboneliği` : ''}${modelLabelOf(a) ? ` · model: ${modelLabelOf(a)}` : ''}${a.updateAvailable ? ` — yeni sürüm var: ${a.latest}` : ''}`;
    items.push(`<span class="as" title="${esc(tip)}"><span class="dot ${ok ? 'done' : a.found ? 'waiting' : ''}"></span>${esc(AGENT_SHORT[a.id] || a.label)}${a.id === 'claude' && ok && modelLabelOf(a) ? `<small>${esc(modelLabelOf(a))}</small>` : ''}</span>`);
  }
  $('#agentStatus').innerHTML = items.join('');
}
$('#agentStatus').addEventListener('click', () => openSettings('agents'));

// ---------- Bağlantı: kurulum → giriş → model testi (tek düğmeyle) ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Bağlantı kartı yalnızca yapılacak bir şey varken yeni iş ekranında görünür.
const needsConnection = (a) => !a.found || a.loggedIn === false || state.connect?.id === a.id || state.connTest[a.id]?.ok === false;
// Claude'un kullanacağı modelin adı: her zaman güncel ayardan (algılama sonucu eski kalmış olabilir).
const modelLabelOf = (a) => (a.id === 'claude' ? state.settings?.claudeModelLabel || a.modelLabel || '' : a.modelLabel || '');
const renderConn = () => {
  renderAgentStatus();
  renderReadiness();
  renderAgentDetect();
};
let connFrame = 0;
const renderConnSoon = () => {
  if (connFrame) return;
  connFrame = requestAnimationFrame(() => {
    connFrame = 0;
    renderConn();
  });
};

function connectionHtml(a, { compact = false } = {}) {
  const c = state.connect?.id === a.id ? state.connect : null;
  const test = state.connTest[a.id];
  const model = modelLabelOf(a);
  const step = (n, status, title, detail) =>
    `<li class="${status}"><span class="conn-ic">${status === 'done' ? stIcon('done') : status === 'active' ? KLOADER : status === 'error' ? stIcon('failed') : n}</span><div><b>${title}</b><span>${detail}</span></div></li>`;
  const installed = a.found
    ? ['done', `${esc(semverOf(a.version))}${a.installedVia ? ` · ${esc(a.installedVia)}` : ''}`]
    : c?.step === 'install'
      ? ['active', 'Resmi yükleyici çalışıyor; 1–2 dakika sürebilir…']
      : ['todo', 'Bu bilgisayarda kurulu değil. Sonda senin için kurar.'];
  const login = !a.found && c?.step !== 'login'
    ? ['todo', 'Claude (Pro / Max) hesabınla tarayıcıda giriş yapılır.']
    : c?.step === 'login'
      ? ['active', 'Tarayıcıda giriş sayfası açıldı; giriş yapınca Sonda algılar.']
      : a.loggedIn === true
        ? [a.subscription === false ? 'warn' : 'done', `${a.plan ? `${esc(a.plan)} aboneliği` : a.subscription === false ? 'API faturalı hesap (abonelik değil)' : 'oturum açık'}${a.account ? ` · ${esc(a.account)}` : ''}`]
        : ['todo', 'Giriş gerekli. Claude (Pro / Max) hesabınla tarayıcıda giriş yapılır.'];
  const tested = c?.step === 'test'
    ? ['active', `${esc(model)} ile deneme isteği gönderiliyor…`]
    : test?.ok
      ? ['done', `${esc(test.model || model)} yanıt verdi.`]
      : test && !test.ok
        ? ['error', `${esc(test.error || 'Deneme isteği başarısız.')}${/model/i.test(test.error || '') ? ' Ayarlar → Ajanlar → Model\'den başka bir model seçip yeniden deneyebilirsin.' : ''}`]
        : ['todo', a.found && a.loggedIn === true ? `Henüz denenmedi. ${esc(model)} ile küçük bir istek gönderilir.` : `Giriş sonrası ${esc(model)} ile küçük bir istek gönderilir.`];
  const ready = a.found && a.loggedIn === true;
  const label = !a.found ? `${ico('arrow-up')} Claude'u kur ve bağla` : a.loggedIn !== true ? `${ico('lock')} Giriş yap` : `${ico('refresh')} Bağlantıyı test et`;
  const primary = c
    ? c.step === 'login' ? '<button type="button" class="btn sm" data-conn="cancel">Vazgeç</button>' : ''
    : `<button type="button" class="btn sm ${ready && test?.ok !== false ? '' : 'primary'}" data-conn="connect" data-agent-id="${a.id}">${label}</button>`;
  const state1 = c ? 'Bağlanıyor…' : ready ? (test?.ok === false ? 'Bağlı ama model yanıt vermedi' : `Bağlı${a.plan ? ` · ${esc(a.plan)} aboneliği` : ''}${model ? ` · ${esc(model)}` : ''}`) : !a.found ? 'Kurulu değil' : 'Giriş gerekli';
  const extra = compact || c ? '' : `<div class="conn-actions">
        ${ready ? `<button type="button" class="btn sm ghost" data-conn="switch" data-agent-id="${a.id}" title="Çıkış yapıp başka bir Claude hesabıyla giriş yap">Hesap değiştir</button>` : ''}
        ${a.updateAvailable && a.canUpdate ? `<button type="button" class="btn sm ghost" data-update-agent="${a.id}">${ico('arrow-up')} ${esc(a.latest)} sürümüne güncelle</button>` : a.found && a.latest ? '<span class="hint">CLI güncel</span>' : ''}
        ${a.found ? `<code title="CLI yolu">${esc(a.path)}</code>` : ''}
      </div>`;
  const log = c?.step === 'install' && c.lines.length ? `<pre class="conn-log">${esc(c.lines.slice(-6).join('\n'))}</pre>` : '';
  const loginHelp = c?.step === 'login' ? '<div class="hint conn-help">Terminal giriş komutunu çalıştırır; bitince pencereyi kapatabilirsin.</div>' : '';
  const warn = !c && a.loggedIn === true && a.subscription === false ? '<div class="hint conn-help warn-hint">Bu hesap API kullanımıyla faturalanıyor; "Hesap değiştir" ile Pro / Max hesabınla giriş yap.</div>' : '';
  return `<div class="conn-card ${compact ? 'compact' : ''}">
      <div class="conn-head"><span class="dot ${c ? 'running' : ready && test?.ok !== false ? 'done' : 'waiting'}"></span><b>${esc(a.label)}</b><span class="conn-state">${state1}</span>${primary}</div>
      <ol class="conn-steps">${step(1, installed[0], 'Kurulum', installed[1])}${step(2, login[0], 'Hesap girişi', login[1])}${step(3, tested[0], 'Model testi', tested[1])}</ol>
      ${log}${loginHelp}${warn}${extra}
    </div>`;
}

// Bağlantı kartındaki düğmeler (yeni iş ekranında ve Ayarlar'da aynı).
function onConnClick(e) {
  const b = e.target.closest('[data-conn]');
  if (!b) return false;
  const id = b.dataset.agentId || state.connect?.id || 'claude';
  if (b.dataset.conn === 'connect') connectAgent(id);
  if (b.dataset.conn === 'cancel' && state.connect) {
    state.connect.cancelled = true;
    state.connect = null;
    renderConn();
  }
  if (b.dataset.conn === 'switch') switchAccount(id);
  return true;
}

async function runConnTest(id) {
  try {
    await api.testAgent(id);
    state.connTest[id] = { ok: true, model: id === 'claude' ? state.settings?.claudeModelLabel || '' : '' };
  } catch (e) {
    state.connTest[id] = { ok: false, error: String(e.message || e).split('\n')[0].slice(0, 220) };
  }
  return state.connTest[id];
}

// Tek düğme: gerekirse kur → gerekirse giriş yap (tarayıcı) → seçili modelle dene.
async function connectAgent(id) {
  if (state.connect) return;
  const c = (state.connect = { id, step: null, lines: [], cancelled: false });
  delete state.connTest[id];
  // Bağlantı kartı yeni iş ekranındadır: iş ekranından başlatıldıysa oraya geç ki adımlar görünsün.
  if (state.view !== 'compose' && !dlg.open) {
    show('compose');
    toast('Bağlantı kuruluyor; ilerleme yeni iş ekranındaki kartta.');
  }
  try {
    if (!state.agents?.[id]?.found) {
      c.step = 'install';
      renderConn();
      await api.installAgent(id);
      await refreshAgents(true);
      if (!state.agents?.[id]?.found) throw new Error('Kurulum bitti ama CLI bulunamadı. Sonda\'yı kapatıp açtıktan sonra tekrar deneyin.');
    }
    let auth = await api.agentAuth(id).catch(() => null);
    if (auth?.loggedIn !== true) {
      c.step = 'login';
      renderConn();
      await api.loginAgent(id);
      const until = Date.now() + 10 * 60000;
      while (!c.cancelled && Date.now() < until && auth?.loggedIn !== true) {
        await sleep(2500);
        auth = await api.agentAuth(id).catch(() => null);
      }
      if (c.cancelled) return;
      if (auth?.loggedIn !== true) throw new Error('Giriş 10 dakika içinde tamamlanmadı. "Giriş yap" ile yeniden deneyebilirsin.');
    }
    c.step = 'test';
    renderConn();
    const t = await runConnTest(id);
    if (c.cancelled) return;
    await refreshAgents(true);
    const a = state.agents?.[id];
    if (t.ok) toast(`${AGENT_LABEL[id]} bağlandı${a?.plan ? ` · ${a.plan} aboneliği` : ''}${t.model ? ` · ${t.model}` : ''}`);
    else toast(`${AGENT_LABEL[id]} giriş yaptı ama ${state.settings?.claudeModelLabel || 'model'} yanıt vermedi: ${t.error}`, true);
  } catch (e) {
    if (!c.cancelled) toast(e.message || String(e), true);
  } finally {
    if (state.connect === c) state.connect = null;
    renderConn();
  }
}

async function switchAccount(id) {
  if (state.running.size) return toast('Çalışan iş varken hesap değiştirilemez. Önce işleri durdurun ya da bitmesini bekleyin.', true);
  if (!confirm(`${AGENT_LABEL[id]} hesabından çıkış yapılıp yeniden giriş ekranı açılsın mı?\n\nBu bilgisayarda aynı girişi kullanan Claude Code terminal oturumları da çıkış yapmış olur.`)) return;
  if (!(await attempt(() => api.logoutAgent(id)))) return;
  delete state.connTest[id];
  await refreshAgents(true);
  connectAgent(id);
}

export { refreshAgents, renderAgentStatus, needsConnection, renderConnSoon, connectionHtml, onConnClick, connectAgent };
