// Log akışı ve ekran görüntüleri.
import { $, $$, esc, stIcon, AGENT_SHORT, SRC_LABEL, managerOf, state, fmtTime } from './core.js';
import { emptyHtml } from './theme.js';
import { setMenu } from './header.js';

// ---------- log akışı ----------
function logVisible(e) {
  const f = state.logFilter;
  if (f === 'all' || e.lvl === 'step') return true;
  if (f === 'problems') return e.lvl === 'warn' || e.lvl === 'error';
  // Eski işlerin günlüğünde yönetici kaynağı "gemini" adıyla kayıtlıdır.
  return e.src === f || (f === 'manager' && e.src === 'gemini');
}
function srcLabel(src) {
  if (src === 'manager' || src === 'gemini') return managerOf(state.settings).name;
  return src === 'agent' ? AGENT_SHORT[state.job?.agent] || 'Ajan' : SRC_LABEL[src] || src;
}
// Satır başındaki ✓ / ✗ işaretleri durum baklavasına çevrilir (✓ bitti, ✗ olmadı).
const MARKS = { '✓': 'done', '✗': 'failed' };
function logMsg(text) {
  const t = String(text ?? '');
  const mark = MARKS[t[0]];
  return mark ? `<span class="log-mark ${mark}">${stIcon(mark)}</span>${esc(t.slice(1).trimStart())}` : esc(t);
}
function logHtml(e) {
  return `<div class="log ${e.lvl}"><span class="t">${fmtTime(e.t)}</span><span class="src ${e.src}">${esc(srcLabel(e.src))}</span><span class="msg">${logMsg(e.text)}</span></div>`;
}
const MAX_DOM_LOGS = 5000;
let pendingLogs = [];
let logFrame = 0;
function renderAllLogs() {
  const list = $('#logList');
  // Tam yeniden çizim sıradaki satırları da kapsar; kuyrukta bekleyenler ikinci kez eklenmesin.
  pendingLogs = [];
  const vis = state.logs.filter(logVisible).slice(-MAX_DOM_LOGS);
  list.innerHTML = vis.length ? vis.map(logHtml).join('') : emptyHtml('Henüz kayıt yok.', 'log-empty');
  const pane = $('#tab-logs');
  pane.scrollTop = pane.scrollHeight;
}
function appendLog(entry) {
  state.logs.push(entry);
  if (state.logs.length > 20000) state.logs.splice(0, 5000);
  if (!logVisible(entry)) return;
  pendingLogs.push(entry);
  if (logFrame) return;
  logFrame = requestAnimationFrame(() => {
    logFrame = 0;
    const pane = $('#tab-logs');
    const list = $('#logList');
    const stick = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 120;
    list.querySelector('.log-empty')?.remove();
    list.insertAdjacentHTML('beforeend', pendingLogs.map(logHtml).join(''));
    pendingLogs = [];
    while (list.childElementCount > MAX_DOM_LOGS) list.firstElementChild.remove();
    if (stick) pane.scrollTop = pane.scrollHeight;
  });
}
$('#logFilters').addEventListener('click', (e) => {
  const b = e.target.closest('[data-f]');
  if (!b) return;
  state.logFilter = b.dataset.f;
  $$('#logFilters .filter').forEach((x) => x.classList.toggle('active', x === b));
  renderAllLogs();
});

// ---------- ekran görüntüleri ----------
function renderShots() {
  $('#shotCount').textContent = state.shots.length ? state.shots.length : '';
  const grid = $('#shotGrid');
  if (!state.shots.length) {
    grid.innerHTML = `<div style="grid-column:1/-1">${emptyHtml('Henüz ekran görüntüsü yok.')}</div>`;
    return;
  }
  grid.innerHTML = state.shots
    .map((s) => {
      const bad = (s.status && s.status >= 400) || s.errors?.length;
      return `<div class="shot ${s.viewport === 'mobil' ? 'mobile' : ''}">
          <img src="${s.dataUrl}" alt="${esc(s.route)} ekran görüntüsü" data-zoom />
          <div class="shot-meta">
            <div class="r"><code>${esc(s.route)}</code><span class="badge">${esc(s.viewport)}</span><span class="badge ${bad ? 'err' : 'ok'}">HTTP ${s.status ?? '?'}</span></div>
            ${s.title ? `<div style="color:var(--muted)">${esc(s.title)}</div>` : ''}
            ${s.errors?.length ? `<div class="shot-errors">${s.errors.map(esc).join('\n')}</div>` : ''}
          </div></div>`;
    })
    .join('');
}
$('#shotGrid').addEventListener('click', (e) => {
  const img = e.target.closest('img[data-zoom]');
  if (!img) return;
  const box = document.createElement('div');
  box.className = 'lightbox';
  box.innerHTML = `<img src="${img.src}" alt="" />`;
  box.onclick = () => box.remove();
  document.body.appendChild(box);
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  $('.lightbox')?.remove();
  setMenu(false);
});

export { renderAllLogs, appendLog, renderShots };
