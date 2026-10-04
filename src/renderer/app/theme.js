// Tema düğmesi ve boş durum görselleri.
import { $, state } from './core.js';
import { saveSettings } from './settings.js';

// ---------- tema: sistem (gece-gündüz gözü) → açık (kilim güneşi) → koyu (Ülker) ----------
const THEMES = {
  system: ['ic-auto', 'Sistem'],
  light: ['ic-sun', 'Açık'],
  dark: ['ic-ulker', 'Koyu'],
};
const NEXT_THEME = { system: 'light', light: 'dark', dark: 'system' };
function renderThemeBtn() {
  const t = THEMES[state.settings?.theme] ? state.settings.theme : 'system';
  const [icon, label] = THEMES[t];
  $('#themeBtn').innerHTML = `<svg class="ic"><use href="#${icon}"/></svg>`;
  $('#themeBtn').title = `Tema: ${label} — ${THEMES[NEXT_THEME[t]][1]} için tıklayın`;
}
$('#themeBtn').addEventListener('click', async () => {
  const t = THEMES[state.settings?.theme] ? state.settings.theme : 'system';
  await saveSettings({ theme: NEXT_THEME[t] });
  renderThemeBtn();
});

// Boş ekranlar: kilim gözü motifi (okuma alanlarında motif yok).
const emptyHtml = (text, cls = 'md-empty') => `<div class="${cls}"><svg class="empty-motif" aria-hidden="true"><use href="#m-goz"/></svg><div>${text}</div></div>`;
const KLOADER = '<span class="kloader" aria-hidden="true"><i></i><i></i><i></i></span>';

export { renderThemeBtn, emptyHtml, KLOADER };
