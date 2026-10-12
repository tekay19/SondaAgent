// İş görünümü: başlık, istatistikler, plan içeriği, görevler, plan eylemleri, rapor ve belgeler.
import { api, $, $$, esc, md, firstLine, stIcon, PHASES, ACTIVE, TASK_STATUS, KIND_LABEL, FINDING_LABEL, SEV_LABEL, managerOf, state, toast, attempt, baseName, ico, fmtDur, busyHere, isLiveJob } from './core.js';
import { renderEnvBadge } from './history.js';
import { connectAgent } from './agents.js';
import { emptyHtml, KLOADER } from './theme.js';
import { isDesignAtt, submitPlan } from './compose.js';
import { selectTab } from './header.js';
import { openMaint, zipCurrentProject } from './maintenance.js';

// ---------- iş görünümü ----------
function renderJob() {
  const job = state.job;
  if (!job) return;
  const [label, cls] = PHASES[job.phase] || [job.phase, ''];
  $('#jobTitle').textContent = job.plan?.projectName || (job.phase === 'planning' ? (job.kind === 'feature' ? 'Özellik tasarlanıyor…' : job.kind === 'bugfix' ? 'Hata inceleniyor…' : job.kind === 'refactor' ? 'Kod inceleniyor…' : 'Plan hazırlanıyor…') : baseName(job.projectDir) || 'Proje');
  $('#jobTitle').title = `${$('#jobTitle').textContent} — ${job.projectDir}`;
  const pill = $('#phasePill');
  pill.textContent = label;
  pill.className = `pill ${cls}`;

  const live = isLiveJob();
  $('#stopBtn').hidden = !(live || job.phase === 'awaiting_approval' || job.phase === 'awaiting_answers');
  // Çalışan işte yalnızca kırmızı bir kare; onay beklerken (henüz çalışmıyor) "İptal" yazılı kalır.
  $('#stopBtn').innerHTML = live ? '<span class="stop-glyph" aria-hidden="true"></span>' : `${ico('x')} İptal`;
  $('#stopBtn').classList.toggle('stop-only', live);
  $('#stopBtn').title = live ? 'Durdur' : 'İptal et';
  $('#stopBtn').setAttribute('aria-label', live ? 'Durdur' : 'İptal et');
  $('#resumeBtn').hidden = live || !['failed', 'stopped'].includes(job.phase) || !job.tasks?.length;
  const appHere = state.app.dir === job.projectDir && state.app.state !== 'stopped';
  $('#runAppBtn').hidden = live || !job.tasks?.some((t) => t.status === 'done' || t.status === 'failed');
  // Yalnızca simge: çalıştır ▶ · başlıyor (saat) · kapat ■; ne işe yaradığı ipucunda.
  const runLabel = appHere ? (state.app.state === 'starting' ? 'Başlatılıyor…' : 'Uygulamayı kapat') : 'Çalıştır';
  $('#runAppBtn').innerHTML = appHere ? (state.app.state === 'starting' ? ico('clock') : ico('stop')) : ico('play');
  $('#runAppBtn').title = runLabel;
  $('#runAppBtn').setAttribute('aria-label', runLabel);
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
  // Alt satır iki parça: dokuma (yalnızca görevler değişince yeniden çizilir, animasyon tekrarlanmaz)
  // ve süre (dakikada bir değişir).
  const mainHtml = `${job.kind ? `<span class="badge kind-${job.kind}">${KIND_LABEL[job.kind]}</span>` : ''}<span class="idea" title="${esc(String(job.idea || '').slice(0, 300))}">${esc(firstLine(job.idea) || `Dokümanlardan: ${(job.attachments || []).map((a) => a.name).join(', ')}`)}</span>${tasks.length ? `<span class="sep">·</span><span class="weave-wrap" title="Görevler: ${done}/${tasks.length} tamam">${weaveHtml(job)} <b>${done}/${tasks.length}</b></span>` : ''}`;
  const metaParts = [];
  if (dur) metaParts.push(`<span class="sep">·</span><span title="${live ? 'Geçen süre' : 'Son çalışmaya kadar geçen süre'}"><b>${dur}</b></span>`);
  // Bekleme: kullanım limiti (saatiyle) ya da bağlantı kesintisi (bağlantı gelince kendiliğinden sürer).
  if (job.waitUntil && live) {
    metaParts.push(job.waitKind === 'network'
      ? `<span class="sep">·</span><span style="color:var(--warn-text)" title="Sunucuya ulaşılamıyor; bağlantı gelince iş kaldığı yerden kendiliğinden devam eder">${ico('pause')} bağlantı bekleniyor</span>`
      : `<span class="sep">·</span><span style="color:var(--warn-text)" title="Ajan kullanım limitine takıldı; süre dolunca otomatik devam eder">${ico('pause')} limit · ${new Date(job.waitUntil).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}'de devam</span>`);
  }
  if (!$('#jobSubMain')) $('#jobSub').innerHTML = '<span id="jobSubMain" class="job-sub-main"></span><span id="jobSubMeta" class="job-sub-meta"></span>';
  if ($('#jobSubMain').dataset.key !== mainHtml) {
    $('#jobSubMain').dataset.key = mainHtml;
    $('#jobSubMain').innerHTML = mainHtml;
  }
  $('#jobSubMeta').innerHTML = metaParts.join('');
  const rows = [];
  if (tasks.length) rows.push(['Görev', `${done}/${tasks.length}`]);
  if (job.agent === 'claude' && state.settings?.claudeModelLabel) rows.push(['Claude modeli', esc(state.settings.claudeModelLabel)]);
  if (st.agentRuns) rows.push(['Ajan oturumu', `${st.agentRuns}×`]);
  if (st.costUsd) rows.push(['API karşılığı*', `≈$${st.costUsd.toFixed(2)}`]);
  if (st.geminiTokens) rows.push(['Gemini', `${Math.round(st.geminiTokens / 1000)}K token`]);
  if (st.managerTokens) rows.push(['Claude API', `${Math.round(st.managerTokens / 1000)}K token`]);
  if (dur) rows.push(['Süre', dur]);
  $('#jobStats').innerHTML = rows.length ? rows.map(([k, v]) => `<span>${k}</span><b>${v}</b>`).join('') : '<span>Henüz istatistik yok</span>';
  $('#jobStats').title = st.costUsd ? '* Claude aboneliğinle çalışıyorsan ücret yok; bu, aynı işin API fiyatlarıyla tahmini karşılığıdır.' : '';
}
setInterval(() => {
  if (state.view === 'job' && isLiveJob()) renderStats();
}, 1000);

