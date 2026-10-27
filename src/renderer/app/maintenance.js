// Projede devam et: özellik ekle, hata düzelt, refactor; zip paketi.
import { api, $, $$, esc, state, toast, attempt, baseName, ico, dirBusy } from './core.js';
import { isDesignAtt, attChip, addAttachments, followNewJob } from './compose.js';

// ---------- Projede devam et: özellik ekle / hata düzelt / refactor ----------
const maintDlg = $('#maintDialog');
const MAINT_UI = {
  feature: {
    intro: 'Ne eklensin, kim kullanacak, hangi kurallar geçerli? Her özellik için ayrı kutu.',
    ph: ['Ne eklensin?', 'Başka bir özellik'],
    add: 'Başka özellik ekle',
    attach: 'Doküman / ekran görüntüsü ekle',
    start: 'Özelliği tasarla',
    empty: 'Eklenecek özelliği tarif et.',
  },
  bugfix: {
    intro: 'Ne yaptın, ne oldu, ne olmalıydı? Her hata için ayrı kutu; hata mesajını yapıştırabilirsin.',
    ph: ['Ne yaptın, ne oldu, ne olmalıydı?', 'Başka bir hata'],
    add: 'Başka hata ekle',
    attach: 'Ekran görüntüsü / log ekle',
    start: 'Hatayı incele',
    empty: 'En az bir hatayı tarif et: ne yaptın, ne oldu, ne olmalıydı?',
  },
  refactor: { attach: 'Doküman ekle', start: 'Kodu incele' },
};

function openMaint(kind) {
  const job = state.job;
  if (!job) return;
  if (dirBusy(job.projectDir)) return toast('Bu projede şu anda çalışan bir iş var. Bitmesini bekleyin ya da durdurun.', true);
  // Kadro işten devralınır (eski işte kadro yoksa yalnızca kodlayıcı; gerisi Ayarlar'dan).
  state.maint = { dir: job.projectDir, agent: job.agent, stack: job.stack || { agent: job.agent }, kind, items: { feature: [''], bugfix: [''] }, focus: '', attachments: [] };
  $('#maintTitle').textContent = job.plan?.projectName ? `${job.plan.projectName} — devam et` : 'Projede devam et';
  $('#maintDir').textContent = job.projectDir;
  $('#maintDir').title = job.projectDir;
  renderMaint();
  maintDlg.showModal();
  (kind === 'refactor' ? $('#refFocus') : $('[data-bug="0"]', maintDlg))?.focus();
}

