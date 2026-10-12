// Giriş noktası: ana süreç olayları ve başlangıç.
import './maintenance.js';
import './env.js';
import './sidebar.js';
import { api, $, IS_MAC, managerOf, state, attempt } from './core.js';
import { show, refreshHistory, refreshHistorySoon, renderHistory, openJob } from './history.js';
import { refreshAgents, renderAgentStatus, renderConnSoon } from './agents.js';
import { renderThemeBtn } from './theme.js';
import { setAgent, renderFolder, renderAttachments, renderReadiness } from './compose.js';
import { renderJob } from './job.js';
import { appendLog, renderShots } from './logs.js';
import { selectTab } from './header.js';
import { openSettings } from './settings.js';

// ---------- olaylar ----------
api.onEvent((evt) => {
  if (evt.type === 'job') {
    if (evt.job.id === state.followId) {
      state.job = evt.job;
      if (state.view === 'job') renderJob();
    }
    refreshHistorySoon();
  } else if (evt.type === 'log') {
    if (evt.jobId === state.followId) appendLog(evt.entry);
  } else if (evt.type === 'shots') {
    if (evt.jobId === state.followId) {
      state.shots = evt.shots;
      renderShots();
    }
  } else if (evt.type === 'busy') {
    state.running = new Set(evt.running || []);
    state.contentKey = '';
    state.actionsKey = '';
    if (state.job && state.view === 'job') renderJob();
    renderReadiness();
    renderHistory();
    refreshHistorySoon();
    if (!evt.busy && evt.jobId === state.job?.id && state.job?.phase === 'done') selectTab('report');
  } else if (evt.type === 'app') {
    state.app = evt;
    if (state.job && state.view === 'job') renderJob();
  } else if (evt.type === 'setup') {
    // Kurulum çıktısı: bağlantı kartında son satırlar görünür.
    if (state.connect?.id === evt.agentId) {
      state.connect.lines.push(evt.line);
      if (state.connect.lines.length > 40) state.connect.lines.shift();
      renderConnSoon();
    }
  }
});

// Pencereye dönünce bağlantı durumunu kendiliğinden yenile: başka bir yerde giriş / çıkış yapılmış ya da
// Claude Code kurulmuş olabilir. Hızlı oturum yoklaması yapılır; durum değiştiyse tam algılama çalışır.
let focusCheck = 0;
window.addEventListener('focus', async () => {
  if (state.connect || Date.now() - focusCheck < 12000) return;
  focusCheck = Date.now();
  const cur = state.agents?.claude;
  if (!cur) return;
  if (!cur.found) return refreshAgents(true);
  const auth = await api.agentAuth('claude').catch(() => null);
  if (auth && auth.loggedIn !== null && auth.loggedIn !== cur.loggedIn) refreshAgents(true);
});

// ---------- başlangıç ----------
async function init() {
  document.body.classList.add(api.platform);
  $('#planBtn .kbd').textContent = IS_MAC ? '⌘↵' : 'Ctrl+↵';
  state.settings = await attempt(() => api.getSettings());
  renderThemeBtn();
  if (state.settings) {
    state.compose.projectDir = state.settings.lastProjectDir || '';
    setAgent(state.settings.defaultAgent || 'claude');
  }
  renderFolder();
  renderAttachments();
  renderAgentStatus();
  renderReadiness();
  selectTab('logs');
  await refreshHistory();
  const cur = await attempt(() => api.current());
  state.running = new Set(cur?.running || []);
  state.maxParallel = cur?.max || 3;
  state.app = (await attempt(() => api.appStatus())) || state.app;
  if (cur?.job && cur.busy) await openJob(cur.job.id);
  else show('compose');
  refreshAgents();
  if (!managerOf(state.settings).has) setTimeout(() => openSettings(), 400);
}
init();
