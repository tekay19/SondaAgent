// Bağımsız denetim: görev incelemeleri her görevin farkını tek başına görür. Bu oturum bitmiş kodun TAMAMINI ve
// planın kalan görevlerini birlikte okur ve görev görev incelemenin kör noktasını arar: sonraki görevlerin dayanacağı
// temellerdeki eksikler, sessizce hiç çalışmayan testler, görev sınırlarına düşen kusurlar. Öneriler doğrulayıcıdan
// geçer; doğrulananları ayrı bir düzeltme oturumu uygular (bkz. orchestrator/audit.js).
const { REVIEWER_RULES, standardsBlock } = require('./base');
const { contextBlock, memoryBlock, notesBlock, lessonsText, planOverview, checksBlock } = require('./context');
const { WORK_RULES } = require('./task');

const AUDIT_KINDS = ['readiness', 'test-gap', 'defect'];

const AUDIT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: AUDIT_KINDS },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          title: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'integer' },
          problem: { type: 'string' },
          scenario: { type: 'string' },
          fix: { type: 'string' },
          before: { type: 'string' },
        },
        required: ['kind', 'severity', 'title', 'file', 'problem', 'scenario', 'fix'],
      },
    },
    strengths: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'suggestions'],
};

// Kalan görevler: denetçi her birinin mevcut koddan ne bekleyeceğini çıkarır. Uzun planlarda istem şişmesin diye
// ayrıntılar kısaltılır ve toplam uzunluk sınırlanır (en yakın görevler önce gelir; temel eksikleri en çok onları vurur).
function upcomingText(job, upcoming, max = 18000) {
  const out = [];
  let used = 0;
  for (const t of upcoming) {
    const block = `## ${t.id} — ${t.title}${t.phase ? ` (${t.phase})` : ''}
Goal: ${t.goal || '-'}
${t.details ? `Details: ${String(t.details).slice(0, 700)}\n` : ''}${(t.acceptance || []).length ? `Acceptance:\n${t.acceptance.slice(0, 6).map((a) => `- ${a}`).join('\n')}` : ''}`;
    used += block.length;
    if (used > max && out.length) {
      out.push(`(${upcoming.length - out.length} later tasks omitted — see the plan above and docs/sonda/SPEC.md)`);
      break;
    }
    out.push(block);
  }
  return out.join('\n\n');
}

// Denetçinin tekrar etmemesi gerekenler: defterdeki bulgular (her durumda) ve önceki denetimlerin önerileri.
function knownText(job) {
  const ledger = (job.findings || []).filter((f) => f.status !== 'rejected').slice(-40);
  const earlier = (job.audits || []).flatMap((a) => (a.suggestions || []).filter((x) => x.verdict !== 'rejected').map((x) => ({ ...x, at: `audit ${a.n}` }))).slice(-30);
  const lines = [
    ...ledger.map((f) => `- ${f.id} [${f.severity}, ${f.status}] ${f.title}${f.file ? ` (${f.file})` : ''}`),
    ...earlier.map((x) => `- ${x.at} [${x.severity}] ${x.title}${x.file ? ` (${x.file})` : ''}`),
  ];
  return lines.length ? lines.join('\n') : '(none)';
}

