/* Sonda arayüzü — bağımlılıksız, tek dosya. */
(function () {
  const api = window.sonda;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const md = (s) => window.renderMarkdown(s);
  const IS_MAC = api.platform === 'darwin';

  const PHASES = {
    planning: ['Planlanıyor', 'running'],
    awaiting_answers: ['Cevap bekliyor', 'waiting'],
    awaiting_approval: ['Onay bekliyor', 'waiting'],
    running: ['Kodlanıyor', 'running'],
    verifying: ['Doğrulanıyor', 'running'],
    testing: ['Tarayıcı testi', 'running'],
    reviewing: ['İnceleniyor', 'running'],
    fixing: ['Düzeltiliyor', 'running'],
    reporting: ['Rapor yazılıyor', 'running'],
    done: ['Teslime hazır', 'done'],
    incomplete: ['Teslime hazır değil', 'failed'],
    failed: ['Hata', 'failed'],
    stopped: ['Durduruldu', ''],
    cancelled: ['İptal edildi', ''],
  };
  const ACTIVE = new Set(['planning', 'running', 'verifying', 'testing', 'reviewing', 'fixing', 'reporting']);
  const TASK_STATUS = {
    pending: ['○', 'pending', ''],
    running: ['', 'active', 'Kodlanıyor'],
    verifying: ['', 'active', 'Test ediliyor'],
    reviewing: ['', 'active', 'Gemini inceliyor'],
    fixing: ['', 'active', 'Düzeltiliyor'],
    done: ['✓', 'done', ''],
    failed: ['✕', 'failed', 'Sorunlu'],
    skipped: ['–', 'pending', 'Atlandı'],
  };
  const AGENT_LABEL = { claude: 'Claude Code', codex: 'Codex' };
  const AGENT_SHORT = { claude: 'Claude', codex: 'Codex' };
  const SRC_LABEL = { gemini: 'Gemini', test: 'Test', system: 'Sonda', review: 'Denetçi' };
  const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

  const state = {
    settings: null,
    agents: null,
    compose: { projectDir: '', agent: 'claude', attachments: [] },
    view: 'compose',
    job: null,
    followId: null,
    busy: false,
    logs: [],
    shots: [],
    logFilter: 'all',
    tab: 'logs',
    history: [],
    openTasks: new Set(),
    skip: new Set(),
    app: { state: 'stopped' },
    actionsKey: '',
    contentKey: '',
    summaryOpen: false,
    env: null,
    envDir: '',
    envPending: { set: {}, remove: new Set() },
  };

  // ---------- yardımcılar ----------
  let toastTimer;
  function toast(msg, isError = false) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.toggle('error', isError);
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), isError ? 7000 : 3500);
  }
  async function attempt(fn, okMsg) {
    try {
      const r = await fn();
      if (okMsg) toast(okMsg);
      return r;
    } catch (e) {
      toast(e.message || String(e), true);
      return undefined;
    }
  }
  const baseName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || p;
  const ico = (name) => `<svg class="ico" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const semverOf = (v) => String(v || '').match(/\d+\.\d+\.\d+/)?.[0] || String(v || '');
  const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const fmtTime = (t) => new Date(t).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const fmtDur = (ms) => {
    const m = Math.floor(ms / 60000);
    return m >= 60 ? `${Math.floor(m / 60)} sa ${m % 60} dk` : m ? `${m} dk` : `${Math.floor(ms / 1000)} sn`;
  };
  function relDate(t) {
    const d = (Date.now() - t) / 1000;
    if (d < 60) return 'az önce';
    if (d < 3600) return `${Math.floor(d / 60)} dk önce`;
    if (d < 86400) return `${Math.floor(d / 3600)} sa önce`;
    return new Date(t).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' });
  }
  const isLiveJob = () => state.busy && state.job && ACTIVE.has(state.job.phase);

  // ---------- görünüm değiştirme ----------
  function show(view) {
    state.view = view;
    $('#view-compose').hidden = view !== 'compose';
    $('#view-job').hidden = view !== 'job';
    renderHistory();
  }

  // ---------- geçmiş ----------
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

  function renderHistory() {
    const ul = $('#history');
    if (!state.history.length) {
      ul.innerHTML = '<li class="empty">Henüz proje yok.</li>';
      return;
    }
    ul.innerHTML = state.history
      .map((j) => {
        const cls = ACTIVE.has(j.phase) ? 'running' : j.phase === 'done' ? 'done' : j.phase === 'failed' || j.phase === 'incomplete' ? 'failed' : j.phase === 'awaiting_approval' || j.phase === 'awaiting_answers' ? 'waiting' : '';
        const active = state.view === 'job' && state.followId === j.id ? 'active' : '';
        return `<li class="${active}" data-id="${esc(j.id)}" title="${esc(j.idea)}">
          <span class="dot ${cls}"></span>
          <div style="min-width:0"><div class="h-title">${esc(j.title || j.idea || 'Doküman tabanlı proje')}</div>
          <div class="h-sub">${esc(baseName(j.projectDir))} · ${relDate(j.createdAt)}</div></div>
          <button class="h-del" data-del="${esc(j.id)}" title="Geçmişten sil">✕</button></li>`;
      })
      .join('');
  }

  $('#history').addEventListener('click', async (e) => {
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
      const ok = a.found && a.loggedIn !== false;
      const tip = !a.found ? `${a.label} kurulu değil` : a.loggedIn === false ? `${a.label}: oturum açılamadı` : `${a.label} ${(a.version || '').replace(/\(.*\)/, '').trim()}${a.updateAvailable ? ` — yeni sürüm var: ${a.latest}` : ''}`;
      items.push(`<span class="as" title="${esc(tip)}"><span class="dot ${ok ? 'done' : a.found ? 'waiting' : ''}"></span>${esc(AGENT_SHORT[a.id] || a.label)}</span>`);
    }
    $('#agentStatus').innerHTML = items.join('');
  }
  $('#agentStatus').addEventListener('click', () => openSettings('agents'));

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

  // ---------- yeni iş ekranı ----------
  function setAgent(id) {
    state.compose.agent = id;
    $$('#agentSeg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.agent === id)));
    $('#heroAgent').textContent = AGENT_LABEL[id];
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
    $('#composeEnvLabel').textContent = n ? `Anahtarlar · ${n}` : 'Anahtarlar';
  }
  $('#composeEnvBtn').addEventListener('click', () => {
    if (!state.compose.projectDir) return toast('Önce proje klasörünü seçin.', true);
    openEnv(state.compose.projectDir);
  });

  function renderAttachments() {
    $('#attachments').innerHTML = state.compose.attachments
      .map((a, i) => {
        const icon = ico(a.kind === 'image' ? 'image' : 'file');
        const bad = !a.supported ? ` bad" title="${a.kind ? '15 MB sınırını aşıyor' : 'Desteklenmeyen biçim'}` : '';
        return `<span class="att${bad}">${icon} <span class="n">${esc(a.name)}</span><span class="s">${fmtSize(a.size)}</span><button data-rm="${i}" aria-label="Kaldır">✕</button></span>`;
      })
      .join('');
  }

  function addAttachments(list) {
    for (const a of list || []) {
      if (!state.compose.attachments.some((x) => x.path === a.path)) state.compose.attachments.push(a);
    }
    const bad = (list || []).filter((a) => !a.supported);
    if (bad.length) toast(`Desteklenmeyen / çok büyük dosya: ${bad.map((b) => b.name).join(', ')}`, true);
    renderAttachments();
  }

  function renderReadiness() {
    const el = $('#readiness');
    const items = [];
    if (state.settings && !state.settings.hasGeminiKey) {
      items.push(`<div class="ready-item warn">${ico('key')}<span>${state.settings.geminiKeyInvalid ? 'Kayıtlı Gemini anahtarı okunamadı; yeniden girin.' : 'Gemini API anahtarı eklenmemiş. Planlama ve kod incelemesi için gerekli.'}</span><button class="btn sm" data-act="settings">Ayarları aç</button></div>`);
    }
    const ag = state.agents?.[state.compose.agent];
    if (ag && !ag.found) {
      items.push(`<div class="ready-item warn">${ico('terminal')}<span>${esc(ag.label)} bulunamadı. Kurulum: <code>${esc(ag.install)}</code></span><button class="btn sm" data-act="redetect">Tekrar kontrol et</button></div>`);
    } else if (ag && ag.loggedIn === false) {
      items.push(`<div class="ready-item warn">${ico('lock')}<span>${esc(ag.label)} Sonda'dan çalıştırılamadı${ag.authError ? `: <code>${esc(ag.authError.slice(0, 160))}</code>` : '.'} "Giriş yap" terminalde ${esc(ag.label)}'u açar; giriş isterse tamamlayın.</span><button class="btn sm" data-act="login">Giriş yap</button><button class="btn sm ghost" data-act="redetect">Tekrar kontrol et</button></div>`);
    }
    if (ag?.found && ag.updateAvailable && !state.dismissedUpdate) {
      items.push(`<div class="ready-item info">${ico('arrow-up')}<span>${esc(ag.label)} güncel değil: ${esc(semverOf(ag.version))} → <b>${esc(ag.latest)}</b></span>${ag.canUpdate ? '<button class="btn sm" data-act="updateAgent">Güncelle</button>' : ''}<button class="btn sm ghost" data-act="dismissUpdate">Sonra</button></div>`);
    }
    const interrupted = !state.busy && state.history.find((j) => j.interrupted || (j.phase === 'stopped' && j === state.history[0]));
    if (interrupted && !state.dismissedResume) {
      items.push(`<div class="ready-item info">${ico('pause')}<span>Yarım kalan iş: <b>${esc(interrupted.title || interrupted.idea.slice(0, 60))}</b> — kaldığı yerden devam edebilir.</span><button class="btn sm" data-act="resumeJob" data-id="${esc(interrupted.id)}">${ico('refresh')} Aç ve sürdür</button><button class="btn sm ghost" data-act="dismissResume">Kapat</button></div>`);
    }
    if (state.busy) {
      items.push(`<div class="ready-item info">${ico('clock')}<span>Şu anda çalışan bir iş var. Yeni iş için bitmesini bekleyin ya da durdurun.</span><button class="btn sm" data-act="showlive">Göster</button></div>`);
    }
    el.innerHTML = items.join('');
    el.hidden = !items.length;
    // Giriş durumu yalnızca uyarıdır: bazı ortamlarda CLI yanlış "giriş yok" diyebilir;
    // gerçek bir giriş sorunu iş başında net bir hata olarak zaten görünür.
    $('#planBtn').disabled = state.busy || !state.settings?.hasGeminiKey || (ag && !ag.found);
  }

  $('#readiness').addEventListener('click', async (e) => {
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
      if (state.job) await attempt(() => api.resume());
    }
    if (act === 'login') attempt(() => api.loginAgent(state.compose.agent), 'Terminal açıldı. Giriş bitince "Tekrar kontrol et"e basın.');
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
  $('#attachments').addEventListener('click', (e) => {
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
    const usable = (attachments || []).filter((a) => a.supported);
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
    state.followId = id;
    state.logs = [];
    state.shots = [];
    state.openTasks = new Set();
    state.skip = new Set();
    state.actionsKey = '';
    state.contentKey = '';
    show('job');
    renderAllLogs();
    renderShots();
    selectTab('logs');
    refreshHistorySoon();
    return true;
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

  // ---------- iş görünümü ----------
  function renderJob() {
    const job = state.job;
    if (!job) return;
    const [label, cls] = PHASES[job.phase] || [job.phase, ''];
    $('#jobTitle').textContent = job.plan?.projectName || (job.phase === 'planning' ? 'Plan hazırlanıyor…' : 'Proje');
    $('#jobTitle').title = `${$('#jobTitle').textContent} — ${job.projectDir}`;
    const pill = $('#phasePill');
    pill.textContent = label;
    pill.className = `pill ${cls}`;

    const live = isLiveJob();
    $('#stopBtn').hidden = !(live || job.phase === 'awaiting_approval' || job.phase === 'awaiting_answers');
    $('#stopBtn').innerHTML = live ? `${ico('stop')} Durdur` : `${ico('x')} İptal`;
    $('#resumeBtn').hidden = live || !['failed', 'stopped'].includes(job.phase) || !job.tasks?.length;
    const appHere = state.app.dir === job.projectDir && state.app.state !== 'stopped';
    $('#runAppBtn').hidden = live || !job.tasks?.some((t) => t.status === 'done' || t.status === 'failed');
    $('#runAppBtn').innerHTML = appHere ? (state.app.state === 'starting' ? `${ico('clock')} Başlatılıyor…` : `${ico('stop')} Uygulamayı kapat`) : `${ico('play')} Çalıştır`;
    $('#runAppBtn').title = appHere ? 'Çalışan uygulamayı kapat' : 'Uygulamayı geliştirme sunucusunda çalıştır ve tarayıcıda aç';
    $('#runAppBtn').disabled = state.app.state === 'starting';
    renderStats();
    renderEnvBadge();
    renderPlanContent();
    renderPlanActions();
    renderDocs();
  }

  function renderStats() {
    const job = state.job;
    if (!job) return;
    const st = job.stats || {};
    const tasks = (job.tasks || []).filter((t) => t.status !== 'skipped');
    const done = tasks.filter((t) => t.status === 'done').length;
    const live = isLiveJob();
    const end = job.finishedAt || (live ? Date.now() : state.logs[state.logs.length - 1]?.t || job.startedAt);
    const dur = job.startedAt && end ? fmtDur(Math.max(0, end - job.startedAt)) : '';
    const sub = [`<span class="idea" title="${esc(job.idea || '')}">${esc(job.idea || `Dokümanlardan: ${(job.attachments || []).map((a) => a.name).join(', ')}`)}</span>`];
    if (tasks.length) sub.push(`<span class="sep">·</span><span>Görev <b>${done}/${tasks.length}</b></span>`);
    if (dur) sub.push(`<span class="sep">·</span><span title="${live ? 'Geçen süre' : 'Son çalışmaya kadar geçen süre'}"><b>${dur}</b></span>`);
    if (job.waitUntil && live) sub.push(`<span class="sep">·</span><span style="color:var(--warn)" title="Ajan kullanım limitine takıldı; süre dolunca otomatik devam eder">${ico('pause')} limit · ${new Date(job.waitUntil).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}'de devam</span>`);
    $('#jobSub').innerHTML = sub.join('');
    $('#jobProgress').style.width = tasks.length ? `${Math.round((done / tasks.length) * 100)}%` : '0';
    const rows = [];
    if (tasks.length) rows.push(['Görev', `${done}/${tasks.length}`]);
    if (st.agentRuns) rows.push(['Ajan oturumu', `${st.agentRuns}×`]);
    if (st.costUsd) rows.push(['API karşılığı*', `≈$${st.costUsd.toFixed(2)}`]);
    if (st.geminiTokens) rows.push(['Gemini', `${Math.round(st.geminiTokens / 1000)}K token`]);
    if (dur) rows.push(['Süre', dur]);
    $('#jobStats').innerHTML = rows.length ? rows.map(([k, v]) => `<span>${k}</span><b>${v}</b>`).join('') : '<span>Henüz istatistik yok</span>';
    $('#jobStats').title = st.costUsd ? '* Claude aboneliğinle çalışıyorsan ücret yok; bu, aynı işin API fiyatlarıyla tahmini karşılığıdır.' : '';
  }
  setInterval(() => {
    if (state.view === 'job' && isLiveJob()) renderStats();
  }, 1000);

  function renderPlanContent() {
    const job = state.job;
    const key = JSON.stringify([job.id, job.phase, job.plan?.projectName, job.tasks, job.gates, job.finalReview, job.userNotes, job.reqStatus, job.discovery?.productBrief?.length, job.planCritique?.summary, job.planReview?.rounds?.length, [...state.openTasks], [...state.skip], state.busy, state.summaryOpen]);
    if (key === state.contentKey) return;
    state.contentKey = key;
    const el = $('#planContent');

    if (!job.plan) {
      const brief = job.discovery?.productBrief;
      const waitingText = job.discovery
        ? 'Gemini gereksinimleri ("bitti"nin tanımını) çıkarıyor; ardından Claude klasörü ve güncel sürümleri inceleyerek teknik şartnameyi ve görev planını yazacak, Gemini de yönetici olarak değerlendirip gerekirse düzelttirecek. Bu 10–25 dakika sürebilir.'
        : 'Gemini isteği kıdemli bir ürün yöneticisi gözüyle tam ürün tanımına genişletiyor. Ardından sana birkaç soru soracak.';
      el.innerHTML = `<div class="sec"><div class="sec-title">${brief ? 'Ürün tanımı (Gemini keşfi)' : 'Plan'}</div>
        ${job.phase === 'planning' ? `<p class="summary-text" style="color:var(--muted)">${KLOADER}${waitingText}</p>` : ''}
        ${!brief && job.phase !== 'planning' ? `<p class="summary-text" style="color:var(--muted)">${esc(job.error || 'Plan oluşturulamadı.')}</p>` : ''}
        ${(job.attachments || []).length ? `<div class="tags" style="margin-top:10px">${job.attachments.map((a) => `<span class="tag">${ico('clip')} ${esc(a.name)}</span>`).join('')}</div>` : ''}
        ${brief ? `<div class="md brief product-brief">${md(brief)}</div>` : ''}</div>`;
      return;
    }
    const p = job.plan;
    const approving = job.phase === 'awaiting_approval' && !state.busy;
    const fold = (title, inner, count, open) => `<details class="fold" ${open ? 'open' : ''}><summary>${title}${count != null ? ` <span class="count">${count}</span>` : ''}</summary>${inner}</details>`;
    const final = job.finalReview;
    const reqs = p.requirements || [];
    const st = job.reqStatus || {};
    const met = reqs.filter((r) => st[r.id] === 'met').length;
    const partial = reqs.filter((r) => st[r.id] === 'partial').length;
    const reqLine = reqs.length
      ? `<div class="overview-stats"><span>Gereksinim <b>${met}/${reqs.length}</b></span><div class="req-bar" title="${met} karşılandı, ${partial} kısmen"><i style="width:${(met / reqs.length) * 100}%"></i><em style="width:${(partial / reqs.length) * 100}%"></em></div></div>`
      : '';

    el.innerHTML = `
      ${final ? `<div class="sec final-box">
        <div class="sec-title">Son inceleme</div>
        <div class="score">${final.qualityScore ?? '–'}<small> /10 kalite · ${final.verdict === 'pass' ? '✓ Onaylandı' : 'açık sorunlar var'}</small></div>
        <p class="summary-text" style="margin-top:6px">${esc(final.summary)}</p>
        ${final.issues?.length ? `<ul class="bullets" style="margin-top:6px">${final.issues.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}
        ${final.deep ? `<div class="sec-line">${ico('search')} Derin inceleme: <span class="badge ${final.deep.verdict === 'pass' ? 'ok' : 'warn'}">${final.deep.verdict === 'pass' ? 'onay' : 'düzeltme'}</span> <span title="${esc(final.deep.summary)}">${esc((final.deep.summary || '').slice(0, 90))}</span></div>` : ''}
        ${final.security ? `<div class="sec-line">${ico('shield')} Güvenlik: ${final.security.length ? final.security.map((f) => `<span class="badge ${['critical', 'high'].includes(f.severity) ? 'err' : 'warn'}" title="${esc(f.title)}">${esc(f.severity)}</span>`).join(' ') : '<span class="badge ok">bulgu yok</span>'}</div>` : ''}
        ${final.panel ? panelLine(final.panel) : ''}
      </div>` : ''}
      <div class="overview">
        <p class="summary-text ${state.summaryOpen ? '' : 'clamp'}" data-summary title="${state.summaryOpen ? '' : 'Tamamı için tıklayın'}">${esc(p.summary)}</p>
        ${reqLine}
      </div>
      <div class="sec">
        <div class="sec-title">Görevler ${approving ? '<span class="count">işareti kaldırılan görev atlanır</span>' : `<span class="count">${(job.tasks || []).filter((t) => t.status === 'done').length}/${(job.tasks || []).filter((t) => t.status !== 'skipped').length}</span>`}</div>
        ${tasksHtml(job, approving)}
      </div>
      <div class="details-group">
        <div class="sec-title">Plan ayrıntıları</div>
        ${job.userNotes?.length ? fold('Verdiğin talimatlar', `<ul class="bullets">${job.userNotes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`, job.userNotes.length, true) : ''}
        ${fold('Teknoloji', `<div class="stack-list">${p.stack.map((x) => esc(x)).join('<br>')}</div>`, p.stack.length, false)}
        ${fold('Özellikler', `<ul class="bullets">${p.features.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>`, p.features.length, false)}
        ${reqs.length ? requirementsHtml(job, fold) : ''}
        ${p.assumptions?.length ? fold('Varsayımlar', `<ul class="bullets">${p.assumptions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>`, p.assumptions.length, false) : ''}
        ${job.discovery?.productBrief ? fold('Ürün tanımı', `<div class="md brief">${md(job.discovery.productBrief)}</div>${job.discovery.answers?.length ? `<h5 class="mini-h">Kararların</h5><ul class="bullets">${job.discovery.answers.map((a) => `<li>${esc(a.question)} → <b>${esc(a.answer)}</b></li>`).join('')}</ul>` : ''}`, null, false) : ''}
        ${job.planReview?.rounds?.length ? fold(`Plan değerlendirmesi <span class="count">${esc(job.planReview.planner)} yazdı, Gemini yönetti</span>`, job.planReview.rounds.map((r, i) => `<h5 class="mini-h">Tur ${i + 1} · ${r.verdict === 'approve' ? '✓ onay' : '↻ değişiklik istendi'}</h5><p class="summary-text">${esc(r.summary)}</p>${(r.findings || []).length ? `<ul class="bullets">${r.findings.map((f) => `<li><span class="badge ${f.severity === 'high' ? 'err' : f.severity === 'medium' ? 'warn' : ''}">${esc(f.severity)}</span> ${esc(f.problem)}</li>`).join('')}</ul>` : ''}`).join(''), null, false) : ''}
        ${job.planCritique ? fold(`Bağımsız plan eleştirisi · ${job.planCritique.verdict === 'solid' ? 'sağlam' : 'düzeltildi'}`, `<p class="summary-text">${esc(job.planCritique.summary)}</p><ul class="bullets">${(job.planCritique.findings || []).map((f) => `<li><span class="badge ${f.severity === 'high' ? 'err' : f.severity === 'medium' ? 'warn' : ''}">${esc(f.severity)}</span> ${esc(f.problem)}</li>`).join('')}</ul><div class="hint">Bulgular planın son haline işlendi.</div>`, (job.planCritique.findings || []).length, false) : ''}
      </div>`;
  }

  // Gereksinim izlenebilirliği: her gereksinimin incelemelerce doğrulanma durumu.
  function requirementsHtml(job, fold) {
    const reqs = job.plan.requirements;
    const st = job.reqStatus || {};
    const met = reqs.filter((r) => st[r.id] === 'met').length;
    const rows = reqs
      .map((r) => {
        const s = st[r.id];
        const ev = (job.reqEvidence || {})[r.id];
        const ic = s === 'met' ? '<span class="rq met">✓</span>' : s === 'partial' ? '<span class="rq partial">◐</span>' : s === 'missing' ? '<span class="rq missing">✕</span>' : '<span class="rq">○</span>';
        const label = { met: 'Karşılandı', partial: 'Kısmen', missing: 'Eksik' }[s] || 'Henüz doğrulanmadı';
        return `<div class="req" title="${esc(label)}${ev ? ` — ${esc(ev)}` : ''}">${ic}<b>${esc(r.id)}</b><span>${esc(r.text)}</span></div>`;
      })
      .join('');
    return fold('Gereksinimler', rows, met ? `${met}/${reqs.length} karşılandı` : reqs.length, false);
  }

  // Uzman paneli özeti: doğrulanmış bulgular, elenen yanlış alarmlar.
  function panelLine(pn) {
    const conf = pn.confirmed || [];
    const tip = conf.map((f) => `[${f.severity}] ${f.title} (${f.file || '?'}${f.line ? `:${f.line}` : ''})`).join('\n');
    return `<div class="sec-line" title="${esc(tip)}">${ico('panel')} Uzman paneli: ${conf.length ? `<span class="badge ${pn.blocking ? 'err' : 'warn'}">${conf.length} doğrulanmış bulgu</span>` : '<span class="badge ok">doğrulanmış bulgu yok</span>'}${pn.rejected ? ` <span class="badge">${pn.rejected} yanlış alarm elendi</span>` : ''}</div>`;
  }

  // Görevleri fazlara göre gruplar; her fazın kalite kapısı durumunu gösterir.
  function tasksHtml(job, approving) {
    const phases = [];
    job.tasks.forEach((t, i) => {
      const name = t.phase || '';
      if (!phases.length || phases[phases.length - 1].name !== name) phases.push({ name, items: [] });
      phases[phases.length - 1].items.push(taskHtml(t, i, approving));
    });
    if (phases.length <= 1) return `<ul class="tasks">${phases[0]?.items.join('') || ''}</ul>`;
    return phases
      .map((p, idx) => {
        const gate = job.gates?.[p.name];
        const last = idx === phases.length - 1;
        const gateBadge = last
          ? '<span class="badge" title="Son faz, son doğrulamayla birlikte değerlendirilir">son test</span>'
          : !gate
            ? '<span class="badge" title="Faz bitince tam doğrulama + regresyon incelemesi">kapı</span>'
            : gate.status === 'passed'
              ? `<span class="badge ok" title="${esc(gate.review?.summary || '')}${gate.review?.deep ? ` · Derin inceleme: ${esc(gate.review.deep.summary)}` : ''}${gate.review?.panel ? ` · Uzman paneli: ${(gate.review.panel.confirmed || []).length} doğrulanmış bulgu, ${gate.review.panel.rejected || 0} yanlış alarm elendi` : ''}">kapı ✓ ${gate.review?.qualityScore ?? ''}</span>`
              : gate.status === 'failed'
                ? `<span class="badge err" title="${esc(gate.review?.summary || '')}">kapı ✕</span>`
                : '<span class="badge warn">kapı…</span>';
        return `<div class="phase-block"><div class="phase-head"><span class="phase-no">${idx + 1}</span><span class="phase-name">${esc(p.name)}</span>${gateBadge}</div><ul class="tasks">${p.items.join('')}</ul></div>`;
      })
      .join('');
  }

  // Kabul kriterleri; inceleme varsa her birinin kanıtlı durumu.
  function acceptanceHtml(t) {
    const checks = t.review?.acceptanceChecks || [];
    const find = (a) => checks.find((c) => c.criterion && (c.criterion === a || a.startsWith(c.criterion.slice(0, 40)) || c.criterion.startsWith(a.slice(0, 40))));
    return `<ul class="acc">${t.acceptance
      .map((a) => {
        const c = find(a);
        const ic = !c ? '•' : c.status === 'met' ? '✓' : c.status === 'partial' ? '◐' : '✕';
        return `<li class="${c ? c.status : ''}" title="${c ? esc(c.evidence || '') : ''}"><span class="acc-ic">${ic}</span>${esc(a)}${c && c.status !== 'met' && c.evidence ? `<div class="acc-ev">${esc(c.evidence)}</div>` : ''}</li>`;
      })
      .join('')}</ul>`;
  }

  function taskHtml(t, i, approving) {
    const [ic, icCls, label] = TASK_STATUS[t.status] || TASK_STATUS.pending;
    const skipped = approving ? state.skip.has(t.id) : t.status === 'skipped';
    const open = state.openTasks.has(t.id);
    const current = state.job.currentTaskId === t.id && ACTIVE.has(state.job.phase);
    const badges = [];
    if (label && !approving) badges.push(`<span class="badge ${t.status === 'failed' ? 'err' : t.status === 'fixing' ? 'warn' : ''}">${label}${t.status === 'fixing' && t.attempts ? ` ${t.attempts}` : ''}</span>`);
    if (t.review?.qualityScore && t.status === 'done') badges.push(`<span class="badge ok" title="Gemini kalite puanı">${t.review.qualityScore}/10</span>`);
    if (t.attempts && t.status !== 'fixing') badges.push(`<span class="badge" title="Düzeltme turu">↻${t.attempts}</span>`);
    const lead = approving
      ? `<input type="checkbox" data-skip="${t.id}" ${skipped ? '' : 'checked'} aria-label="Görevi dahil et" />`
      : `<span class="status-ic ${icCls}">${ic}</span>`;
    const review = t.review
      ? `<h5>İnceleme</h5><div class="review-box">${esc(t.review.summary)}${t.review.testQuality ? `<div class="hint" style="margin-top:4px">${ico('flask')} ${esc(t.review.testQuality)}</div>` : ''}${t.review.deep ? `<div class="hint" style="margin-top:4px">${ico('search')} Derin inceleme: ${esc(t.review.deep.summary)}</div>` : ''}${t.review.issues?.length ? `<ul class="bullets">${t.review.issues.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</div>`
      : '';
    return `<li class="task ${open ? 'open' : ''} ${current ? 'current' : ''} ${skipped ? 'skipped' : ''}" data-task="${t.id}">
      <div class="task-head">${lead}
        <div><div class="task-title"><span class="task-num">${i + 1}</span>${esc(t.title)}</div><div class="task-goal">${esc(t.goal)}</div></div>
        <div class="task-meta">${badges.join('')}</div></div>
      <div class="task-body">
        <h5>Detaylar</h5><pre>${esc(t.details)}</pre>
        <h5>Kabul kriterleri</h5>${acceptanceHtml(t)}
        ${t.tests?.length ? `<h5>Yazılacak testler</h5><ul class="bullets">${t.tests.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
        ${t.tddFiles?.length ? `<h5>TDD — önce yazılan testler</h5><div class="tags">${t.tddFiles.map((f) => `<span class="tag">${esc(f)}</span>`).join('')}</div>` : ''}
        ${t.covers?.length ? `<h5>Karşıladığı gereksinimler</h5><div class="tags">${t.covers.map((c) => `<span class="tag">${esc(c)}</span>`).join('')}</div>` : ''}
        ${t.brief ? `<details class="fold"><summary>Teknik brif (Gemini)</summary><div class="md brief">${md(t.brief)}</div></details>` : ''}
        ${review}
        ${t.agentSummary ? `<h5>Ajanın özeti</h5><div class="md" style="padding:0">${md(t.agentSummary)}</div>` : ''}
      </div></li>`;
  }

  $('#planContent').addEventListener('click', (e) => {
    if (e.target.closest('[data-summary]')) {
      state.summaryOpen = !state.summaryOpen;
      state.contentKey = '';
      renderPlanContent();
      return;
    }
    const cb = e.target.closest('[data-skip]');
    if (cb) {
      e.stopPropagation();
      cb.checked ? state.skip.delete(cb.dataset.skip) : state.skip.add(cb.dataset.skip);
      renderPlanContent();
      return;
    }
    const head = e.target.closest('.task-head');
    if (head) {
      const id = head.parentElement.dataset.task;
      state.openTasks.has(id) ? state.openTasks.delete(id) : state.openTasks.add(id);
      renderPlanContent();
    }
  });

  // Alt eylem alanı yalnızca "mod" değişince yeniden çizilir; böylece yazılan metin kaybolmaz.
  function renderPlanActions() {
    const job = state.job;
    const live = isLiveJob();
    let mode = 'none';
    if (job.phase === 'awaiting_answers' && !state.busy) mode = 'answer';
    else if (job.phase === 'awaiting_approval' && !state.busy) mode = 'approve';
    else if (live && job.plan) mode = 'note';
    else if (!state.busy && job.phase === 'incomplete') mode = 'incomplete';
    else if (!state.busy && ['failed', 'stopped'].includes(job.phase) && job.plan && job.tasks?.length) mode = 'resume';
    else if (!state.busy && ['failed', 'stopped'].includes(job.phase) && !job.plan) mode = 'retryPlan';
    else if (!state.busy && ['done', 'cancelled'].includes(job.phase)) mode = 'followup';
    const key = `${job.id}:${mode}:${(job.plan?.questions || []).length}`;
    if (key === state.actionsKey) return;
    state.actionsKey = key;
    const el = $('#planActions');

    if (mode === 'answer') {
      const qs = job.discovery?.questions || [];
      el.innerHTML = `<div class="approve-box">
        <div class="questions sec"><div class="sec-title">Planı netleştirmek için sorular <span class="count">önerilen cevap seçili</span></div>
        ${qs
          .map(
            (q, i) => `<fieldset class="question q-card"><legend>${esc(q.question)}</legend>${q.why ? `<div class="hint">${esc(q.why)}</div>` : ''}
            <div class="opts">${q.options
              .map((o) => `<label class="opt"><input type="radio" name="dq${i}" value="${esc(o)}" ${o === q.default ? 'checked' : ''}/> ${esc(o)}${o === q.default ? ' <span class="badge ok">önerilen</span>' : ''}</label>`)
              .join('')}</div>
            <input class="q-other" data-dq="${i}" placeholder="Başka bir cevap / ek not (isteğe bağlı)" /></fieldset>`
          )
          .join('')}</div>
        <div class="approve-actions">
          <button class="btn" id="defaultsBtn">Varsayılanlarla devam et</button>
          <button class="btn primary" id="answerBtn">Cevaplarla planla →</button>
        </div></div>`;
      const collect = () =>
        qs.map((q, i) => {
          const other = $(`[data-dq="${i}"]`, el).value.trim();
          const picked = $(`input[name="dq${i}"]:checked`, el)?.value || q.default;
          return other ? `${picked} — ${other}` : picked;
        });
      $('#answerBtn').onclick = async () => {
        state.actionsKey = '';
        await attempt(() => api.answer(collect()));
      };
      $('#defaultsBtn').onclick = async () => {
        state.actionsKey = '';
        await attempt(() => api.answer(qs.map((q) => q.default)));
      };
    } else if (mode === 'approve') {
      const qs = job.plan.questions || [];
      el.innerHTML = `<div class="approve-box">
        ${qs.length ? `<div class="questions sec"><div class="sec-title">Gemini'nin soruları <span class="count">isteğe bağlı</span></div>
          ${qs.map((q, i) => `<div class="question"><label for="q${i}">${esc(q)}</label><input id="q${i}" data-q="${i}" placeholder="Boş bırakırsanız plandaki varsayım kullanılır" /></div>`).join('')}</div>` : ''}
        <textarea id="feedback" rows="2" placeholder="Planda değiştirmek istediğin bir şey var mı? (ör. &quot;admin paneli olmasın&quot;)"></textarea>
        <div class="approve-actions">
          <button class="btn" id="replanBtn">${ico('refresh')} Planı güncelle</button>
          <button class="btn primary" id="approveBtn">Onayla ve başlat →</button>
        </div></div>`;
      $('#replanBtn').onclick = async () => {
        const answers = $$('[data-q]', el)
          .filter((i) => i.value.trim())
          .map((i) => `Q: ${qs[Number(i.dataset.q)]}\nA: ${i.value.trim()}`);
        const fb = [$('#feedback').value.trim(), answers.length ? `Answers to your questions:\n${answers.join('\n')}` : ''].filter(Boolean).join('\n\n');
        if (!fb) return toast('Önce bir geri bildirim yazın ya da soruları cevaplayın.', true);
        state.actionsKey = '';
        await attempt(() => api.replan(fb));
      };
      $('#approveBtn').onclick = async () => {
        const answers = $$('[data-q]', el).filter((i) => i.value.trim());
        if (answers.length && !confirm('Soruları cevapladınız ama planı güncellemediniz. Cevaplar ajanlara talimat olarak iletilsin mi?')) return;
        for (const i of answers) await attempt(() => api.addNote(`${qs[Number(i.dataset.q)]} → ${i.value.trim()}`));
        if ($('#feedback').value.trim()) await attempt(() => api.addNote($('#feedback').value.trim()));
        state.actionsKey = '';
        await attempt(() => api.approve({ skipTaskIds: [...state.skip] }));
      };
    } else if (mode === 'note') {
      el.innerHTML = `<div class="note-box">
        <div class="row"><input id="noteInput" placeholder="Ajana talimat ver — bir sonraki adıma eklenir (ör. renkleri daha koyu yap)" title="Talimat bir sonraki ajan adımına ve Gemini incelemesine eklenir." /><button class="btn sm" id="noteBtn">Gönder</button></div></div>`;
      const send = async () => {
        const v = $('#noteInput').value.trim();
        if (!v) return;
        if (await attempt(() => api.addNote(v), 'Talimat iletildi')) $('#noteInput').value = '';
      };
      $('#noteBtn').onclick = send;
      $('#noteInput').onkeydown = (e) => e.key === 'Enter' && send();
    } else if (mode === 'incomplete') {
      const open = job.finalReview?.issues || [];
      el.innerHTML = `<div class="note-box">
        <div class="sec-title">Teslime hazır değil — ${open.length} açık sorun</div>
        <ul class="bullets" style="margin-bottom:8px">${open.slice(0, 12).map((i) => `<li>${esc(i)}</li>`).join('')}</ul>
        <textarea id="finalNote" rows="2" placeholder="İsteğe bağlı: ajana yol göster"></textarea>
        <div class="approve-actions"><button class="btn primary" id="continueFinalBtn">${ico('refresh')} Düzeltmeye devam et</button></div></div>`;
      $('#continueFinalBtn').onclick = async () => {
        const note = $('#finalNote').value.trim();
        if (note && !(await attempt(() => api.addNote(note)))) return;
        state.actionsKey = '';
        await attempt(() => api.continueFinal());
      };
    } else if (mode === 'retryPlan') {
      const kept = !!job.discovery?.answers;
      el.innerHTML = `<div class="note-box">
        <div class="sec-title">Planlama tamamlanamadı</div>
        ${job.error ? `<div class="review-box" style="margin-bottom:8px">${esc(job.error)}</div>` : ''}
        ${kept ? '<div class="pending-notes" style="margin-bottom:8px">Ürün tanımı ve cevaplarınız korunuyor; planlama gereksinimlerden devam eder.</div>' : ''}
        <div class="approve-actions"><button class="btn primary" id="retryPlanBtn">${ico('refresh')} ${kept ? 'Planlamaya devam et' : 'Tekrar dene'}</button>${kept ? '<button class="btn ghost" id="freshPlanBtn">Baştan başla</button>' : ''}</div></div>`;
      $('#retryPlanBtn').onclick = async () => {
        state.actionsKey = '';
        await attempt(() => api.resume());
      };
      if (kept) $('#freshPlanBtn').onclick = () => submitPlan({ idea: job.idea, projectDir: job.projectDir, agent: job.agent, attachments: (job.attachments || []).map((a) => ({ ...a, supported: true })) });
    } else if (mode === 'resume') {
      el.innerHTML = `<div class="note-box">
        <div class="sec-title">Kaldığı yerden devam et</div>
        ${job.error ? `<div class="review-box" style="margin-bottom:8px">${esc(job.error)}</div>` : ''}
        <textarea id="resumeNote" rows="2" placeholder="İsteğe bağlı: ajana yol göster (ör. &quot;testler için docker compose up -d postgres kullan&quot;)"></textarea>
        <div class="approve-actions"><button class="btn primary" id="resumeWithNoteBtn">${ico('refresh')} Sürdür</button></div></div>`;
      $('#resumeWithNoteBtn').onclick = async () => {
        const note = $('#resumeNote').value.trim();
        if (note && !(await attempt(() => api.addNote(note)))) return;
        state.actionsKey = '';
        await attempt(() => api.resume());
      };
    } else if (mode === 'followup') {
      el.innerHTML = `<div class="note-box">
        <div class="sec-title">Bu projede devam et</div>
        <textarea id="followInput" rows="2" placeholder="Yeni özellik ya da değişiklik iste (ör. &quot;Kullanıcı girişi ve favoriler ekle&quot;)"></textarea>
        <div class="approve-actions"><button class="btn primary" id="followBtn">Planla →</button></div></div>`;
      $('#followBtn').onclick = () => {
        const idea = $('#followInput').value.trim();
        if (!idea) return toast('Ne değişsin? Bir istek yazın.', true);
        submitPlan({ idea, projectDir: job.projectDir, agent: job.agent, attachments: [] });
      };
    } else {
      el.innerHTML = '';
    }
  }

  function renderDocs() {
    const job = state.job;
    $('#report').innerHTML = job.report ? md(job.report) : emptyHtml('Teslim raporu iş tamamlanınca burada görünecek.');
    if (job.plan) {
      const p = job.plan;
      const specKey = `${job.id}:${p.projectName}:${p.spec?.length}`;
      if ($('#spec').dataset.key !== specKey) {
        $('#spec').dataset.key = specKey;
        $('#spec').innerHTML = md(`## ${p.projectName}\n\n${p.summary}\n\n### Gereksinimler\n${(p.requirements || []).map((r) => `- **${r.id}** ${r.text}`).join('\n')}\n\n---\n\n${p.spec || ''}`);
      }
    } else {
      $('#spec').dataset.key = '';
      $('#spec').innerHTML = emptyHtml('Teknik şartname plan hazır olunca burada görünecek.');
    }
    const memKey = `${job.id}:${(job.memory || '').length}:${(job.carryOver || []).length}`;
    if ($('#memory').dataset.key !== memKey) {
      $('#memory').dataset.key = memKey;
      $('#memory').innerHTML = job.memory
        ? md(`${job.carryOver?.length ? `### Sonraki görevlere devreden notlar\n${job.carryOver.map((c) => `- ${c}`).join('\n')}\n\n---\n\n` : ''}${job.memory}`)
        : emptyHtml('Her görev bittiğinde Gemini, yazılan kodu okuyup proje hafızasını (modüller, veri modeli, rotalar, bileşenler, kararlar) günceller. Sonraki her ajan bu hafızayla başlar; böylece daha önce ne kodlandığı unutulmaz. Hafıza projede <code>docs/sonda/MEMORY.md</code> olarak da saklanır.');
    }
  }

  // ---------- log akışı ----------
  function logVisible(e) {
    const f = state.logFilter;
    if (f === 'all' || e.lvl === 'step') return true;
    if (f === 'problems') return e.lvl === 'warn' || e.lvl === 'error';
    return e.src === f;
  }
  function srcLabel(src) {
    return src === 'agent' ? AGENT_SHORT[state.job?.agent] || 'Ajan' : SRC_LABEL[src] || src;
  }
  function logHtml(e) {
    return `<div class="log ${e.lvl}"><span class="t">${fmtTime(e.t)}</span><span class="src ${e.src}">${esc(srcLabel(e.src))}</span><span class="msg">${esc(e.text)}</span></div>`;
  }
  const MAX_DOM_LOGS = 5000;
  function renderAllLogs() {
    const list = $('#logList');
    const vis = state.logs.filter(logVisible).slice(-MAX_DOM_LOGS);
    list.innerHTML = vis.length ? vis.map(logHtml).join('') : emptyHtml('Henüz kayıt yok.', 'log-empty');
    const pane = $('#tab-logs');
    pane.scrollTop = pane.scrollHeight;
  }
  let pendingLogs = [];
  let logFrame = 0;
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
      grid.innerHTML = `<div style="grid-column:1/-1">${emptyHtml('Faz sonlarında Sonda uygulamayı çalıştırıp sayfaları gezecek; ekran görüntüleri ve konsol hataları burada görünecek.')}</div>`;
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

  // ---------- sekmeler ----------
  function selectTab(tab) {
    state.tab = tab;
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    $$('.tab-pane').forEach((p) => p.classList.toggle('active', p.id === `tab-${tab}`));
  }
  $$('.tab').forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));

  // ---------- başlık eylemleri ----------
  $('#stopBtn').addEventListener('click', async () => {
    if (isLiveJob() && !confirm('Çalışan iş durdurulsun mu? Daha sonra "Sürdür" ile kaldığı yerden devam edebilirsiniz.')) return;
    await attempt(() => api.stop());
  });
  $('#resumeBtn').addEventListener('click', () => attempt(() => api.resume()));
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
    if (b.dataset.more === 'folder') attempt(() => api.openPath(state.job.projectDir));
    if (b.dataset.more === 'editor') attempt(() => api.openEditor(state.job.projectDir));
  });
  $('#runAppBtn').addEventListener('click', async () => {
    const job = state.job;
    if (!job) return;
    if (state.app.dir === job.projectDir && state.app.state === 'running') return attempt(() => api.stopApp());
    const v = job.plan?.verify || {};
    const r = await attempt(() => api.runApp({ dir: job.projectDir, command: v.devCommand, url: v.devUrl }));
    if (r?.url) toast(`Uygulama çalışıyor: ${r.url}`);
  });

  // Markdown içindeki dış bağlantılar sistem tarayıcısında açılır.
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-href]');
    if (!a) return;
    e.preventDefault();
    api.openExternal(a.dataset.href);
  });

  // ---------- Anahtarlar (.env) ----------
  // Değerler yalnızca kullanıcı yazarken arayüzde bulunur; kayıtlı değerler maskeli gelir.
  const envDlg = $('#envDialog');

  async function openEnv(dir) {
    const v = await attempt(() => api.getEnv(dir));
    if (!v) return;
    state.envDir = dir;
    state.env = v;
    state.envPending = { set: {}, remove: new Set() };
    $('#envDir').textContent = dir;
    $('#envDir').title = dir;
    $('#envNewName').value = '';
    $('#envNewValue').value = '';
    $('#envPaste').value = '';
    renderEnv();
    envDlg.showModal();
    // İlk eksik değerin kutusuna odaklan; yoksa hiçbir düğme odakta başlamasın.
    const first = v.required.find((r) => r.needs && !r.set);
    if (first) $(`[data-env-input="${CSS.escape(first.name)}"]`, envDlg)?.focus();
    else document.activeElement?.blur();
  }

  function envRow(item) {
    const pend = state.envPending;
    const removed = pend.remove.has(item.name);
    const changed = item.name in pend.set;
    const chip = removed
      ? '<span class="env-state">silinecek</span>'
      : changed
        ? '<span class="env-state changed">değişti</span>'
        : item.set
          ? '<span class="env-state set">✓ kayıtlı</span>'
          : item.needs
            ? '<span class="env-state missing">gerekli</span>'
            : item.optional
              ? '<span class="env-state">isteğe bağlı</span>'
              : '<span class="env-state" title="Girmezsen projenin varsayılanı kullanılır">varsayılan</span>';
    const ph = item.set
      ? `kayıtlı: ${item.masked} — değiştirmek için yazın`
      : item.example && !item.needs && !item.optional
        ? `varsayılan: ${item.example}`
        : item.example
          ? `örn. ${item.example}`
          : 'değer girin';
    return `<div class="env-row ${removed ? 'removed' : ''}">
      <div class="env-name">${esc(item.name)}</div>
      <input type="password" data-env-input="${esc(item.name)}" value="${esc(changed ? pend.set[item.name] : '')}" placeholder="${esc(ph)}" spellcheck="false" autocomplete="off" ${removed ? 'disabled' : ''} />
      <div class="env-actions">${chip}
        <button type="button" class="icon-btn" data-env-eye="${esc(item.name)}" title="Göster / gizle" aria-label="Değeri göster">${ico('eye')}</button>
        ${item.set || changed ? `<button type="button" class="icon-btn" data-env-del="${esc(item.name)}" title="${removed ? 'Geri al' : 'Sil'}" aria-label="${removed ? 'Geri al' : 'Sil'}">${removed ? ico('undo') : ico('x')}</button>` : ''}
      </div>
      ${item.hint ? `<div class="env-hint" title="${esc(item.hint)}">${esc(item.hint)}</div>` : ''}</div>`;
  }

  // Projenin istedikleri, .env.example'daki bölümlere göre gruplanır ("Database", "Telephony"…).
  function envGroups(items) {
    let last = null;
    return items
      .map((it) => {
        const head = it.section && it.section !== last ? `<div class="env-group">${esc(it.section)}</div>` : '';
        last = it.section;
        return head + envRow(it);
      })
      .join('');
  }

  function renderEnv() {
    const v = state.env;
    const pend = state.envPending;
    const reqNames = new Set(v.required.map((r) => r.name));
    const extraNames = new Set(v.extra.map((e) => e.name));
    const added = Object.keys(pend.set)
      .filter((n) => !reqNames.has(n) && !extraNames.has(n))
      .map((n) => ({ name: n, set: false, masked: '' }));
    const extra = [...v.extra, ...added];
    const missing = v.required.filter((r) => r.needs && !r.set && !(r.name in pend.set)).length;
    const notes = [];
    if (!v.projectReady) notes.push('Proje henüz kurulmadı: değerler şimdi kaydedilir, ilk görev projeyi oluşturduktan sonra <code>.env</code> dosyasına yazılır.');
    if (!v.encrypted) notes.push('Bu sistemde işletim sistemi şifrelemesi yok; değerler Sonda ayar klasöründe düz metin saklanır.');
    $('#envNotice').innerHTML = notes.join('<br>');
    $('#envNotice').hidden = !notes.length;
    $('#envRequired').innerHTML = v.required.length
      ? `<div class="env-section"><div class="sec-title">Projenin istedikleri <span class="count">${esc(v.exampleFile)} · ${missing ? `${missing} gerekli değer eksik` : 'gerekenlerin hepsi girildi'}</span></div><div class="env-list">${envGroups(v.required)}</div></div>`
      : `<div class="env-section"><div class="sec-title">Projenin istedikleri</div><div class="hint">${v.projectReady ? 'Projede henüz <code>.env.example</code> yok. Ajan anahtar gerektiren bir özellik yazınca buraya gelir; istersen aşağıdan kendin ekleyebilirsin.' : 'Proje kurulunca ajanın yazdığı <code>.env.example</code> dosyasındaki anahtarlar burada listelenir. Bildiğin anahtarları şimdiden ekleyebilirsin; plan bu adları kullanır.'}</div></div>`;
    $('#envExtra').innerHTML = extra.length ? `<div class="env-section"><div class="sec-title">Eklediklerin</div><div class="env-list">${extra.map(envRow).join('')}</div></div>` : '';
    const n = Object.keys(pend.set).length + pend.remove.size;
    $('#envPending').textContent = n ? `${n} değişiklik kaydedilmedi` : '';
  }

  const envForm = $('#envForm');
  envForm.addEventListener('input', (e) => {
    const inp = e.target.closest('[data-env-input]');
    if (!inp) return;
    const name = inp.dataset.envInput;
    if (inp.value) state.envPending.set[name] = inp.value;
    else delete state.envPending.set[name];
    const n = Object.keys(state.envPending.set).length + state.envPending.remove.size;
    $('#envPending').textContent = n ? `${n} değişiklik kaydedilmedi` : '';
  });
  envForm.addEventListener('change', (e) => {
    if (e.target.closest('[data-env-input]')) renderEnv();
  });
  envForm.addEventListener('click', (e) => {
    const eye = e.target.closest('[data-env-eye]');
    if (eye) {
      const inp = eye.closest('.env-row').querySelector('input');
      inp.type = inp.type === 'password' ? 'text' : 'password';
      return;
    }
    const del = e.target.closest('[data-env-del]');
    if (del) {
      const name = del.dataset.envDel;
      const pend = state.envPending;
      const stored = state.env.required.some((r) => r.name === name && r.set) || state.env.extra.some((x) => x.name === name);
      if (name in pend.set && !stored) delete pend.set[name];
      else if (pend.remove.has(name)) pend.remove.delete(name);
      else {
        delete pend.set[name];
        pend.remove.add(name);
      }
      renderEnv();
    }
  });
  // Enter formu (ve pencereyi) kapatmasın; ekleme alanında "Ekle" gibi davranır.
  envForm.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
    e.preventDefault();
    if (e.target.id === 'envNewName' || e.target.id === 'envNewValue') $('#envAddBtn').click();
  });

  function addEnvPending(name, value) {
    const n = String(name || '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) {
      toast(`Geçersiz ad: "${n}". Harf, rakam ve _ kullanın; rakamla başlamasın.`, true);
      return false;
    }
    state.envPending.set[n] = value;
    state.envPending.remove.delete(n);
    return true;
  }
  $('#envAddBtn').addEventListener('click', () => {
    const name = $('#envNewName').value;
    const value = $('#envNewValue').value;
    if (!name.trim()) return toast('Anahtarın adını yazın (ör. STRIPE_SECRET_KEY).', true);
    if (!value) return toast('Değeri yazın.', true);
    if (!addEnvPending(name, value)) return;
    $('#envNewName').value = '';
    $('#envNewValue').value = '';
    renderEnv();
    $('#envNewName').focus();
  });
  $('#envPasteBtn').addEventListener('click', () => {
    let added = 0;
    for (const line of $('#envPaste').value.split(/\r?\n/)) {
      const m = line.match(ENV_LINE);
      if (!m) continue;
      let v = m[2].trim();
      if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) v = v.slice(1, -1);
      else v = v.replace(/\s+#.*$/, '');
      if (v && addEnvPending(m[1], v)) added++;
    }
    if (!added) return toast('Satırlar ADI=değer biçiminde olmalı.', true);
    $('#envPaste').value = '';
    renderEnv();
    toast(`${added} anahtar eklendi. Kaydetmeyi unutmayın.`);
  });
  $('#envSaveBtn').addEventListener('click', async (e) => {
    e.preventDefault();
    const pend = state.envPending;
    if (!Object.keys(pend.set).length && !pend.remove.size) return envDlg.close();
    const r = await attempt(() => api.saveEnv({ dir: state.envDir, set: pend.set, remove: [...pend.remove] }));
    if (!r) return;
    state.envPending = { set: {}, remove: new Set() };
    envDlg.close();
    toast(r.written?.length ? `Kaydedildi · ${r.written.join(', ')} güncellendi` : r.projectReady ? 'Kaydedildi' : 'Kaydedildi · proje kurulunca .env dosyasına yazılacak');
    if (state.envDir === state.compose.projectDir) refreshComposeEnv();
    if (state.job && state.envDir === state.job.projectDir) refreshJobEnv();
  });
  envDlg.addEventListener('close', () => {
    state.envPending = { set: {}, remove: new Set() };
  });

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
  }

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
      .map((a) => `<div class="agent-card">
        <div class="top"><span class="dot ${a.found && a.loggedIn !== false ? 'done' : a.found ? 'waiting' : ''}"></span><b>${esc(a.label)}</b><span class="count">${esc((a.version || '').replace(/\(.*\)/, '').trim())}${a.installedVia ? ` · ${esc(a.installedVia)}` : ''}</span></div>
        ${a.found ? `<code>${esc(a.path)}</code>` : `<span>Kurulu değil. Kurulum:</span><code>${esc(a.install)}</code>`}
        ${a.updateAvailable ? `<div class="update-line">${ico('arrow-up')} Yeni sürüm var: <b>${esc(a.latest)}</b>${a.canUpdate ? ` <button type="button" class="btn sm" data-update-agent="${a.id}">Güncelle</button>` : ` <span class="hint">Terminalde: <code>${esc(a.install)}</code></span>`}</div>` : a.found && a.latest ? '<span class="hint">Güncel ✓</span>' : ''}
        ${a.found && a.loggedIn === false ? `<span style="color:var(--warn)">Çalıştırılamadı${a.authError ? `: ${esc(a.authError.slice(0, 140))}` : ''}</span>` : a.loggedIn ? '<span style="color:var(--ok)">Oturum açık ✓</span>' : ''}
        ${a.found && a.loggedIn === false ? '' : `<span class="hint">${esc(a.login)}</span>`}
        ${a.found ? `<div class="row"><button type="button" class="btn sm" data-test-agent="${a.id}">Bağlantıyı test et</button><button type="button" class="btn sm" data-login-agent="${a.id}">Giriş yap</button></div>` : ''}
      </div>`)
      .join('');
  }
  async function updateAgent(id, btn) {
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Güncelleniyor…';
    }
    const r = await attempt(() => api.updateAgent(id));
    if (r) toast(r.after && r.before && r.after !== r.before ? `✓ ${AGENT_LABEL[id]} ${r.before} → ${r.after} güncellendi` : `${AGENT_LABEL[id]} bu kurulum yoluyla alınabilecek en yeni sürümde (${r.after || r.before}).`);
    await refreshAgents(true);
  }

  $('#agentDetect').addEventListener('click', async (e) => {
    const up = e.target.closest('[data-update-agent]');
    if (up) return updateAgent(up.dataset.updateAgent, up);
    const login = e.target.closest('[data-login-agent]');
    if (login) return attempt(() => api.loginAgent(login.dataset.loginAgent), 'Terminal açıldı. Giriş bitince ayarları kaydedip tekrar kontrol edin.');
    const b = e.target.closest('[data-test-agent]');
    if (!b) return;
    b.disabled = true;
    b.textContent = 'Test ediliyor…';
    const r = await attempt(() => api.testAgent(b.dataset.testAgent));
    b.disabled = false;
    b.textContent = 'Bağlantıyı test et';
    if (r) toast(`✓ ${AGENT_LABEL[b.dataset.testAgent]} çalışıyor ve oturum açık. Yanıt: ${r.reply}`);
    refreshAgents();
  });

  function openSettings(pane = 'general') {
    fillSettings();
    renderAgentDetect();
    selectSettingsPane(pane);
    if (!dlg.open) dlg.showModal();
    document.activeElement?.blur();
  }
  $('#settingsBtn').addEventListener('click', () => openSettings());

  async function saveSettings(patch) {
    const s = await attempt(() => api.saveSettings(patch));
    if (s) {
      state.settings = s;
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
    toast(`${models.length} model bulundu. Model alanına tıklayıp seçebilirsiniz.`);
    fillSettings();
  });
  $('#testGeminiBtn').addEventListener('click', async () => {
    const patch = { geminiModel: form.elements.geminiModel.value.trim() };
    const key = form.elements.geminiKey.value.trim();
    if (key) patch.geminiKey = key;
    if (!(await saveSettings(patch))) return;
    fillSettings();
    const r = await attempt(() => api.testGemini());
    if (r) toast(`✓ Gemini çalışıyor (${r.model}): "${r.reply}"`);
  });
  $('#resetStandardsBtn').addEventListener('click', () => {
    $('#standardsInput').value = state.settings.defaultStandards;
  });

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
      state.busy = evt.busy;
      state.contentKey = '';
      if (state.job && state.view === 'job') renderJob();
      renderReadiness();
      refreshHistorySoon();
      if (!evt.busy && state.job?.phase === 'done') selectTab('report');
    } else if (evt.type === 'app') {
      state.app = evt;
      if (state.job && state.view === 'job') renderJob();
    }
  });

  // Terminal'de giriş yapıp pencereye dönünce giriş durumunu kendiliğinden yenile.
  let focusCheck = 0;
  window.addEventListener('focus', () => {
    const needs = Object.values(state.agents || {}).some((a) => a.found && a.loggedIn === false);
    if (!needs || Date.now() - focusCheck < 5000) return;
    focusCheck = Date.now();
    refreshAgents(true);
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
    state.busy = !!cur?.busy;
    state.app = (await attempt(() => api.appStatus())) || state.app;
    if (cur?.job && cur.busy) await openJob(cur.job.id);
    else show('compose');
    refreshAgents();
    if (!state.settings?.hasGeminiKey) setTimeout(() => openSettings(), 400);
  }
  init();
})();
