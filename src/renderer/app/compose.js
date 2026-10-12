// Yeni iş ekranı: klasör, ajan, ekler (doküman / tasarım), hazırlık durumu, plan başlatma.
import { api, $, $$, esc, managerOf, state, toast, attempt, baseName, ico, semverOf, fmtSize, dirBusy } from './core.js';
import { show, refreshHistorySoon, openJob } from './history.js';
import { refreshAgents, renderAgentStatus, needsConnection, connectionHtml, onConnClick, connectAgent } from './agents.js';
import { renderJob } from './job.js';
import { renderAllLogs, renderShots } from './logs.js';
import { selectTab } from './header.js';
import { renderMaint } from './maintenance.js';
import { openEnv } from './env.js';
import { updateAgent, openSettings } from './settings.js';

// ---------- yeni iş ekranı ----------
function setAgent(id) {
  state.compose.agent = id;
  $$('#agentSeg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.agent === id)));
  renderAgentStatus();
  renderReadiness();
}

function renderFolder() {
  const d = state.compose.projectDir;
  $('#folderLabel').textContent = d ? baseName(d) : 'Klasör seç';
  $('#folderBtn').title = d || 'Projenin oluşturulacağı klasör';
  refreshComposeEnv();
}

const envCount = (v) => (v ? v.required.filter((r) => r.set).length + v.extra.length : 0);
async function refreshComposeEnv() {
  const d = state.compose.projectDir;
  const v = d ? await api.getEnv(d).catch(() => null) : null;
  const n = envCount(v);
  $('#composeEnvLabel').textContent = n ? String(n) : '';
  $('#composeEnvLabel').hidden = !n;
}
$('#composeEnvBtn').addEventListener('click', () => {
  if (!state.compose.projectDir) return toast('Önce proje klasörünü seçin.', true);
  openEnv(state.compose.projectDir);
});

// Ek çipi: doküman (şartname) ya da tasarım (görünümü belirler). Rozet tıklanınca rol değişir; klasörler hep tasarımdır.
const isDesignAtt = (a) => a.role === 'design' || a.kind === 'folder';
function attChip(a, i, rmAttr) {
  const design = isDesignAtt(a);
  const icon = ico(a.kind === 'folder' ? 'folder' : a.kind === 'image' ? 'image' : design ? 'design' : 'file');
  const why = a.kind === 'folder' ? 'Klasör boş ya da çok büyük' : a.kind ? '15 MB sınırını aşıyor' : 'Desteklenmeyen biçim';
  const bad = !a.supported ? ` bad" title="${why}` : design ? '" title="Tasarım: arayüz bu dosyaya göre yapılır' : '" title="Doküman: şartname / gereksinim kaynağı';
  const size = a.kind === 'folder' ? `${a.files} dosya` : fmtSize(a.size);
  const role = a.kind === 'folder' ? '<span class="role design">tasarım</span>' : `<button type="button" class="role ${design ? 'design' : ''}" data-role="${i}" title="Rolü değiştir: doküman ↔ tasarım">${design ? 'tasarım' : 'doküman'}</button>`;
  return `<span class="att${design ? ' design' : ''}${bad}">${icon} <span class="n">${esc(a.name)}</span><span class="s">${esc(size)}</span>${role}<button type="button" ${rmAttr}="${i}" aria-label="Kaldır"><svg class="ico" aria-hidden="true"><use href="#i-x"/></svg></button></span>`;
}
function renderAttachments() {
  $('#attachments').innerHTML = state.compose.attachments.map((a, i) => attChip(a, i, 'data-rm')).join('');
}

function addAttachments(list, target = state.compose.attachments) {
  for (const a of list || []) {
    if (!target.some((x) => x.path === a.path)) target.push(a);
  }
  const bad = (list || []).filter((a) => !a.supported);
  if (bad.length) toast(`Desteklenmeyen / çok büyük: ${bad.map((b) => b.name).join(', ')}`, true);
  const design = (list || []).filter((a) => a.supported && isDesignAtt(a));
  if (design.length) toast(`${design.length} tasarım dosyası eklendi.`);
  renderAttachments();
  if (target === state.maint?.attachments) renderMaint();
}

function renderReadiness() {
  const el = $('#readiness');
  const items = [];
  const mgr = managerOf(state.settings);
  if (state.settings && !mgr.has) {
    items.push(`<div class="ready-item warn">${ico('key')}<span>${mgr.invalid ? `Kayıtlı ${mgr.name} anahtarı okunamadı; yeniden girin.` : `${mgr.name} API anahtarı eklenmemiş.`}</span><button class="btn sm" data-act="settings">Ayarları aç</button></div>`);
  }
  const ag = state.agents?.[state.compose.agent];
  // Claude her işte gerekir (planlama ve incelemeler); Codex yalnızca kodlayan ajan olarak seçildiyse.
  const claude = state.agents?.claude;
  if (claude && needsConnection(claude)) items.push(`<div class="ready-conn">${connectionHtml(claude, { compact: true })}</div>`);
  if (ag && ag.id !== 'claude' && !ag.found) {
    items.push(`<div class="ready-item warn">${ico('terminal')}<span>${esc(ag.label)} bulunamadı. Kurulum: <code>${esc(ag.install)}</code></span><button class="btn sm" data-act="redetect">Tekrar kontrol et</button></div>`);
  } else if (ag && ag.id !== 'claude' && ag.loggedIn === false) {
    items.push(`<div class="ready-item warn">${ico('lock')}<span>${esc(ag.label)} oturumu açık değil.</span><button class="btn sm" data-act="login">Giriş yap</button><button class="btn sm ghost" data-act="redetect">Tekrar kontrol et</button></div>`);
  }
  if (ag?.found && ag.updateAvailable && !state.dismissedUpdate) {
    items.push(`<div class="ready-item info">${ico('arrow-up')}<span>${esc(ag.label)} güncel değil: ${esc(semverOf(ag.version))} → <b>${esc(ag.latest)}</b></span>${ag.canUpdate ? '<button class="btn sm" data-act="updateAgent">Güncelle</button>' : ''}<button class="btn sm ghost" data-act="dismissUpdate">Sonra</button></div>`);
  }
  const interrupted = state.history.find((j) => !state.running.has(j.id) && (j.interrupted || (j.phase === 'stopped' && j === state.history[0])));
  if (interrupted && !state.dismissedResume) {
    items.push(`<div class="ready-item info">${ico('pause')}<span>Yarım kalan iş: <b>${esc(interrupted.title || interrupted.idea.slice(0, 60))}</b>.</span><button class="btn sm" data-act="resumeJob" data-id="${esc(interrupted.id)}">${ico('refresh')} Aç ve sürdür</button><button class="btn sm ghost" data-act="dismissResume">Kapat</button></div>`);
  }
  const runN = state.running.size;
  const full = runN >= state.maxParallel;
  const here = dirBusy(state.compose.projectDir);
  if (runN) {
    const msg = here
      ? 'Bu klasörde çalışan bir iş var.'
      : full
        ? `${runN} iş çalışıyor; aynı anda en fazla ${state.maxParallel} iş çalışabilir (Ayarlar → Süreç).`
        : `${runN} iş çalışıyor.`;
    items.push(`<div class="ready-item ${here || full ? 'warn' : 'info'}">${ico('clock')}<span>${msg}</span><button class="btn sm" data-act="showlive">Göster</button></div>`);
  }
  el.innerHTML = items.join('');
  el.hidden = !items.length;
  // Giriş durumu yalnızca uyarıdır: bazı ortamlarda CLI yanlış "giriş yok" diyebilir;
  // gerçek bir giriş sorunu iş başında net bir hata olarak zaten görünür.
  $('#planBtn').disabled = full || here || !managerOf(state.settings).has || (ag && !ag.found) || (claude && !claude.found);
}

$('#readiness').addEventListener('click', async (e) => {
  if (onConnClick(e)) return;
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'settings') openSettings();
  if (act === 'redetect') refreshAgents(true);
  if (act === 'updateAgent') return updateAgent(state.compose.agent, e.target.closest('button'));
  if (act === 'dismissUpdate') {
    state.dismissedUpdate = true;
    renderReadiness();
  }
  if (act === 'dismissResume') {
    state.dismissedResume = true;
    renderReadiness();
  }
  if (act === 'resumeJob') {
    const id = e.target.closest('[data-id]').dataset.id;
    await openJob(id);
    // İş açılamadıysa (ya da bu arada başka bir iş açıldıysa) yanlış iş sürdürülmesin.
    if (state.followId === id && state.job?.id === id) await attempt(() => api.resume(id));
  }
  if (act === 'login') connectAgent(state.compose.agent);
  if (act === 'showlive') {
    const cur = await attempt(() => api.current());
    if (cur?.job) openJob(cur.job.id);
  }
});