function auditPrompt({ job, upcoming, lang }) {
  const done = job.tasks.filter((t) => t.status === 'done' || t.status === 'failed');
  return `You are a principal engineer doing an INDEPENDENT AUDIT inside an automated build pipeline (Sonda). Autonomous coding agents have finished ${done.length} of the ${job.tasks.length} tasks of the project below. Every task was reviewed on its own: a general reviewer and specialists read THAT task's changes, and the defects they verified are listed under "Already known". Task-by-task review has a blind spot, and that blind spot is your whole job. You did NOT write this code — be skeptical and evidence-driven.

# What to look for
1. READINESS — shared foundations that UPCOMING tasks will build on: SDKs and plugin interfaces, base classes, context/config objects, data contracts and schemas, API clients, test harnesses and fixtures, contract-test kits. For each upcoming task below, work out what it will need from the existing code (read its part of docs/sonda/SPEC.md) and check that the existing code can really support it. A gap counts only when the current design would force rework of finished code, an awkward workaround, or a silent defect — e.g. an HTTP abstraction that only does GET while an upcoming task needs an OAuth POST with custom headers; a context object with no way to report something the spec requires; a plugin loader that one broken plugin can take down. Put the id of the FIRST upcoming task that hits it in "before".
2. TESTS THAT SILENTLY DO NOT RUN — test files or suites the project's test commands never collect (test paths, globs, markers, workspace filters), type-check or lint scopes that skip code that will be written, contract or fixture kits that accept broken implementations, coverage scopes that differ from what the spec asks for. Prove it from the configuration and the documented layout; if one quick test command settles the question, run it.
3. DEFECTS ACROSS TASK BOUNDARIES — problems in finished code that no single task's review owned: unsafe production defaults in configuration, two modules disagreeing on a contract, a rule of docs/sonda/SPEC.md that finished code relies on but nothing enforces.
Do NOT report: features of upcoming tasks that are simply not built yet (that is normal); style or naming; anything under "Already known"; a hypothetical problem without a concrete scenario. An empty list is a valid result when the foundations are sound.

# How to work
You are in the project folder in READ-ONLY mode. Prefer the Read, Grep and Glob tools; each Bash call must be one plain command (no loops, cd chains, pipes or redirections). Do not install packages, start servers or run builds. Time budget: about 15 minutes — first the SPEC sections of the next few upcoming tasks, then the shared modules they will use, then the test, type-check and coverage configuration. ${REVIEWER_RULES}

Every suggestion needs: the file and line in the CURRENT code; the problem; a concrete failure scenario (the input, the event sequence, or the upcoming task's concrete need → what breaks); and a specific, minimal fix that belongs in the existing foundation — never the upcoming feature itself. Libraries may be newer than your training data: check the installed packages before claiming an API is missing.
Severity: high = an upcoming task would be built on a broken or insufficient foundation, tests or checks that the pipeline relies on never run, or a security/data-integrity hole in finished code; medium = a real defect in a less common path or a gap that will force rework later; low = minor. At most 10 suggestions, most important first, one per root cause. Also list up to 5 strengths (short).
Your FINAL action must be calling the StructuredOutput tool with the result. "summary", titles and strengths in ${lang || 'the language of the user request'}; problem, scenario and fix in English.

# Project
${job.plan.summary}
Stack: ${(job.plan.stack || []).join(', ') || '(see docs/sonda/SPEC.md)'}
Specification: ${job.specPath || 'docs/sonda/SPEC.md'} · project memory: docs/sonda/MEMORY.md · build log: docs/sonda/PROGRESS.md

# Plan (✓ done · ✕ did not pass · blank = upcoming)
${planOverview(job, null)}

# Upcoming tasks (what they will need from the existing code)
${upcomingText(job, upcoming)}

# Already known (tracked elsewhere — do not repeat)
${knownText(job)}
${lessonsText(job, '# Project rules distilled from defects verified earlier')}
# Additional user instructions (treat as requirements)
${(job.userNotes || []).map((n) => `- ${n}`).join('\n') || '(none)'}`;
}

// Doğrulanmış önerileri uygulayan kodlama oturumu. `items`: defter kayıtları (F-numaralı) + bağlı oldukları görev.
function auditFixPrompt({ job, items, standards, fileTree }) {
  const byId = new Map(job.tasks.map((t) => [t.id, t]));
  return `You are a senior software engineer in an automated build pipeline (Sonda). An independent audit read the whole finished codebase together with the upcoming tasks of the plan, and an independent verifier confirmed each problem below in the code. They sit in code that earlier tasks finished: foundations the upcoming tasks will build on, tests that silently do not run, and defects across task boundaries. Fix them now, before the next task starts.

${contextBlock(job)}
${memoryBlock(job, fileTree)}${notesBlock(job.userNotes)}
## Verified audit findings — fix every one
${items
  .map((f) => {
    const t = f.before ? byId.get(f.before) : null;
    return `- ${f.id} [${f.severity}] ${f.title} (${f.file || '?'}${f.line ? `:${f.line}` : ''}): ${f.problem} Failure: ${f.scenario} Fix: ${f.fix}${t ? ` (Upcoming task that depends on it: ${t.id} — ${t.title})` : ''}`;
  })
  .join('\n')}

## Scope of this session
- Fix each root cause in the existing foundation and prove it with a test that fails without the fix. For tests that did not run: make the project's own test command collect them, and add a check that proves it.
- Do NOT implement the upcoming tasks themselves. Extend shared interfaces only as far as the findings require, keep every existing caller working, and prefer additive, backwards-compatible changes (defaults for new fields, new optional parameters).
- If, after reading the code, a finding turns out to be wrong, do not force a change: say why in your summary.
- Update docs/sonda/MEMORY.md only if a shared interface changed, so the next tasks build on the new shape.

${standardsBlock(standards)}

${WORK_RULES}`;
}

// Düzeltme oturumundan sonra kontroller kırıldıysa: aynı oturuma onarım isteği.
function auditRepairPrompt(checks) {
  return `The project checks fail after your audit fixes. Make them pass without weakening types, disabling lint rules or deleting tests; if a failure clearly existed before your changes, say so in your summary instead of chasing it.
${checksBlock(checks)}
End with a short summary of what you changed.`;
}

module.exports = { AUDIT_KINDS, AUDIT_SCHEMA, auditPrompt, auditFixPrompt, auditRepairPrompt };