// Her görev bir kilim baklavası: tamam (yeşil), çalışıyor (turkuaz), sorunlu (nar); fazlar arası boşluk.
const TASK_WORD = { done: 'tamam', failed: 'sorunlu', skipped: 'atlandı', pending: 'sırada' };
function weaveHtml(job) {
  const tasks = job.tasks || [];
  const dense = tasks.length > 24;
  let prevPhase = null;
  return `<span class="weave${dense ? ' dense' : ''}" aria-hidden="true">${tasks
    .map((t, i) => {
      const active = job.currentTaskId === t.id && ACTIVE.has(job.phase);
      const cls = active ? 'active' : ['done', 'failed', 'skipped'].includes(t.status) ? t.status : '';
      const gap = prevPhase !== null && t.phase && t.phase !== prevPhase ? ' gap' : '';
      prevPhase = t.phase || prevPhase;
      return `<i class="${cls}${gap}" style="--i:${i}" title="${i + 1}. ${esc(t.title)} — ${active ? 'çalışıyor' : TASK_WORD[t.status] || 'devam ediyor'}"></i>`;
    })
    .join('')}</span>`;
}

function renderPlanContent() {
  const job = state.job;
  const key = JSON.stringify([job.id, job.phase, job.plan?.projectName, job.tasks, job.gates, job.finalReview, job.userNotes, job.audits, job.findings, job.reqStatus, job.discovery?.productBrief?.length, job.planCritique?.summary, job.planReview?.rounds?.length, job.plan?.maintenance?.summary, job.kind, [...state.openTasks], [...state.skip], busyHere(), state.summaryOpen]);
  if (key === state.contentKey) return;
  state.contentKey = key;
  const el = $('#planContent');

  if (!job.plan) {
    const brief = job.discovery?.productBrief;
    const waitingText = job.kind === 'feature'
      ? 'Claude projeyi inceleyip özelliği tasarlıyor (5–15 dk).'
      : job.kind === 'bugfix'
      ? 'Claude kök nedeni arıyor (3–10 dk).'
      : job.kind === 'refactor'
        ? 'Claude refactor adaylarını çıkarıyor (5–15 dk).'
        : job.discovery
      ? 'Gereksinimler çıkarılıyor; ardından plan yazılacak (10–25 dk).'
      : 'Ürün tanımı hazırlanıyor…';
    el.innerHTML = `<div class="sec"><div class="sec-title">${brief ? `Ürün tanımı (${managerOf(state.settings).name} keşfi)` : job.kind ? KIND_LABEL[job.kind] : 'Plan'}</div>
        ${job.kind && job.idea ? `<p class="summary-text" style="white-space:pre-wrap;margin-bottom:10px">${esc(job.idea)}</p>` : ''}
        ${job.phase === 'planning' ? `<p class="summary-text" style="color:var(--muted)">${KLOADER}${waitingText}</p>` : ''}
        ${!brief && job.phase !== 'planning' ? `<p class="summary-text" style="color:var(--muted)">${esc(job.error || (job.kind ? 'İnceleme tamamlanamadı.' : 'Plan oluşturulamadı.'))}</p>` : ''}
        ${(job.attachments || []).length ? `<div class="tags" style="margin-top:10px">${job.attachments.map((a) => `<span class="tag${isDesignAtt(a) ? ' design' : ''}" title="${isDesignAtt(a) ? 'Tasarım: arayüz buna göre yapılır' : 'Doküman'}">${ico(isDesignAtt(a) ? 'design' : 'clip')} ${esc(a.name)}${a.kind === 'folder' ? '/' : ''}</span>`).join('')}</div>` : ''}
        ${brief ? `<div class="md brief product-brief">${md(brief)}</div>` : ''}</div>`;
    return;
  }
  const p = job.plan;
  const approving = job.phase === 'awaiting_approval' && !busyHere();
  const fold = (title, inner, count, open) => `<details class="fold" ${open ? 'open' : ''}><summary>${title}${count != null ? ` <span class="count">${count}</span>` : ''}</summary>${inner}</details>`;
  // Bulgu defteri: doğrulanmış her kusurun akıbeti (açık / doğrulanamadı / düzeltildi).
  const ledger = job.findings || [];
  const lOpen = ledger.filter((f) => f.status === 'open');
  const lUnc = ledger.filter((f) => f.status === 'uncertain');
  const lFixed = ledger.filter((f) => f.status === 'fixed');
  const AREA = { security: 'güvenlik', logic: 'iş kuralları', quality: 'mimari/test', manager: 'ilk inceleme', audit: 'bağımsız denetim' };
  const ledgerRow = (f, cls) => `<li class="lf ${cls}"><span class="badge ${cls === 'open' ? (['critical', 'high'].includes(f.severity) ? 'err' : 'warn') : cls === 'fixed' ? 'ok' : ''}">${esc(f.id)} · ${esc(f.severity)}</span> <b>${esc(f.title)}</b> <span class="lf-meta">${esc(AREA[f.area] || f.area || '')}${f.file ? ` · ${esc(f.file)}${f.line ? `:${f.line}` : ''}` : ''} · ${esc(f.label || '')}</span>${f.note ? `<div class="lf-note">${esc(f.note)}</div>` : ''}</li>`;
  const ledgerHtml = ledger.length
    ? fold(
        `Bulgu defteri <span class="count">${lFixed.length} düzeltildi${lOpen.length ? ` · ${lOpen.length} açık` : ''}${lUnc.length ? ` · ${lUnc.length} doğrulanamadı` : ''}</span>`,
        `<ul class="ledger">${lOpen.map((f) => ledgerRow(f, 'open')).join('')}${lUnc.map((f) => ledgerRow(f, 'unc')).join('')}${lFixed.map((f) => ledgerRow(f, 'fixed')).join('')}</ul>`,
        null,
        lOpen.length > 0
      )
    : '';
  // Claude önerileri: bağımsız denetimlerin önerileri ve akıbetleri (uygulandı / açık / yanlış alarm / düşük öncelik).
  const audits = job.audits || [];
  const byLedger = new Map(ledger.map((f) => [f.id, f]));
  const auditState = (x) => {
    const led = x.ledgerId ? byLedger.get(x.ledgerId) : null;
    if (x.known) return ['', 'zaten izleniyordu'];
    if (x.verdict === 'rejected') return ['', 'yanlış alarm'];
    if (x.verdict === 'low') return ['', 'düşük öncelik'];
    if (led?.status === 'fixed') return ['ok', 'uygulandı'];
    if (led?.status === 'rejected') return ['', 'yanlış alarm'];
    if (x.verdict === 'uncertain' || led?.status === 'uncertain') return ['warn', 'belirsiz'];
    return [['critical', 'high'].includes(x.severity) ? 'err' : 'warn', 'açık'];
  };
  const auditRows = audits.flatMap((a) => (a.suggestions || []).map((x) => auditState(x)[1]));
  const auditHtml = audits.length
    ? fold(
        `Claude önerileri <span class="count">${audits.length} denetim · ${auditRows.filter((s) => s === 'uygulandı').length} uygulandı${auditRows.includes('açık') ? ` · ${auditRows.filter((s) => s === 'açık').length} açık` : ''}</span>`,
        audits
          .slice()
          .reverse()
          .map((a) => {
            const after = job.tasks.findIndex((t) => t.id === a.afterTask) + 1;
            return `<h5 class="mini-h">Denetim ${a.n} · ${after}. görevden sonra${a.status !== 'done' ? ' · sürüyor' : a.error ? ` · ${esc(a.error)}` : ''}</h5>${a.summary ? `<p class="summary-text">${esc(a.summary)}</p>` : ''}${(a.suggestions || []).length ? `<ul class="ledger">${a.suggestions
              .map((x) => {
                const [cls, label] = auditState(x);
                return `<li class="lf ${cls === 'ok' ? 'fixed' : ''}"><span class="badge ${cls}">${esc(x.ledgerId ? `${x.ledgerId} · ` : '')}${esc(label)}</span> <b>${esc(x.title)}</b> <span class="lf-meta">${esc(x.severity)}${x.file ? ` · ${esc(x.file)}${x.line ? `:${x.line}` : ''}` : ''}${x.before ? ` · ${esc(x.before)} öncesi` : ''}</span>${x.verifyNote && x.verdict !== 'confirmed' ? `<div class="lf-note">${esc(x.verifyNote)}</div>` : ''}</li>`;
              })
              .join('')}</ul>` : a.status === 'done' && !a.error ? '<p class="summary-text">Temeller sağlam; öneri yok.</p>' : ''}`;
          })
          .join(''),
        null,
        audits.some((a) => a.status !== 'done') || auditRows.includes('açık')
      )
    : '';
  const lessonsHtml = (job.lessons || []).length ? fold('Projenin dersleri', `<ul class="bullets">${job.lessons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`, job.lessons.length, false) : '';
  const final = job.finalReview;
  const reqs = p.requirements || [];
  const st = job.reqStatus || {};
  const met = reqs.filter((r) => st[r.id] === 'met').length;
  const partial = reqs.filter((r) => st[r.id] === 'partial').length;
  const reqLine = reqs.length
    ? `<div class="overview-stats"><span>Gereksinim <b>${met}/${reqs.length}</b></span><div class="req-bar" title="${met} karşılandı, ${partial} kısmen"><i style="width:${(met / reqs.length) * 100}%"></i><em style="width:${(partial / reqs.length) * 100}%"></em></div></div>`
    : '';

  const deliveredHtml = ['done', 'incomplete'].includes(job.phase) && final
    ? (() => {
        const ok = job.phase === 'done';
        const tasksDone = (job.tasks || []).filter((t) => t.status === 'done').length;
        const tasksAll = (job.tasks || []).filter((t) => t.status !== 'skipped').length;
        const dur = job.startedAt && job.finishedAt ? fmtDur(job.finishedAt - job.startedAt) : '';
        const parts = [`${tasksDone}/${tasksAll} görev`, final.qualityScore != null ? `kalite ${final.qualityScore}/10` : '', reqs.length ? `${met}/${reqs.length} gereksinim` : '', dur].filter(Boolean);
        return `<div class="delivered ${ok ? '' : 'incomplete'}">
            <svg class="kilim-band" aria-hidden="true"><rect width="100%" height="100%" fill="url(#kilimPattern)"/></svg>
            <div class="delivered-title"><svg class="ico seal" aria-hidden="true"><use href="#i-${ok ? 'seal' : 'alert'}"/></svg>${ok ? (job.kind ? `${KIND_LABEL[job.kind]} tamamlandı` : 'Teslime hazır') : `${job.kind ? 'Tamamlanamadı' : 'Teslime hazır değil'} — ${(final.issues || []).length} açık sorun`}</div>
            <div class="delivered-sub">${parts.map(esc).join(' · ')}</div>
            <div class="delivered-actions">
              <button class="btn sm primary" data-deliver="run">${ico('play')} Çalıştır</button>
              <button class="btn sm" data-deliver="report">${ico('file')} Raporu aç</button>
              <button class="btn sm" data-deliver="folder">${ico('folder')} Klasörü aç</button>
              <button class="btn sm" data-deliver="zip">${ico('archive')} Zip olarak paketle</button>
            </div>
          </div>`;
      })()
    : '';

  el.innerHTML = `
      ${deliveredHtml}
      ${p.maintenance ? maintenanceHtml(p.maintenance) : ''}
      ${final ? `<div class="sec final-box">
        <div class="sec-title">Son inceleme</div>
        <div class="score">${final.qualityScore ?? '–'}<small> /10 kalite · ${final.verdict === 'pass' ? `${stIcon('done')} Onaylandı` : 'açık sorunlar var'}</small></div>
        <p class="summary-text" style="margin-top:6px">${esc(final.summary)}</p>
        ${final.issues?.length ? `<ul class="bullets" style="margin-top:6px">${final.issues.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}
        ${final.deep ? `<div class="sec-line">${ico('search')} Derin inceleme: <span class="badge ${final.deep.verdict === 'pass' ? 'ok' : 'warn'}">${final.deep.verdict === 'pass' ? 'onay' : 'düzeltme'}</span> <span title="${esc(final.deep.summary)}">${esc((final.deep.summary || '').slice(0, 90))}</span></div>` : ''}
        ${final.security ? `<div class="sec-line">${ico('shield')} Güvenlik: ${final.security.length ? final.security.map((f) => `<span class="badge ${['critical', 'high'].includes(f.severity) ? 'err' : 'warn'}" title="${esc(f.title)}">${esc(f.severity)}</span>`).join(' ') : '<span class="badge ok">bulgu yok</span>'}</div>` : ''}
        ${final.panel ? panelLine(final.panel) : ''}
        ${ledger.length ? `<div class="sec-line">${ico('panel')} Bulgu defteri: <span class="badge ok">${lFixed.length} düzeltildi ve doğrulandı</span>${lOpen.length ? ` <span class="badge err">${lOpen.length} açık</span>` : ''}${lUnc.length ? ` <span class="badge warn">${lUnc.length} doğrulanamadı</span>` : ''}</div>` : ''}
      </div>` : ''}
      <div class="overview">
        <p class="summary-text ${state.summaryOpen ? '' : 'clamp'}" data-summary title="${state.summaryOpen ? '' : 'Tamamı için tıklayın'}">${esc(p.summary)}</p>
        ${reqLine}
      </div>
      <div class="sec">
        <div class="sec-title">Görevler ${approving ? '<span class="count"></span>' : `<span class="count">${(job.tasks || []).filter((t) => t.status === 'done').length}/${(job.tasks || []).filter((t) => t.status !== 'skipped').length}</span>`}</div>
        ${tasksHtml(job, approving)}
      </div>
      <div class="details-group">
        <div class="sec-title">Plan ayrıntıları</div>
        ${job.userNotes?.length ? fold('Verdiğin talimatlar', `<ul class="bullets">${job.userNotes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`, job.userNotes.length, true) : ''}
        ${fold('Teknoloji', `<div class="stack-list">${p.stack.map((x) => esc(x)).join('<br>')}</div>`, p.stack.length, false)}
        ${fold('Özellikler', `<ul class="bullets">${p.features.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>`, p.features.length, false)}
        ${reqs.length ? requirementsHtml(job, fold) : ''}
        ${p.assumptions?.length ? fold('Varsayımlar', `<ul class="bullets">${p.assumptions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>`, p.assumptions.length, false) : ''}
        ${String(p.designDirection || '').trim() ? fold('Tasarım yönü', `<div class="md design-direction">${md(p.designDirection)}</div>`, null, false) : ''}
        ${auditHtml}
        ${ledgerHtml}
        ${lessonsHtml}
        ${p.threatModel?.length ? fold('Tehdit modeli', `<ul class="bullets">${p.threatModel.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>`, p.threatModel.length, false) : ''}
        ${job.discovery?.productBrief ? fold('Ürün tanımı', `<div class="md brief">${md(job.discovery.productBrief)}</div>${job.discovery.answers?.length ? `<h5 class="mini-h">Kararların</h5><ul class="bullets">${job.discovery.answers.map((a) => `<li>${esc(a.question)} → <b>${esc(a.answer)}</b></li>`).join('')}</ul>` : ''}`, null, false) : ''}
        ${job.planReview?.rounds?.length ? fold(`Plan değerlendirmesi <span class="count">${esc(job.planReview.planner)} yazdı, ${esc(managerOf(state.settings).name)} yönetti</span>`, job.planReview.rounds.map((r, i) => `<h5 class="mini-h">Tur ${i + 1} · ${r.verdict === 'approve' ? `${stIcon('done')} onay` : `${ico('refresh')} değişiklik istendi`}</h5><p class="summary-text">${esc(r.summary)}</p>${(r.findings || []).length ? `<ul class="bullets">${r.findings.map((f) => `<li><span class="badge ${f.severity === 'high' ? 'err' : f.severity === 'medium' ? 'warn' : ''}">${esc(f.severity)}</span> ${esc(f.problem)}</li>`).join('')}</ul>` : ''}`).join(''), null, false) : ''}
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
      const ic = s === 'met' ? `<span class="rq met">${stIcon('done')}</span>` : s === 'partial' ? `<span class="rq partial">${stIcon('half')}</span>` : s === 'missing' ? `<span class="rq missing">${stIcon('failed')}</span>` : `<span class="rq">${stIcon('pending')}</span>`;
      const label = { met: 'Karşılandı', partial: 'Kısmen', missing: 'Eksik' }[s] || 'Henüz doğrulanmadı';
      return `<div class="req" title="${esc(label)}${ev ? ` — ${esc(ev)}` : ''}">${ic}<b>${esc(r.id)}</b><span>${esc(r.text)}</span></div>`;
    })
    .join('');
  return fold('Gereksinimler', rows, met ? `${met}/${reqs.length} karşılandı` : reqs.length, false);
}