$('#agentSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-agent]');
  if (b) setAgent(b.dataset.agent);
});
$('#folderBtn').addEventListener('click', async () => {
  const dir = await attempt(() => api.pickFolder());
  if (dir) {
    state.compose.projectDir = dir;
    renderFolder();
  }
});
$('#attachBtn').addEventListener('click', async () => addAttachments(await attempt(() => api.pickDocs())));
$('#designBtn').addEventListener('click', async () => addAttachments(await attempt(() => api.pickDesign())));
$('#attachments').addEventListener('click', (e) => {
  const role = e.target.closest('[data-role]');
  if (role) {
    const a = state.compose.attachments[Number(role.dataset.role)];
    a.role = isDesignAtt(a) ? 'doc' : 'design';
    renderAttachments();
    return;
  }
  const rm = e.target.closest('[data-rm]');
  if (!rm) return;
  state.compose.attachments.splice(Number(rm.dataset.rm), 1);
  renderAttachments();
});
$$('.chip[data-example]').forEach((c) =>
  c.addEventListener('click', () => {
    $('#idea').value = c.dataset.example;
    $('#idea').focus();
  })
);

// Sürükle-bırak ile doküman ekleme.
const composer = $('#composer');
let dragDepth = 0;
composer.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  composer.classList.add('dragging');
});
composer.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) composer.classList.remove('dragging');
});
composer.addEventListener('dragover', (e) => e.preventDefault());
composer.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  composer.classList.remove('dragging');
  const paths = [...(e.dataTransfer?.files || [])].map((f) => api.pathForFile(f)).filter(Boolean);
  if (paths.length) addAttachments(await attempt(() => api.inspectDocs(paths)));
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

