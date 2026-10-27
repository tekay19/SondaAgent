// Ajanlara ve inceleyicilere verilen proje bağlamı: .env, tasarım, hafıza, gereksinimler, dersler, açık bulgular.
const fs = require('fs');
const path = require('path');
const { DESIGN_CRAFT, MAINTENANCE_TITLE } = require('./base');

// Tasarım dosyaları (docs/sonda/design) — planlayıcı, kodlayan ajan ve inceleyiciler için ortak metin.
function designFilesText(job) {
  const refs = job?.designRefs || [];
  if (!refs.length) return '';
  const pages = job.designPages || [];
  const previews = job.designPreviews || [];
  const shown = refs.slice(0, 60);
  return `\n# Design files (binding for the UI) — in docs/sonda/design/
${shown.map((r) => `- ${r}`).join('\n')}${refs.length > shown.length ? `\n- … (+${refs.length - shown.length} more)` : ''}
${pages.length ? `Pages: ${pages.join(', ')}. ` : ''}${previews.length ? `Rendered previews (open them with the Read tool to SEE the design): ${previews.join(', ')}. ` : ''}These files define how the product must look: same structure and sections, typography, colors, spacing, imagery and responsive behavior, ported into the project's stack (components, styling system, assets copied into the project). On visuals the design wins over the spec; on behavior and data the spec wins. Screens the design does not cover are built in the same visual language (derived design tokens and components) — a missing design for a screen is never an error.
`;
}

// ---------- Ajan istemleri ----------
function planOverview(job, current) {
  let phase = null;
  return job.tasks
    .map((t, i) => {
      const mark = t.id === current?.id ? '▶' : t.status === 'done' ? '✓' : t.status === 'failed' ? '✕' : t.status === 'skipped' ? '–' : ' ';
      const head = t.phase && t.phase !== phase ? `[${(phase = t.phase)}]\n` : '';
      return `${head}${mark} ${i + 1}. ${t.title}`;
    })
    .join('\n');
}

// Kodlayan ajan için bakım kuralları (contextBlock içinde).
function maintenanceBlock(job) {
  const m = job.plan && job.plan.maintenance;
  if (!m) return '';
  const head = `\n\n## Maintenance job: ${MAINTENANCE_TITLE[m.kind] || 'CHANGE'} on a product that already works\nUser's request (verbatim): ${m.request || '(code-health pass, no specific focus)'}\nAnalysis: ${m.summary || ''}`;
  if (m.kind === 'feature') {
    return `${head}\nRules:\n- Fit in: before writing, read the neighbouring code and follow it — same folder structure and naming, same layering, same validation/error/response patterns, same design tokens and shared UI components, same language and tone for UI text, same test layout and helpers. Reuse existing modules and helpers; never write a parallel version of something that exists (check docs/sonda/MEMORY.md).\n- Existing behavior is accepted and must not change: existing routes, API shapes, screens and texts keep working; every existing test stays green and unmodified. Data model changes go through a NEW migration, never by editing old ones.\n- Stay inside the task: no restructuring or restyling of existing code, no dependency upgrades, no new dependency unless the task names it. Update README and .env.example when the feature adds setup steps or variables.`;
  }
  const bug = `- Bug-fix tasks: reproduce first — write the regression test, run it and SEE IT FAIL for the reported reason; then fix the root cause (not the symptom) with the smallest change that does it. The regression test and the whole suite must pass.`;
  const ref = `- Refactor tasks are behavior-preserving: keep every observable behavior identical — routes, API request/response shapes, DB schema and migrations, UI text, env variables. Existing tests must stay green WITHOUT changing their assertions (imports and paths may change). Where the code you touch has thin coverage, first add characterization tests that pin the current behavior, then refactor in small steps and run the tests between steps.`;
  return `${head}\nRules:\n${m.kind === 'bugfix' ? bug : `${ref}\n${bug}`}\n- Stay inside the task: no new features, no dependency upgrades, no drive-by rewrites. Never weaken, skip or delete an existing test to make the suite pass.`;
}