// Bakım işi: teşhis (hata) ya da kod sağlığı analizi (refactor) — bulgular önem sırasıyla.
function maintenanceHtml(m) {
  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  const feat = m.kind === 'feature';
  const items = [...(m.findings || [])].sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));
  const sevClass = (f) => (feat ? '' : ['critical', 'high'].includes(f.severity) ? 'err' : f.severity === 'medium' ? 'warn' : '');
  const fold = (title, inner, count) => `<details class="fold finding"><summary><b>${title}</b> <span class="count">${count}</span></summary>${inner}</details>`;
  return `<div class="sec maint-box">
      <div class="sec-title">${feat ? 'Özellik tasarımı' : m.kind === 'bugfix' ? 'Teşhis' : 'Kod sağlığı analizi'} <span class="count">${items.length} ${feat ? 'tasarım kararı' : 'bulgu'}</span></div>
      ${m.request ? `<div class="maint-request" title="Senin isteğin">${esc(m.request)}</div>` : ''}
      <div class="md brief maint-summary">${md(m.summary || '')}</div>
      <div class="findings">
      ${feat && m.newRequirements?.length ? fold('Yeni gereksinimler', `<div class="f-detail">${m.newRequirements.map((r) => `<div class="req"><span class="rq">${stIcon('pending')}</span><b>${esc(r.id)}</b><span>${esc(r.text)}</span></div>`).join('')}</div>`, m.newRequirements.length) : ''}
      ${feat && m.assumptions?.length ? fold('Varsayımlar', `<ul class="bullets f-detail">${m.assumptions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>`, m.assumptions.length) : ''}
      ${items
      .map((f) => `<details class="fold finding">
          <summary>${feat ? `<span class="badge" title="Mevcut davranış için risk">risk: ${SEV_LABEL[f.severity] || esc(f.severity)}</span>` : `<span class="badge ${sevClass(f)}">${SEV_LABEL[f.severity] || esc(f.severity)}</span>`}${m.kind === 'refactor' ? `<span class="badge">${FINDING_LABEL[f.type] || esc(f.type)}</span>` : ''}<b>${esc(f.title)}</b></summary>
          <div class="md brief f-detail">${md(f.detail || '')}</div>
          ${(f.files || []).length ? `<div class="f-files">${f.files.slice(0, 6).map((x) => `<code>${esc(x)}</code>`).join(' ')}</div>` : ''}
        </details>`)
      .join('')}
      </div>
    </div>`;
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
            ? `<span class="badge ok" title="${esc(gate.review?.summary || '')}${gate.review?.deep ? ` · Derin inceleme: ${esc(gate.review.deep.summary)}` : ''}${gate.review?.panel ? ` · Uzman paneli: ${(gate.review.panel.confirmed || []).length} doğrulanmış bulgu, ${gate.review.panel.rejected || 0} yanlış alarm elendi` : ''}">kapı ${stIcon('done')} ${gate.review?.qualityScore ?? ''}</span>`
            : gate.status === 'failed'
              ? `<span class="badge err" title="${esc(gate.review?.summary || '')}">kapı ${stIcon('failed')}</span>`
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
      const ic = !c ? stIcon('pending') : c.status === 'met' ? stIcon('done') : c.status === 'partial' ? stIcon('half') : stIcon('failed');
      return `<li class="${c ? c.status : ''}" title="${c ? esc(c.evidence || '') : ''}"><span class="acc-ic">${ic}</span>${esc(a)}${c && c.status !== 'met' && c.evidence ? `<div class="acc-ev">${esc(c.evidence)}</div>` : ''}</li>`;
    })
    .join('')}</ul>`;
}

// Bu görevde bulunan ve hâlâ açık olan doğrulanmış bulgular (bulgu defterinden).
const openOfTask = (t) => (state.job?.findings || []).filter((f) => f.at === `task:${t.id}` && f.status === 'open');

// İlk incelemenin değişikliği kırma denemeleri ve boyut puanları (inceleme kutusunda tek satır).
function riskLine(review) {
  const risks = review?.riskAnalysis || [];
  if (!risks.length && !review?.scores) return '';
  const n = (o) => risks.filter((x) => x.outcome === o).length;
  const sc = review.scores;
  const scores = sc ? ` · doğruluk ${sc.correctness ?? '–'} · sağlamlık ${sc.robustness ?? '–'} · test ${sc.tests ?? '–'} · bakım ${sc.maintainability ?? '–'} · arayüz ${sc.ux ?? '–'}` : '';
  const tip = risks.filter((x) => x.outcome === 'broken' || x.outcome === 'untested').slice(0, 12).map((x) => `${x.outcome === 'broken' ? '✗' : '·'} [${x.area}] ${x.scenario}`).join('\n');
  return `<div class="hint" style="margin-top:4px" title="${esc(tip)}">${ico('search')} İnceleyici ${risks.length} senaryoyla kırmayı denedi: ${n('handled')} ele alınmış${n('broken') ? `, <b>${n('broken')} kırık</b>` : ''}${n('untested') ? `, ${n('untested')} testsiz` : ''}${scores}</div>`;
}

function taskHtml(t, i, approving) {
  const [ic, icCls, label] = TASK_STATUS[t.status] || TASK_STATUS.pending;
  const skipped = approving ? state.skip.has(t.id) : t.status === 'skipped';
  const open = state.openTasks.has(t.id);
  const current = state.job.currentTaskId === t.id && ACTIVE.has(state.job.phase);
  const badges = [];
  if (t.kind && state.job.kind === 'refactor') badges.push(`<span class="badge">${FINDING_LABEL[t.kind] || esc(t.kind)}</span>`);
  if (label && !approving) badges.push(`<span class="badge ${t.status === 'failed' ? 'err' : t.status === 'fixing' ? 'warn' : ''}">${label}${t.status === 'fixing' && t.attempts ? ` ${t.attempts}` : ''}</span>`);
  if (t.review?.qualityScore && t.status === 'done') badges.push(`<span class="badge ${t.review.qualityScore >= 8 ? 'ok' : t.review.qualityScore >= 6 ? '' : 'warn'}" title="${esc(t.review.scoreNote || 'Kalite puanı (ilk inceleme; doğrulanmış bulgularla sınırlanır)')}">${t.review.qualityScore}/10</span>`);
  if (t.review?.panel?.confirmed?.length && t.status !== 'running') badges.push(`<span class="badge ${t.review.panel.blocking ? 'err' : 'warn'}" title="${esc(t.review.panel.confirmed.map((f) => `[${f.severity}] ${f.title}`).join('\n'))}">${t.review.panel.confirmed.length} uzman bulgusu</span>`);
  if (t.agentMinutes && t.status !== 'running') badges.push(`<span class="badge" title="Ajanın kodlama süresi">${t.agentMinutes} dk</span>`);
  if (t.attempts && t.status !== 'fixing') badges.push(`<span class="badge" title="Düzeltme turu">${ico('refresh')}${t.attempts}</span>`);
  const lead = approving
    ? `<input type="checkbox" data-skip="${t.id}" ${skipped ? '' : 'checked'} aria-label="Görevi dahil et" />`
    : `<span class="status-ic ${icCls}">${ic}</span>`;
  const review = t.review
    ? `<h5>İnceleme</h5><div class="review-box">${esc(t.review.summary)}${t.review.scoreNote ? `<div class="hint" style="margin-top:4px">${esc(t.review.scoreNote)}</div>` : ''}${t.review.panel ? `<div class="hint" style="margin-top:4px">${ico('panel')} Uzman incelemesi: ${t.review.panel.confirmed?.length ? `${t.review.panel.confirmed.length} doğrulanmış bulgu` : 'doğrulanmış bulgu yok'}${t.review.panel.rejected ? ` · ${t.review.panel.rejected} yanlış alarm elendi` : ''}</div>` : ''}${riskLine(t.review)}${t.review.testQuality ? `<div class="hint" style="margin-top:4px">${ico('flask')} ${esc(t.review.testQuality)}</div>` : ''}${openOfTask(t).length ? `<div class="hint warn-text" style="margin-top:4px">${ico('panel')} ${openOfTask(t).length} doğrulanmış bulgu hâlâ açık (bulgu defterinde); faz kapısı bunlar düzelmeden geçilemez.</div>` : ''}${t.review.deep ? `<div class="hint" style="margin-top:4px">${ico('search')} Derin inceleme: ${esc(t.review.deep.summary)}</div>` : ''}${t.review.issues?.length ? `<ul class="bullets">${t.review.issues.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</div>`
    : '';
  return `<li class="task ${open ? 'open' : ''} ${current ? 'current' : ''} ${skipped ? 'skipped' : ''}" data-task="${t.id}">
      <div class="task-head">${lead}
        <div class="task-main"><div class="task-title"><span class="task-num">${i + 1}</span>${esc(t.title)}</div><div class="task-goal">${esc(t.goal)}</div>${badges.length ? `<div class="task-meta">${badges.join('')}</div>` : ''}</div></div>
      <div class="task-body">
        <h5>Detaylar</h5><pre>${esc(t.details)}</pre>
        <h5>Kabul kriterleri</h5>${acceptanceHtml(t)}
        ${t.tests?.length ? `<h5>Yazılacak testler</h5><ul class="bullets">${t.tests.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
        ${t.tddFiles?.length ? `<h5>TDD — önce yazılan testler</h5><div class="tags">${t.tddFiles.map((f) => `<span class="tag">${esc(f)}</span>`).join('')}</div>` : ''}
        ${t.covers?.length ? `<h5>Karşıladığı gereksinimler</h5><div class="tags">${t.covers.map((c) => `<span class="tag">${esc(c)}</span>`).join('')}</div>` : ''}
        ${t.brief ? `<details class="fold"><summary>Teknik brif${t.briefBy ? ` (${esc(t.briefBy)})` : ''}</summary><div class="md brief">${md(t.brief)}</div></details>` : ''}
        ${review}
        ${t.agentSummary ? `<h5>Ajanın özeti</h5><div class="md" style="padding:0">${md(t.agentSummary)}</div>` : ''}
      </div></li>`;
}

$('#planContent').addEventListener('click', (e) => {
  const dv = e.target.closest('[data-deliver]');
  if (dv) {
    if (dv.dataset.deliver === 'run') $('#runAppBtn').click();
    if (dv.dataset.deliver === 'report') selectTab('report');
    if (dv.dataset.deliver === 'folder' && state.job) attempt(() => api.openProject(state.job.id));
    if (dv.dataset.deliver === 'zip') zipCurrentProject(dv);
    return;
  }
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

// İptal edilmiş işte geri getirilecek bir şey var mı: hazır bir plan ya da cevaplanmamış sorular.
const canReopen = (job) => !!((job.plan && job.tasks?.length) || (job.discovery?.questions?.length && !job.discovery.answers));

// Alt eylem alanı yalnızca "mod" değişince yeniden çizilir; böylece yazılan metin kaybolmaz.
function renderPlanActions() {
  const job = state.job;
  const live = isLiveJob();
  let mode = 'none';
  if (job.phase === 'awaiting_answers' && !busyHere()) mode = 'answer';
  else if (job.phase === 'awaiting_approval' && !busyHere()) mode = 'approve';
  else if (live && job.plan) mode = 'note';
  else if (!busyHere() && job.phase === 'incomplete') mode = 'incomplete';
  else if (!busyHere() && ['failed', 'stopped'].includes(job.phase) && job.plan && job.tasks?.length) mode = 'resume';
  else if (!busyHere() && ['failed', 'stopped'].includes(job.phase) && !job.plan) mode = 'retryPlan';
  else if (!busyHere() && job.phase === 'cancelled' && canReopen(job)) mode = 'cancelled';
  else if (!busyHere() && ['done', 'cancelled'].includes(job.phase)) mode = 'followup';
  const key = `${job.id}:${mode}:${(job.plan?.questions || []).length}:${job.errorKind || ''}`;
  if (key === state.actionsKey) return;
  state.actionsKey = key;
  const el = $('#planActions');

  if (mode === 'answer') {
    const qs = job.discovery?.questions || [];
    el.innerHTML = `<div class="approve-box">
        <div class="questions sec"><div class="sec-title">Planı netleştirmek için sorular <span class="count"></span></div>
        ${qs
        .map(
          (q, i) => `<fieldset class="question q-card"><legend>${esc(q.question)}</legend>${q.why ? `<div class="hint">${esc(q.why)}</div>` : ''}
            <div class="opts">${q.options
            .map((o) => `<label class="opt"><input type="radio" name="dq${i}" value="${esc(o)}" ${o === q.default ? 'checked' : ''}/> ${esc(o)}${o === q.default ? ' <span class="badge ok">önerilen</span>' : ''}</label>`)
            .join('')}</div>
            <input class="q-other" data-dq="${i}" placeholder="Başka cevap (isteğe bağlı)" /></fieldset>`
        )
        .join('')}</div>
        <div class="approve-actions">
          <button class="btn" id="defaultsBtn">Varsayılanlarla devam et</button>
          <button class="btn primary" id="answerBtn">Cevaplarla planla</button>
        </div></div>`;
    const collect = () =>
      qs.map((q, i) => {
        const other = $(`[data-dq="${i}"]`, el).value.trim();
        const picked = $(`input[name="dq${i}"]:checked`, el)?.value || q.default;
        return other ? `${picked} — ${other}` : picked;
      });
    $('#answerBtn').onclick = async () => {
      state.actionsKey = '';
      await attempt(() => api.answer(state.job.id, collect()));
    };
    $('#defaultsBtn').onclick = async () => {
      state.actionsKey = '';
      await attempt(() => api.answer(state.job.id, qs.map((q) => q.default)));
    };
  } else if (mode === 'approve') {
    const qs = job.plan.questions || [];
    el.innerHTML = `<div class="approve-box">
        ${qs.length ? `<div class="questions sec"><div class="sec-title">${esc(managerOf(state.settings).name)}'in soruları <span class="count"></span></div>
          ${qs.map((q, i) => `<div class="question"><label for="q${i}">${esc(q)}</label><input id="q${i}" data-q="${i}" placeholder="Varsayılan kullanılır" /></div>`).join('')}</div>` : ''}
        <textarea id="feedback" rows="2" placeholder="Plan için not (isteğe bağlı)"></textarea>
        <div class="approve-actions">
          <button class="btn" id="replanBtn">${ico('refresh')} Planı güncelle</button>
          <button class="btn primary" id="approveBtn">Onayla ve başlat</button>
        </div></div>`;
    $('#replanBtn').onclick = async () => {
      const answers = $$('[data-q]', el)
        .filter((i) => i.value.trim())
        .map((i) => `Q: ${qs[Number(i.dataset.q)]}\nA: ${i.value.trim()}`);
      const fb = [$('#feedback').value.trim(), answers.length ? `Answers to your questions:\n${answers.join('\n')}` : ''].filter(Boolean).join('\n\n');
      if (!fb) return toast('Önce bir geri bildirim yazın ya da soruları cevaplayın.', true);
      state.actionsKey = '';
      await attempt(() => api.replan(state.job.id, fb));
    };
    $('#approveBtn').onclick = async () => {
      const answers = $$('[data-q]', el).filter((i) => i.value.trim());
      if (answers.length && !confirm('Soruları cevapladınız ama planı güncellemediniz. Cevaplar ajanlara talimat olarak iletilsin mi?')) return;
      for (const i of answers) await attempt(() => api.addNote(state.job.id, `${qs[Number(i.dataset.q)]} → ${i.value.trim()}`));
      if ($('#feedback').value.trim()) await attempt(() => api.addNote(state.job.id, $('#feedback').value.trim()));
      state.actionsKey = '';
      await attempt(() => api.approve(state.job.id, { skipTaskIds: [...state.skip] }));
    };
  } else if (mode === 'note') {
    el.innerHTML = `<div class="note-box">
        <div class="row"><input id="noteInput" placeholder="Ajana talimat ver" title="Talimat bir sonraki ajan adımına ve incelemelere eklenir." /><button class="btn sm" id="noteBtn">Gönder</button></div></div>`;
    const send = async () => {
      const v = $('#noteInput').value.trim();
      if (!v) return;
      if (await attempt(() => api.addNote(state.job.id, v), 'Talimat iletildi')) $('#noteInput').value = '';
    };
    $('#noteBtn').onclick = send;
    $('#noteInput').onkeydown = (e) => e.key === 'Enter' && send();
  } else if (mode === 'incomplete') {
    const open = job.finalReview?.issues || [];
    el.innerHTML = `<div class="note-box">
        <div class="sec-title">Teslime hazır değil — ${open.length} açık sorun</div>
        <ul class="bullets" style="margin-bottom:8px">${open.slice(0, 12).map((i) => `<li>${esc(i)}</li>`).join('')}</ul>
        <textarea id="finalNote" rows="2" placeholder="İsteğe bağlı: yol göster"></textarea>
        <div class="approve-actions"><button class="btn primary" id="continueFinalBtn">${ico('refresh')} Düzeltmeye devam et</button></div></div>`;
    $('#continueFinalBtn').onclick = async () => {
      const note = $('#finalNote').value.trim();
      if (note && !(await attempt(() => api.addNote(state.job.id, note)))) return;
      state.actionsKey = '';
      await attempt(() => api.continueFinal(state.job.id));
    };
  } else if (mode === 'retryPlan') {
    const kept = !!job.discovery?.answers;
    el.innerHTML = `<div class="note-box">
        <div class="sec-title">Planlama tamamlanamadı</div>
        ${job.error ? `<div class="review-box" style="margin-bottom:8px">${esc(job.error)}</div>` : ''}
                <div class="approve-actions">${job.errorKind === 'auth' ? `<button class="btn" id="retryLoginBtn">${ico('lock')} Giriş yap</button>` : ''}<button class="btn primary" id="retryPlanBtn">${ico('refresh')} ${kept ? 'Planlamaya devam et' : 'Tekrar dene'}</button>${kept ? '<button class="btn ghost" id="freshPlanBtn">Baştan başla</button>' : ''}</div></div>`;
    if (job.errorKind === 'auth') $('#retryLoginBtn').onclick = () => connectAgent('claude');
    $('#retryPlanBtn').onclick = async () => {
      state.actionsKey = '';
      await attempt(() => api.resume(state.job.id));
    };
    if (kept) $('#freshPlanBtn').onclick = () => submitPlan({ idea: job.idea, projectDir: job.projectDir, agent: job.agent, attachments: (job.attachments || []).map((a) => ({ ...a, supported: true })) });
  } else if (mode === 'resume') {
    el.innerHTML = `<div class="note-box">
        <div class="sec-title">Kaldığı yerden devam et</div>
        ${job.error ? `<div class="review-box" style="margin-bottom:8px">${esc(job.error)}</div>` : ''}
        <textarea id="resumeNote" rows="2" placeholder="İsteğe bağlı: yol göster"></textarea>
        <div class="approve-actions">${job.errorKind === 'auth' ? `<button class="btn" id="resumeLoginBtn">${ico('lock')} Giriş yap</button>` : ''}<button class="btn primary" id="resumeWithNoteBtn">${ico('refresh')} Sürdür</button></div></div>`;
    if (job.errorKind === 'auth') $('#resumeLoginBtn').onclick = () => connectAgent(job.agent === 'codex' ? 'codex' : 'claude');
    $('#resumeWithNoteBtn').onclick = async () => {
      const note = $('#resumeNote').value.trim();
      if (note && !(await attempt(() => api.addNote(state.job.id, note)))) return;
      state.actionsKey = '';
      await attempt(() => api.resume(state.job.id));
    };
  } else if (mode === 'cancelled') {
    const planned = !!job.plan;
    const reqs = (job.plan?.requirements || []).length;
    el.innerHTML = `<div class="note-box">
        <div class="sec-title">${planned ? 'Bu plan iptal edildi' : 'Bu iş iptal edildi'}</div>
        <div class="pending-notes" style="margin-bottom:8px">${planned
    ? `Plan duruyor: ${job.tasks.length} görev${reqs ? `, ${reqs} gereksinim` : ''} ve teknik şartname. Geri getirirsen yeniden planlamadan onaylayıp başlatabilir ya da planı güncelleyebilirsin.`
    : 'Ürün tanımı ve sorular duruyor. Geri getirirsen kaldığın yerden cevaplayıp planlatabilirsin.'}</div>
        <div class="approve-actions"><button class="btn primary" id="reopenBtn">${ico('refresh')} ${planned ? 'Planı geri getir' : 'İşi geri getir'}</button></div></div>`;
    $('#reopenBtn').onclick = async () => {
      state.actionsKey = '';
      await attempt(() => api.reopen(state.job.id));
    };
  } else if (mode === 'followup') {
    el.innerHTML = `<div class="note-box">
        <div class="sec-title">Bu projede devam et</div>
        <div class="follow-more"><button class="btn sm primary" id="followFeatBtn">${ico('feature')} Özellik ekle…</button><button class="btn sm" id="followBugBtn">${ico('bug')} Hata düzelt…</button><button class="btn sm" id="followRefBtn">${ico('refactor')} Refactor…</button></div></div>`;
    $('#followFeatBtn').onclick = () => openMaint('feature');
    $('#followBugBtn').onclick = () => openMaint('bugfix');
    $('#followRefBtn').onclick = () => openMaint('refactor');
  } else {
    el.innerHTML = '';
  }
}

// Teslim raporunun kapağı: kilim bordürü, proje adı, durum ve özet rozetleri.
function reportCover(job) {
  const p = job.plan || {};
  const final = job.finalReview || {};
  const ok = job.phase === 'done';
  const tasks = (job.tasks || []).filter((t) => t.status !== 'skipped');
  const reqs = p.requirements || [];
  const met = reqs.filter((r) => (job.reqStatus || {})[r.id] === 'met').length;
  const date = new Date(job.finishedAt || Date.now()).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' });
  const chips = [date, `${tasks.filter((t) => t.status === 'done').length}/${tasks.length} görev`, final.qualityScore != null ? `kalite ${final.qualityScore}/10` : '', reqs.length ? `${met}/${reqs.length} gereksinim` : ''].filter(Boolean);
  return `<header class="report-cover">
      <svg class="kilim-band" aria-hidden="true"><rect width="100%" height="100%" fill="url(#kilimPattern)"/></svg>
      <div class="rc-kicker">Teslim raporu</div>
      <h1>${esc(p.projectName || 'Proje')}</h1>
      <div class="rc-meta"><span class="rc-chip ${ok ? 'ok' : 'warn'}">${ok ? 'Teslime hazır' : 'Teslime hazır değil'}</span>${chips.map((c) => `<span>${esc(c)}</span>`).join('')}</div>
    </header>`;
}

function renderDocs() {
  const job = state.job;
  $('#report').innerHTML = job.report ? reportCover(job) + md(job.report) : emptyHtml('Rapor iş bitince görünür.');
  if (job.plan) {
    const p = job.plan;
    const specKey = `${job.id}:${p.projectName}:${p.spec?.length}`;
    if ($('#spec').dataset.key !== specKey) {
      $('#spec').dataset.key = specKey;
      $('#spec').innerHTML = md(`## ${p.projectName}\n\n${p.summary}\n\n### Gereksinimler\n${(p.requirements || []).map((r) => `- **${r.id}** ${r.text}`).join('\n')}\n\n---\n\n${p.spec || ''}`);
    }
  } else {
    $('#spec').dataset.key = '';
    $('#spec').innerHTML = emptyHtml('Şartname plan hazır olunca görünür.');
  }
  const memKey = `${job.id}:${(job.memory || '').length}:${(job.carryOver || []).length}`;
  if ($('#memory').dataset.key !== memKey) {
    $('#memory').dataset.key = memKey;
    $('#memory').innerHTML = job.memory
      ? md(`${job.carryOver?.length ? `### Sonraki görevlere devreden notlar\n${job.carryOver.map((c) => `- ${c}`).join('\n')}\n\n---\n\n` : ''}${job.memory}`)
      : emptyHtml('Hafıza her görevden sonra güncellenir.');
  }
}

export { renderJob };
