// Teslim raporu: rapor istemi, bulgu defteri ve uzman paneli özetleri.
const { MAINTENANCE_TITLE } = require('./base');
const { reqStatusText } = require('./context');

// ---------- Rapor ----------
function reportSystem(lang) {
  return `You write the final delivery report of an automated software build for the user. Write in ${lang || 'the language of the user request'}, in clean GitHub-flavored Markdown, concise and honest (never claim something works if tests say otherwise). Sections:
## Özet (what was built, 2-4 sentences) — translate headings to the report language
## Nasıl çalıştırılır (exact commands, URL)
## Yapılanlar (features grouped logically)
## Mimari (short: stack, folder structure, key decisions)
## Test sonuçları (build/lint/test/browser test results, phase gates, quality score)
## Gereksinim kapsamı (X/Y met; list the ones not confirmed)
## Güvenlik (audit findings and their status)
## Bilinen sorunlar ve sonraki adımlar
Do not include a title line.`;
}

function reportUserText({ job, checks, smoke, finalReview }) {
  const m = job.plan.maintenance;
  const maint = m
    ? `Job type: ${MAINTENANCE_TITLE[m.kind] || 'CHANGE'} on an existing, accepted product — write the report about THIS change (what was added / what was wrong / what was restructured, root causes or design decisions, what was changed, how it was verified, what the user should try or re-test), not about the whole product.\nAnalysis: ${m.summary || ''}\nFindings:\n${(m.findings || []).map((f) => `- [${f.type}/${f.severity}] ${f.title}: ${f.detail} (${(f.files || []).join(', ')})`).join('\n') || '(none)'}\n`
    : '';
  return `${maint}Request: ${job.idea || '(from attached documents)'}
Project folder: ${job.projectDir}
Plan summary: ${job.plan.summary}
Stack: ${job.plan.stack.join(', ')}
Features: ${job.plan.features.join('; ')}
Assumptions: ${(job.plan.assumptions || []).join('; ')}
Tasks:
${job.tasks.map((t) => `- [${t.status}] ${t.title}${t.review ? ` (quality ${t.review.qualityScore ?? '-'}/10: ${t.review.summary})` : ''}${t.agentSummary ? `\n  Agent summary: ${t.agentSummary.slice(0, 1200)}` : ''}`).join('\n')}
Verification: ${(checks || []).map((c) => `${c.name}: ${c.env ? 'skipped (environment)' : c.ok ? 'OK' : 'FAILED'}`).join(', ') || 'not run'}
Browser test: ${smoke?.pages ? smoke.pages.map((p) => `${p.route} ${p.viewport} HTTP ${p.status ?? '?'} errors ${p.errors.length}`).join('; ') : smoke?.error || smoke?.skipped || 'not run'}
Final review: ${finalReview ? `${finalReview.verdict}, quality ${finalReview.qualityScore ?? '-'}/10 — ${finalReview.summary}; open issues: ${(finalReview.issues || []).join('; ') || 'none'}` : 'n/a'}
Requirement coverage: ${reqStatusText(job)}
Security findings (manager audit, last run): ${(finalReview?.security || []).map((f) => `[${f.severity}] ${f.title}`).join('; ') || 'none'}
Specialist review panel (security / business rules / architecture — findings verified in the code; blocking ones went to fix rounds, so list them as found-and-fixed unless they are still among the open issues):
${panelReportText(job, finalReview)}
Phase gates: ${Object.entries(job.gates || {}).map(([k, g]) => `${k}: ${g.status}${g.review?.qualityScore ? ` (${g.review.qualityScore}/10)` : ''}`).join('; ') || 'n/a'}
${ledgerReportText(job)}`;
}

// Bulgu defteri: doğrulanmış her kusurun akıbeti. Açık ya da doğrulanamayan kayıt varsa rapor bunu açıkça söyler.
function ledgerReportText(job) {
  const l = job.findings || [];
  if (!l.length) return 'Findings ledger: no verified defect was recorded.';
  const by = (st) => l.filter((f) => f.status === st);
  const row = (f) => `- ${f.id} [${f.severity}/${f.area || 'review'}] ${f.title}${f.file ? ` (${f.file})` : ''} — found at ${f.label || f.at}${f.note ? ` — verifier: ${f.note}` : ''}`;
  return `Findings ledger (every verified defect is tracked until an independent verifier confirms the fix in the code): ${by('fixed').length} fixed and re-verified, ${by('open').length} still OPEN, ${by('uncertain').length} could not be verified.
${by('open').length ? `STILL OPEN — list these under known issues, they are real defects in the delivered code:\n${by('open').map(row).join('\n')}` : 'No verified defect is open.'}
${by('uncertain').length ? `Could not be verified (list them as "to check by hand"):\n${by('uncertain').slice(0, 15).map(row).join('\n')}` : ''}${(job.lessons || []).length ? `\nEngineering rules the project learned from its defects (mention the 3 most important under architecture/decisions):\n${job.lessons.slice(0, 15).map((x) => `- ${x}`).join('\n')}` : ''}`;
}

// Rapora girecek uzman bulguları: görev sonu, faz kapısı ve son kabul panellerinin doğruladıkları.
function panelReportText(job, finalReview) {
  const rows = [];
  const add = (where, panel) => {
    for (const f of panel?.confirmed || []) rows.push(`- ${where}: [${f.severity}/${f.area || 'review'}] ${f.title}${f.file ? ` (${f.file})` : ''}`);
  };
  for (const t of job.tasks || []) add(`task "${t.title}"`, t.review?.panel);
  for (const [name, g] of Object.entries(job.gates || {})) add(`phase gate "${name}"`, g.review?.panel);
  add('final acceptance', finalReview?.panel);
  return rows.slice(0, 40).join('\n') || '- no verified findings';
}

module.exports = {
  reportSystem,
  reportUserText,
  ledgerReportText,
};
