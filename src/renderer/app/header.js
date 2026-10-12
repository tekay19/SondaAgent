// Sekmeler ve başlık eylemleri (durdur, sürdür, menü, çalıştır).
import { api, $, $$, state, toast, attempt, isLiveJob } from './core.js';
import { openMaint, zipCurrentProject } from './maintenance.js';
import { openEnv } from './env.js';

// ---------- sekmeler ----------
function selectTab(tab) {
  state.tab = tab;
  $$('.tab').forEach((t) => {
    const on = t.dataset.tab === tab;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
  });
  $$('.tab-pane').forEach((p) => p.classList.toggle('active', p.id === `tab-${tab}`));
}
$$('.tab').forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));
// Klavye: sekmeler arasında ok tuşlarıyla gezilir (tek bir sekme odak sırasındadır).
$('.tabs').addEventListener('keydown', (e) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  const tabs = $$('.tab');
  const i = tabs.findIndex((t) => t.dataset.tab === state.tab);
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  e.preventDefault();
  selectTab(tabs[next].dataset.tab);
  tabs[next].focus();
});

// ---------- başlık eylemleri ----------
$('#stopBtn').addEventListener('click', async () => {
  if (!state.job) return;
  if (isLiveJob() && !confirm('Çalışan iş durdurulsun mu? Daha sonra "Sürdür" ile kaldığı yerden devam edebilirsiniz.')) return;
  await attempt(() => api.stop(state.job.id));
});
$('#resumeBtn').addEventListener('click', () => state.job && attempt(() => api.resume(state.job.id)));
$('#envBtn').addEventListener('click', () => state.job && openEnv(state.job.projectDir));
const moreMenu = $('#moreMenu');
const setMenu = (open) => {
  moreMenu.hidden = !open;
  $('#moreBtn').setAttribute('aria-expanded', String(open));
};
$('#moreBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  setMenu(moreMenu.hidden);
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.menu-wrap')) setMenu(false);
});
moreMenu.addEventListener('click', (e) => {
  const b = e.target.closest('[data-more]');
  if (!b || !state.job) return;
  setMenu(false);
  if (b.dataset.more === 'folder') attempt(() => api.openProject(state.job.id));
  if (b.dataset.more === 'editor') attempt(() => api.openEditor(state.job.id));
  if (b.dataset.more === 'zip') zipCurrentProject(b);
  if (['feature', 'bugfix', 'refactor'].includes(b.dataset.more)) openMaint(b.dataset.more);
});
$('#runAppBtn').addEventListener('click', async () => {
  const job = state.job;
  if (!job) return;
  if (state.app.dir === job.projectDir && state.app.state === 'running') return attempt(() => api.stopApp());
  const r = await attempt(() => api.runApp(job.id));
  if (r?.url) toast(`Uygulama çalışıyor: ${r.url}`);
});

export { selectTab, setMenu };
