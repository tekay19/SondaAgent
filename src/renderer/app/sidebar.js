// Kenar çubuğunu açıp kapatan düğme (başlık çubuğundaki hamburger). Durum tarayıcıda hatırlanır.
import { $ } from './core.js';

const KEY = 'sonda.sidebar';

function setCollapsed(collapsed, save = true) {
  $('.app').classList.toggle('side-collapsed', collapsed);
  const btn = $('#sideToggle');
  const label = collapsed ? 'Kenar çubuğunu göster' : 'Kenar çubuğunu gizle';
  btn.setAttribute('aria-expanded', String(!collapsed));
  btn.setAttribute('aria-label', label);
  btn.title = label;
  if (!save) return;
  try {
    localStorage.setItem(KEY, collapsed ? 'collapsed' : 'open');
  } catch {
    /* yazılamadı: yalnızca bu oturumda geçerli */
  }
}

let stored = false;
try {
  stored = localStorage.getItem(KEY) === 'collapsed';
} catch {
  /* okunamadı */
}
setCollapsed(stored, false);
$('#sideToggle').addEventListener('click', () => setCollapsed(!$('.app').classList.contains('side-collapsed')));