// İnceleyiciler (yönetici ve Claude) için bakım ölçütleri.
function maintenanceReviewText(job) {
  const m = job.plan && job.plan.maintenance;
  if (!m) return '';
  const crit = m.kind === 'feature'
    ? 'Verify the feature FITS the codebase: it reuses existing modules, components, helpers and patterns instead of duplicating them; new files follow the existing structure and naming; UI uses the existing design tokens and shared components; existing routes, contracts, screens and texts are unchanged; existing tests were not modified, weakened or deleted; data model changes are a new migration; every new requirement the task covers is met and tested, including the rejected cases.'
    : m.kind === 'bugfix'
    ? 'Verify: the ROOT CAUSE is fixed (not only the symptom); a regression test exists that would fail without the fix; no behavior outside the report changed; no existing test was weakened, skipped or deleted.'
    : 'Verify behavior preservation: routes, API shapes, DB schema, UI text and env variables are unchanged unless the task is a listed bug fix; existing test assertions were not weakened, skipped or deleted; the change really improves structure (it is not churn). For bug-fix tasks: root cause fixed and covered by a regression test.';
  return `\n# Maintenance job: ${MAINTENANCE_TITLE[m.kind] || 'CHANGE'} on a product that already works\nUser's request: ${m.request || '(code-health pass)'}\nAnalysis: ${m.summary || ''}\n${crit} Anything else is blocking.\n`;
}

// Brif yazarı için bakım bağlamı: istek, analiz ve bulguları (kök neden, tasarım kararları) — brif bunlara dayanır.
function maintenanceBriefText(job) {
  const m = job.plan && job.plan.maintenance;
  if (!m) return '';
  const findings = (m.findings || []).slice(0, 15).map((f) => `- [${f.severity}] ${f.title}${(f.files || []).length ? ` (${f.files.slice(0, 4).join(', ')})` : ''}${f.detail ? `: ${String(f.detail).slice(0, 700)}` : ''}`).join('\n');
  const rule = m.kind === 'feature'
    ? 'The brief must make the feature FIT the codebase: name the existing modules, components, helpers and patterns to reuse (exact paths), the existing behavior and tests that must stay untouched, and the NEW migration if the data model changes.'
    : m.kind === 'bugfix'
    ? 'The brief must start from the ROOT CAUSE: where it is in the code, the regression test that fails before the fix (name and assertion), the smallest change that fixes it and the behavior that must not change.'
    : 'The brief must keep the change behavior-preserving: name the observable behavior that stays identical (routes, API shapes, schema, UI text, env variables), the characterization tests to add first where coverage is thin, and the order of the small steps. For bug-fix tasks: root cause and regression test first.';
  return `\n# Maintenance job: ${MAINTENANCE_TITLE[m.kind] || 'CHANGE'} on a product that already works\nUser's request (verbatim): ${m.request || '(code-health pass, no specific focus)'}\nAnalysis: ${m.summary || ''}\n${findings ? `Findings of the analysis (check them against the code; they are the reason this task exists):\n${findings}\n` : ''}${rule} Nothing outside the task.\n`;
}

// Kullanıcının .env'ye girdiği değişkenler: yalnızca adlar (değerler hiçbir isteme girmez).
function envBlock(env) {
  if (!env?.names?.length && !env?.missing?.length) return '';
  const lines = ['## Environment variables (.env)'];
  if (env.names?.length) {
    const others = (env.present || []).filter((n) => !env.names.includes(n));
    lines.push(`The user supplied real values for: ${env.names.join(', ')}. Sonda writes them into \`.env\` (git-ignored) before every step, so they are available to the app at runtime. Read them only through the environment (process.env or the framework's env loader). Never hardcode, print, log or commit their values, never read them back into your answer, and never overwrite or delete these keys in \`.env\`. Keep \`.env.example\` listing every variable with placeholder values only. Integrations backed by these keys must work for real in the running app; unit tests must still mock external services. NEVER trigger real-world side effects with these credentials while building or testing (no real phone calls, SMS, emails, payments, charges or messages to real people) — verify with mocks, sandbox/test modes or dry runs only; real usage is the user's decision.`);
    lines.push(`Because it holds the user's real secrets, \`.env\` (and \`.env.local\`) cannot be read or edited with your tools in this session — that is intentional, do not try to work around it.${others.length ? ` It currently also defines: ${others.join(', ')}.` : ''} To add a NON-secret setting, append it with one shell command (\`printf 'NAME=value\\n' >> .env\`) and document it in \`.env.example\`; never rewrite the file.`);
  }
  if (env.missing?.length) lines.push(`Variables in ${env.exampleFile || '.env.example'} that still have no value: ${env.missing.join(', ')}. Do not invent values; the app must fail with a clear message (or degrade gracefully) when they are missing, and tests must not depend on them.`);
  return `\n${lines.join('\n')}\n`;
}

