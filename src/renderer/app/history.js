// Görünüm değiştirme ve kenar çubuğu: proje geçmişi, iş açma, anahtar rozeti.
import { api, $, esc, firstLine, ACTIVE, KIND_LABEL, state, attempt, baseName, relDate, normDir } from './core.js';
import { renderReadiness } from './compose.js';
import { renderJob } from './job.js';
import { renderAllLogs, renderShots } from './logs.js';
import { selectTab } from './header.js';

// ---------- görünüm değiştirme ----------
function show(view) {
  state.view = view;
  $('#view-compose').hidden = view !== 'compose';
  $('#view-job').hidden = view !== 'job';
  renderHistory();
}

// ---------- geçmiş ----------
// Alt işleri gizlenen projeler tarayıcıda hatırlanır (yazılamazsa yalnızca bu oturumda geçerlidir).
const FOLD_KEY = 'sonda.fold';
try {
  for (const k of JSON.parse(localStorage.getItem(FOLD_KEY) || '[]')) state.collapsed.add(k);
} catch {
  /* kayıt yok ya da okunamadı */
}
const saveFold = () => {
  try {
    localStorage.setItem(FOLD_KEY, JSON.stringify([...state.collapsed]));
  } catch {
    /* yazılamadı */
  }
};

async function refreshHistory() {
  state.history = (await attempt(() => api.listJobs())) || [];
  renderHistory();
  renderReadiness();
}
let historyTimer;
const refreshHistorySoon = () => {
  clearTimeout(historyTimer);
  historyTimer = setTimeout(refreshHistory, 400);
};

// Kenar çubuğu proje bazlıdır: her klasör tek satır; o projede sonradan yapılan işler
// (özellik ekleme, hata düzeltme, refactor, ek istekler) projenin altında listelenir.
function groupHistory(list) {
  const groups = new Map();
  for (const j of list) {
    const key = normDir(j.projectDir) || j.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(j);
  }
  return [...groups.values()]
    .map((jobs) => {
      const asc = [...jobs].sort((a, b) => a.createdAt - b.createdAt);
      const root = asc.find((j) => !j.kind) || asc[0];
      const children = jobs.filter((j) => j !== root).sort((a, b) => b.createdAt - a.createdAt);
      const title = root.title || jobs.find((j) => j.title)?.title || root.idea || baseName(root.projectDir) || 'Proje';
      return { key: normDir(root.projectDir) || root.id, root, children, title, last: Math.max(...jobs.map((j) => j.createdAt)) };
    })
    .sort((a, b) => b.last - a.last);
}

const dotClass = (j) => (state.running.has(j.id) || ACTIVE.has(j.phase) ? 'running' : j.phase === 'done' ? 'done' : j.phase === 'failed' || j.phase === 'incomplete' ? 'failed' : j.phase === 'awaiting_approval' || j.phase === 'awaiting_answers' ? 'waiting' : '');
const isActiveRow = (j) => (state.view === 'job' && state.followId === j.id ? 'active' : '');

function renderHistory() {
  const ul = $('#history');
  if (!state.history.length) {
    ul.innerHTML = '<li class="empty">Henüz proje yok.</li>';
    return;
  }
  const MAX_CHILDREN = 4;
  ul.innerHTML = groupHistory(state.history)
    .map((g) => {
      const open = state.expanded.has(g.key);
      const folded = g.children.length > 0 && state.collapsed.has(g.key);
      // Seçili ya da çalışan alt iş gizli kalmasın.
      const mustShow = g.children.findIndex((c, i) => i >= MAX_CHILDREN && (state.followId === c.id || state.running.has(c.id)));
      const shown = folded ? [] : open || mustShow >= 0 ? g.children : g.children.slice(0, MAX_CHILDREN);
      const hidden = folded ? 0 : g.children.length - shown.length;
      const live = g.children.some((c) => state.running.has(c.id));
      // Kapalıyken seçili alt iş varsa düğme vurgulanır (hangi projenin altında olduğu belli olsun).
      const hasActive = folded && g.children.some((c) => c.id === state.followId);
      const foldBtn = g.children.length
        ? `<button class="h-fold ${folded ? 'folded' : ''}" data-fold="${esc(g.key)}" aria-expanded="${!folded}" title="${folded ? `${g.children.length} alt işi göster` : 'Alt işleri gizle'}" aria-label="${folded ? 'Alt işleri göster' : 'Alt işleri gizle'}"><svg class="ico" aria-hidden="true"><use href="#i-chevron"/></svg>${folded ? `<span class="h-count">${g.children.length}</span>` : ''}</button>`
        : '';
      const rootRow = `<li class="proj ${isActiveRow(g.root)} ${hasActive ? 'has-active' : ''}" data-id="${esc(g.root.id)}" title="${esc(g.root.projectDir || '')}">
          <span class="dot ${live && !state.running.has(g.root.id) ? 'running' : dotClass(g.root)}"></span>
          <div style="min-width:0"><div class="h-title">${esc(g.title)}</div>
          <div class="h-sub">${esc(baseName(g.root.projectDir))} · ${relDate(g.last)}</div></div>
          ${foldBtn}<button class="h-del" data-del="${esc(g.root.id)}" title="Geçmişten sil" aria-label="Geçmişten sil"><svg class="ico" aria-hidden="true"><use href="#i-x"/></svg></button></li>`;
      const childRows = shown
        .map((c) => {
          const label = c.kind ? KIND_LABEL[c.kind] : 'Ek istek';
          return `<li class="child ${isActiveRow(c)}" data-id="${esc(c.id)}" title="${esc(c.idea || '')}">
              <span class="dot ${dotClass(c)}"></span>
              <div style="min-width:0"><div class="h-title"><span class="h-kind kind-${esc(c.kind || 'more')}">${esc(label)}</span> ${esc(firstLine(c.idea, 80))}</div>
              <div class="h-sub">${relDate(c.createdAt)}</div></div>
              <button class="h-del" data-del="${esc(c.id)}" title="Geçmişten sil" aria-label="Geçmişten sil"><svg class="ico" aria-hidden="true"><use href="#i-x"/></svg></button></li>`;
        })
        .join('');
      const more = hidden > 0 ? `<li class="child more" data-more-group="${esc(g.key)}">＋ ${hidden} eski iş</li>` : !folded && open && g.children.length > MAX_CHILDREN ? `<li class="child more" data-more-group="${esc(g.key)}">Daha az göster</li>` : '';
      return rootRow + childRows + more;
    })
    .join('');
}