function renderMaint() {
  const m = state.maint;
  const ui = MAINT_UI[m.kind];
  $$('#maintSeg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.kind === m.kind)));
  $('#maintBugPane').hidden = m.kind === 'refactor';
  $('#maintRefPane').hidden = m.kind !== 'refactor';
  $('#refFocus').value = m.focus;
  if (m.kind !== 'refactor') {
    const list = m.items[m.kind];
    $('#maintIntro').innerHTML = ui.intro;
    $('#bugAddLabel').textContent = ui.add;
    $('#bugList').innerHTML = list
      .map((b, i) => `<div class="bug-card kind-${m.kind}"><span class="bug-no">${i + 1}</span><textarea data-bug="${i}" rows="3" placeholder="${esc(ui.ph[Math.min(i, 1)])}">${esc(b)}</textarea>${list.length > 1 ? `<button type="button" class="icon-btn" data-bug-del="${i}" title="Kaldır" aria-label="Kaldır">${ico('x')}</button>` : '<span></span>'}</div>`)
      .join('');
  }
  $('#maintAttachLabel').textContent = ui.attach;
  $('#maintAttachments').innerHTML = m.attachments.map((a, i) => attChip(a, i, 'data-matt-rm')).join('');
  $('#maintStartBtn').textContent = ui.start;
}

$('#maintSeg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-kind]');
  if (!b) return;
  state.maint.kind = b.dataset.kind;
  renderMaint();
});
$('#maintForm').addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.bug != null) state.maint.items[state.maint.kind][Number(t.dataset.bug)] = t.value;
  if (t.id === 'refFocus') state.maint.focus = t.value;
});
$('#maintForm').addEventListener('click', (e) => {
  const del = e.target.closest('[data-bug-del]');
  if (del) {
    state.maint.items[state.maint.kind].splice(Number(del.dataset.bugDel), 1);
    renderMaint();
    return;
  }
  const role = e.target.closest('#maintAttachments [data-role]');
  if (role) {
    const a = state.maint.attachments[Number(role.dataset.role)];
    a.role = isDesignAtt(a) ? 'doc' : 'design';
    renderMaint();
    return;
  }
  const rm = e.target.closest('[data-matt-rm]');
  if (rm) {
    state.maint.attachments.splice(Number(rm.dataset.mattRm), 1);
    renderMaint();
  }
});
$('#maintDesignBtn').addEventListener('click', async () => addAttachments(await attempt(() => api.pickDesign()), state.maint.attachments));
$('#bugAddBtn').addEventListener('click', () => {
  const list = state.maint.items[state.maint.kind];
  if (list.length >= 8) return toast('Tek seferde en fazla 8 madde; kalanları bu iş bitince girebilirsin.', true);
  list.push('');
  renderMaint();
  $(`[data-bug="${list.length - 1}"]`, maintDlg)?.focus();
});
$('#maintAttachBtn').addEventListener('click', async () => {
  const picked = (await attempt(() => api.pickDocs())) || [];
  for (const a of picked) if (!state.maint.attachments.some((x) => x.path === a.path)) state.maint.attachments.push(a);
  const bad = picked.filter((a) => !a.supported);
  if (bad.length) toast(`Desteklenmeyen / çok büyük dosya: ${bad.map((b) => b.name).join(', ')}`, true);
  renderMaint();
});
$('#maintStartBtn').addEventListener('click', async (e) => {
  e.preventDefault();
  const m = state.maint;
  const items = m.kind === 'refactor' ? [] : m.items[m.kind].map((b) => b.trim()).filter(Boolean);
  if (m.kind !== 'refactor' && !items.length) return toast(MAINT_UI[m.kind].empty, true);
  const btn = $('#maintStartBtn');
  btn.disabled = true;
  const id = await attempt(() => api.maintain({ kind: m.kind, items, text: m.focus.trim(), projectDir: m.dir, agent: m.agent, stack: m.stack, attachments: m.attachments.filter((a) => a.supported).map((a) => ({ ...a, role: isDesignAtt(a) ? 'design' : 'doc' })) }));
  btn.disabled = false;
  if (!id) return;
  maintDlg.close();
  followNewJob(id);
});

// Teslim paketi: kayıt yeri sorulur, zip Finder/Gezgin'de gösterilir.
const fmtBytes = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
async function zipCurrentProject(btn) {
  const job = state.job;
  if (!job) return;
  if (btn) btn.disabled = true;
  try {
    const r = await attempt(() => api.zipProject(job.id));
    if (!r) return;
    const notes = [`${fmtBytes(r.size)}`, `${r.count} dosya`];
    if (r.skippedSecrets) notes.push(`${r.skippedSecrets} gizli dosya (.env vb.) dışarıda`);
    if (r.leaked?.length) notes.push(`gizli değer içeren ${r.leaked.length} dosya dışarıda (${r.leaked.slice(0, 3).join(', ')})`);
    notes.push(r.gitIncluded ? 'git geçmişi içinde' : r.gitExcluded ? `git geçmişi dışarıda: ${r.gitExcluded}` : 'git geçmişi yok');
    toast(`Zip hazır: ${baseName(r.file)} · ${notes.join(' · ')}`, false, r.leaked?.length || r.gitExcluded ? 9000 : 0);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Markdown içindeki dış bağlantılar sistem tarayıcısında açılır.
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-href]');
  if (!a) return;
  e.preventDefault();
  api.openExternal(a.dataset.href);
});

export { openMaint, renderMaint, zipCurrentProject };