// Yönetici incelemeleri için: hangi ayarlar ortamdan geliyor; koda gömülmüş gizli değer maskeli görünür.
function envReviewText(env) {
  if (!env?.names?.length) return '';
  return `\n# Environment variables supplied by the user via .env (values are secret and never shown)\n${env.names.join(', ')}\nIf a masked value like ‹gizli:NAME› appears inside source code or a diff, a secret was hardcoded — that is a blocking security issue.\n`;
}

function notesBlock(notes) {
  if (!notes?.length) return '';
  return `\n## Additional instructions from the user (highest priority — apply them now)\n${notes.map((n) => `- ${n}`).join('\n')}\n`;
}

function designBlock(job) {
  const refs = job.designRefs || [];
  const direction = String(job.plan?.designDirection || '').trim();
  if (!refs.length) {
    // Tasarım dosyası yok: planın tasarım yönü bağlayıcıdır; yoksa ve web arayüzü varsa ajan yönü kendi belirler.
    if (direction) return `\n\n## Design direction (binding — no design files were supplied, so this IS the design)\n${direction}\nImplement it through design tokens and shared components; every screen you build or touch follows it (fonts, palette, signature details, component style, all states). ${DESIGN_CRAFT}`;
    if ((job.plan?.verify?.routes || []).length) return `\n\n## Visual design\nNo design was supplied. Before building the first screen, define a design direction for this product (concept, named fonts, palette with hex values, layout principles, signature details, component style) in docs/sonda/DESIGN.md and implement it through design tokens and shared components; later tasks must follow that file. ${DESIGN_CRAFT}`;
    return '';
  }
  const previews = job.designPreviews || [];
  const pages = job.designPages || [];
  const derived = direction ? `\nDesign system derived from it (from the plan — use it for screens the design does not cover):\n${direction}` : '';
  return `\n\n## Design (binding — the user supplied the visual design)
Files: docs/sonda/design/ (${refs.length} files${pages.length ? `; pages: ${pages.join(', ')}` : ''}).${previews.length ? ` Previews of how they render: ${previews.join(', ')} — open them with the Read tool to see the target look.` : ''}
Reproduce this design faithfully in the project's stack: same page structure and sections, texts, typography, colors, spacing, imagery and responsive behavior. Port its CSS into the project's styling system as design tokens and components (do not paste the raw page as-is unless the stack is plain HTML); copy the assets it needs (images, fonts, icons) into the project's public/static folder; keep the original files in docs/sonda/design untouched. Where the design and the specification conflict on visuals, the design wins; on behavior and data, the specification wins. Screens this design does not cover (e.g., an admin panel when only the landing page was supplied) are built with the same design tokens and components derived from it — consistent and professional, never a different visual system, never skipped or left as a placeholder. Note any part of the design you could not reproduce in your summary.${derived}`;
}

// İncelemeler için: tasarım dosyaları varsa görünüm sadakati, yoksa tasarım yönü ve tasarım ustalığı kabul ölçütüdür.
function designReviewText(job) {
  const refs = job?.designRefs || [];
  const direction = String(job?.plan?.designDirection || '').trim();
  const craft = `\n# Visual design craft\n${direction ? `The plan's design direction (binding for every screen):\n${direction}\n` : ''}Judge the UI as an art director would: does it implement the design direction (fonts, palette, signature details, component style, all states) and look genuinely designed for this product? A generic "AI template" look — purple/blue gradients and glow blobs, glassmorphism everywhere, a centered hero with three identical icon cards, emoji as icons, a default font with flat hierarchy, lorem ipsum or placeholder boxes — is a finding (severity medium, area quality), as is a screen that ignores the design direction. Do not report taste-only nitpicks.\n`;
  if (!refs.length) return direction || (job?.plan?.verify?.routes || []).length ? craft : '';
  const previews = job.designPreviews || [];
  return `\n# Design fidelity (the user supplied the visual design in docs/sonda/design/)
The implemented UI must match the supplied design: page structure and sections, texts, typography, colors, spacing, imagery and responsive behavior.${previews.length ? ` Rendered previews of the design: ${previews.join(', ')} (open them with the Read tool and compare with the running app / screenshots).` : ''} A page that clearly deviates from the design, misses sections, or uses a different visual system is a blocking issue. Screens the supplied design does not cover are judged for consistency with its visual language (tokens, typography, components, spacing), not against a page that does not exist — the absence of a design for such a screen is not an issue.
`;
}