$('#history').addEventListener('click', async (e) => {
  const fold = e.target.closest('[data-fold]');
  if (fold) {
    e.stopPropagation();
    const k = fold.dataset.fold;
    state.collapsed.has(k) ? state.collapsed.delete(k) : state.collapsed.add(k);
    saveFold();
    renderHistory();
    return;
  }
  const more = e.target.closest('[data-more-group]');
  if (more) {
    const k = more.dataset.moreGroup;
    state.expanded.has(k) ? state.expanded.delete(k) : state.expanded.add(k);
    renderHistory();
    return;
  }
  const del = e.target.closest('[data-del]');
  if (del) {
    e.stopPropagation();
    if (!confirm('Bu iş geçmişten silinsin mi? (Proje dosyalarına dokunulmaz.)')) return;
    await attempt(() => api.deleteJob(del.dataset.del));
    if (state.followId === del.dataset.del) {
      state.followId = null;
      state.job = null;
      show('compose');
    }
    refreshHistory();
    return;
  }
  const li = e.target.closest('li[data-id]');
  if (li) openJob(li.dataset.id);
});

async function openJob(id) {
  const data = await attempt(() => api.loadJob(id));
  if (!data) return;
  state.followId = id;
  state.job = data.job;
  state.logs = data.logs || [];
  state.shots = (data.job.shots || []).filter((s) => s.dataUrl);
  state.openTasks = new Set();
  state.skip = new Set((data.job.tasks || []).filter((t) => t.status === 'skipped').map((t) => t.id));
  state.actionsKey = '';
  state.contentKey = '';
  state.summaryOpen = false;
  show('job');
  renderJob();
  renderAllLogs();
  renderShots();
  selectTab(data.job.report ? 'report' : 'logs');
  refreshJobEnv();
}

// İşin anahtar durumu (.env): kayıtlı adlar ve projenin istediği ama girilmemiş olanlar.
async function refreshJobEnv() {
  const job = state.job;
  if (!job) return;
  const v = await api.getEnv(job.projectDir).catch(() => null);
  if (!v || state.job !== job) return;
  job.env = {
    names: [...v.required.filter((r) => r.set).map((r) => r.name), ...v.extra.map((e) => e.name)],
    missing: v.required.filter((r) => r.needs && !r.set).map((r) => r.name),
  };
  renderEnvBadge();
}

function renderEnvBadge() {
  const env = state.job?.env;
  const b = $('#envBadge');
  const missing = env?.missing?.length || 0;
  const set = env?.names?.length || 0;
  b.hidden = !missing && !set;
  b.textContent = missing ? `${missing} eksik` : String(set);
  b.className = `nbadge ${missing ? '' : 'ok'}`;
  $('#envBtn').title = missing ? `Projenin istediği ama girilmemiş: ${env.missing.join(', ')}` : set ? `${set} anahtar kayıtlı` : 'API anahtarları ve ortam değişkenleri (.env)';
}

export { show, refreshHistory, refreshHistorySoon, renderHistory, openJob, refreshJobEnv, renderEnvBadge };