async function submitPlan({ idea, projectDir, agent, attachments }) {
  const usable = (attachments || []).filter((a) => a.supported).map((a) => ({ ...a, role: isDesignAtt(a) ? 'design' : 'doc' }));
  if (!projectDir) {
    toast('Önce proje klasörünü seçin.', true);
    return false;
  }
  if (!idea.trim() && !usable.length) {
    toast('Bir istek yazın veya doküman ekleyin.', true);
    return false;
  }
  const id = await attempt(() => api.plan({ idea, projectDir, agent, attachments: usable }));
  if (!id) return false;
  followNewJob(id);
  return true;
}

function followNewJob(id) {
  state.followId = id;
  state.logs = [];
  state.shots = [];
  state.openTasks = new Set();
  state.skip = new Set();
  state.actionsKey = '';
  state.contentKey = '';
  state.summaryOpen = false;
  show('job');
  renderAllLogs();
  renderShots();
  selectTab('logs');
  refreshHistorySoon();
  // Önceki işin içeriği yeni işin başlığı altında görünmesin.
  state.job = null;
  $('#jobTitle').textContent = 'Hazırlanıyor…';
  $('#phasePill').textContent = '…';
  $('#phasePill').className = 'pill running';
  $('#jobSub').innerHTML = '';
  $('#planContent').innerHTML = '';
  $('#planActions').innerHTML = '';
  for (const id of ['stopBtn', 'resumeBtn', 'runAppBtn']) $(`#${id}`).hidden = true;
  api.loadJob(id).then((d) => {
    if (state.followId !== id || !d?.job) return;
    // İş başlarken yayılan ilk kayıtlar, arayüz işi izlemeye başlamadan önce geldiği için burada eklenir;
    // bu arada canlı gelen satırlar yinelenmez.
    const key = (e) => `${e.t}|${e.src}|${e.text}`;
    const have = new Set((d.logs || []).map(key));
    state.logs = [...(d.logs || []), ...state.logs.filter((e) => !have.has(key(e)))];
    renderAllLogs();
    if (!state.job) {
      state.job = d.job;
      renderJob();
    }
  }, (e) => toast(e.message || String(e), true));
}

$('#planBtn').addEventListener('click', async () => {
  const ok = await submitPlan({ idea: $('#idea').value, projectDir: state.compose.projectDir, agent: state.compose.agent, attachments: state.compose.attachments });
  if (ok) {
    $('#idea').value = '';
    state.compose.attachments = [];
    renderAttachments();
  }
});
$('#idea').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('#planBtn').click();
});
$('#newJobBtn').addEventListener('click', () => {
  show('compose');
  renderReadiness();
  $('#idea').focus();
});

export { setAgent, renderFolder, refreshComposeEnv, isDesignAtt, attChip, renderAttachments, addAttachments, renderReadiness, submitPlan, followNewJob };