// Yöneticiye satır içi verilen tasarım önizlemeleri (planlama ve incelemelerde).
function designPreviewParts(job) {
  const parts = [];
  for (const rel of job?.designPreviews || []) {
    try {
      const file = path.join(job.projectDir, rel);
      if (fs.statSync(file).size > 6 * 1024 * 1024) continue;
      parts.push({ text: `\n===== DESIGN PREVIEW (how the supplied design renders): ${rel} =====` }, { inlineData: { mimeType: 'image/jpeg', data: fs.readFileSync(file).toString('base64') } });
    } catch {
      /* önizleme yok */
    }
  }
  return parts;
}

function contextBlock(job) {
  const p = job.plan;
  const refs = job.docRefs?.length ? `\nOriginal reference documents (read the relevant ones): ${job.docRefs.join(', ')}` : '';
  return `## Project
${p.summary}
Stack: ${p.stack.join(', ')}
Product UI language: ${p.language || 'match the user request'}
Original user request (verbatim, the source of truth for what to build — it wins over the plan and the spec; instructions the user added during the build refine it and win where they conflict): docs/sonda/REQUEST.md
Full technical specification: ${job.specPath || 'docs/sonda/SPEC.md'} — read the parts relevant to your task before you start.
Build log of earlier tasks: docs/sonda/PROGRESS.md${refs}${envBlock(job.env)}${designBlock(job)}${maintenanceBlock(job)}`;
}

// Ajanın "unutmaması" için: mimari hafıza + devreden notlar + güncel dosya ağacı.
function memoryBlock(job, fileTree) {
  const parts = [];
  if (job.memory) parts.push(`## Project memory (what already exists — reuse it, stay consistent with it, never duplicate or break it)\n${job.memory}`);
  if (job.carryOver?.length) parts.push(`## Carry-over notes from earlier tasks (must be respected)\n${job.carryOver.map((c) => `- ${c}`).join('\n')}`);
  const lessons = lessonsText(job, '## Lessons of this project (rules distilled from defects reviewers verified here — follow each one)').trim();
  if (lessons) parts.push(lessons);
  const open = openFindingsText(job, '## Verified defects still open (found by the review panel, re-checked in the current code). If your work touches these files or the same mechanism, fix them properly and add a test; never repeat the pattern').trim();
  if (open) parts.push(open);
  if (fileTree) parts.push(`## Current file tree\n\`\`\`\n${fileTree}\n\`\`\``);
  return parts.length ? `\n${parts.join('\n\n')}\n` : '';
}

function requirementsFor(job, task) {
  const ids = new Set(task.covers || []);
  const reqs = (job.plan.requirements || []).filter((r) => ids.has(r.id));
  return reqs.length ? `\nRequirements this task must satisfy:\n${reqs.map((r) => `- ${r.id}: ${r.text}`).join('\n')}` : '';
}

function checksBlock(checks) {
  const failed = (checks || []).filter((c) => !c.ok && !c.env);
  if (!failed.length) return '';
  return `\n## Failing verification commands (output tail)\n${failed.map((c) => `### \`${c.cmd}\`${c.expectFail ? ' (must exit non-zero)' : ''} → ${c.timedOut ? 'timeout' : c.expectFail && c.code === 0 ? 'exited 0 but must fail' : `exit ${c.code}`}${c.note ? `\n${c.note}` : ''}\n\`\`\`\n${c.output.slice(-3500)}\n\`\`\``).join('\n\n')}
Never change correct behavior just to make a check pass: if a failing command deliberately exercises an error case and the product's behavior is right (a non-zero exit is the correct outcome), leave the behavior as it is and state this clearly in your summary.`;
}

// Bağımsız plan eleştirisinin yüksek/orta bulguları brife doğrudan girer: plan düzeltmesinde
// özetlenip kaybolsalar bile ilgili görevde ele alınırlar.
function critiqueBlock(job) {
  const f = (job.planCritique?.findings || []).filter((x) => x.severity !== 'low');
  if (!f.length) return '';
  return `\n# Findings of the independent plan review (verify each one that is relevant to THIS task is handled in the brief — correct versions/APIs, pitfalls, missing rules)\n${f.map((x) => `- [${x.severity}/${x.area}] ${x.problem} → ${x.recommendation}`).join('\n')}\n`;
}

function reqStatusText(job) {
  const st = job.reqStatus || {};
  const reqs = job.plan.requirements || [];
  const not = reqs.filter((r) => st[r.id] !== 'met');
  return `${reqs.length - not.length}/${reqs.length} requirements confirmed as met so far.
Not yet confirmed (${not.length}):
${not.map((r) => `- ${r.id}${st[r.id] === 'partial' ? ' [partial]' : ''}: ${r.text}`).join('\n') || '(none)'}`;
}

// Tarayıcı testinin nesnel sayfa bulguları: taşma, kırık görsel / istek / iç bağlantı, temel erişilebilirlik.
function smokeProblemsText(smoke) {
  const p = smoke?.problems || [];
  if (!p.length) return '';
  return `\nPage probes (objective findings of the browser test — "error" items are defects to fix, "warn" items are to be judged):\n${p.slice(0, 40).map((x) => `- [${x.level}] ${x.route}${x.viewport ? ` (${x.viewport})` : ''}: ${x.text}`).join('\n')}`;
}

// Yöneticinin önceki incelemelerde kaçırdığı, uzmanların doğruladığı kusurlar: aynı sınıf hatayı aramasını sağlar.
function calibrationText(job) {
  const seen = (job.findings || []).filter((f) => f.area !== 'manager' && f.severity !== 'low').slice(-10);
  if (!seen.length) return '';
  return `\n# Defects that independent specialists verified in EARLIER changes of this project (the first-pass review had not reported them) — look for the same classes of defect in this change\n${seen.map((f) => `- [${f.severity}/${f.area || 'review'}] ${f.title}${f.file ? ` (${f.file})` : ''}`).join('\n')}\n`;
}

// Projeye özgü dersler: doğrulanmış kusurlardan damıtılan kurallar (hafıza adımı günceller).
function lessonsText(job, heading) {
  const l = (job.lessons || []).filter(Boolean);
  if (!l.length) return '';
  return `\n${heading}\n${l.map((x) => `- ${x}`).join('\n')}\n`;
}

// Bulgu defterindeki açık kayıtlar (doğrulanmış, henüz düzeltilmemiş kusurlar).
function openFindingsText(job, heading) {
  const open = (job.findings || []).filter((f) => f.status === 'open');
  if (!open.length) return '';
  return `\n${heading}\n${open.slice(0, 20).map((f) => `- ${f.id} [${f.severity}] ${f.title} (${f.file || '?'}${f.line ? `:${f.line}` : ''}): ${f.problem}${f.fix ? ` Fix: ${f.fix}` : ''}`).join('\n')}\n`;
}

// Geçemeyen görevlerin açık sorunları: son kabulde zorunlu düzeltme listesi.
function openIssuesText(job, phase) {
  const open = job.tasks.filter((t) => t.status === 'failed' && (!phase || t.phase === phase) && t.review?.issues?.length);
  if (!open.length) return '';
  return `\n# Open issues of tasks that did not pass (must be resolved)\n${open.map((t) => `## ${t.title}\n${t.review.issues.map((i) => `- ${i}`).join('\n')}`).join('\n')}\n`;
}

module.exports = {
  designFilesText,
  planOverview,
  maintenanceBlock,
  maintenanceReviewText,
  maintenanceBriefText,
  envBlock,
  envReviewText,
  notesBlock,
  designBlock,
  designReviewText,
  designPreviewParts,
  contextBlock,
  memoryBlock,
  requirementsFor,
  checksBlock,
  critiqueBlock,
  reqStatusText,
  smokeProblemsText,
  calibrationText,
  lessonsText,
  openFindingsText,
  openIssuesText,
};
