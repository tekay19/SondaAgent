// Uzman denetim paneli: uzman tanımları, görev sonu incelemesi, bulgu doğrulama ve yeniden doğrulama.
const { REVIEWER_RULES } = require('./base');
const { maintenanceReviewText, designReviewText, lessonsText, openIssuesText } = require('./context');

// ---------- Uzman denetim paneli ----------
// Genel derin inceleme kabul kriterlerini doğrular; panel ise genel incelemenin kaçırdığı hata sınıflarını avlar.
const SPECIALISTS = {
  security: {
    label: 'Güvenlik ve yapılandırma',
    role: 'application security engineer',
    focus: `SECURITY & CONFIGURATION.
- Authentication and authorization on EVERY entry point (pages, API routes, server actions, webhooks, background triggers): which paths are excluded from auth and whether that exclusion is safe; object-level authorization (IDOR).
- CSRF protection for state-changing requests; webhook signature verification; replay protection where relevant.
- Security headers (frame-ancestors / X-Frame-Options, X-Content-Type-Options, Referrer-Policy, HSTS where applicable) and framework fingerprinting headers.
- Secrets: never hardcoded, logged, returned to the client or bundled into client code.
- Environment validation: what happens when a variable is missing or invalid, and whether development switches (auth disabled, signature validation disabled, placeholder/example passwords or tokens) are REJECTED in production.
- Input validation, output encoding, injection (SQL/NoSQL/command/template), file uploads, open redirects, SSRF.
- Error responses and logs leaking internals or configuration details to unauthenticated callers.
Judge against the security baseline for THIS product's exposure (threat model and [SEC] requirements): level (a) — validation, injection safety, secrets, safe errors, dependency vulnerabilities — always applies; level (b) — authentication/authorization, sessions, CSRF, rate limiting, security headers, uploads — applies where the product has accounts, sessions, non-public data or state-changing public endpoints. Do not report missing hardening that this product's exposure does not call for.`,
  },
  logic: {
    label: 'İş kuralları ve veri bütünlüğü',
    role: 'backend engineer specialised in correctness, concurrency and data integrity',
    focus: `BUSINESS RULES & DATA INTEGRITY. Take every business rule and invariant in docs/sonda/SPEC.md and docs/sonda/REQUEST.md — limits and quotas, "never do X", retry rules, state transitions, uniqueness, ordering, time windows — and prove from the code that it ALWAYS holds, including under concurrency and failures. Hunt specifically for:
- check-then-act races: a count or read followed by a separate insert/update without a lock, transaction or database constraint (two concurrent requests both pass the check);
- non-atomic counters and limits; missing transactions around multi-row changes; partial updates left behind when a step fails or the process crashes;
- idempotency of retried, duplicated or out-of-order events (webhooks, queues, timers) and callbacks that can arrive before the data they refer to exists;
- state machines that allow illegal transitions or miss legal ones; cleanup / timeout / reaper jobs that also hit records in healthy long-running states;
- retry or re-queue logic that retries cases the spec says must never be retried (or skips cases it must retry);
- FAILURE PATHS: for each external call, database write and file operation — what happens when it fails or times out, when the process stops between two writes, or after a restart? Records left "in progress" forever, terminal states that can be overwritten by a late writer, error handlers that can themselves fail and skip the cleanup, fallbacks that are never reached, missing timeouts;
- time-zone, date-boundary and calling/business-hours rules; rounding and money arithmetic;
- schema constraints and indexes that do not match the queries or do not enforce the invariants.
For every problem give the exact sequence of events that breaks the rule.`,
  },
  quality: {
    label: 'Mimari, testler ve çalıştırılabilirlik',
    role: 'staff engineer reviewing architecture, tests and operability',
    focus: `ARCHITECTURE, TESTS & OPERABILITY.
- Layering and dependency direction (domain/core must not depend on infrastructure or the framework); are boundaries enforced by tooling or only by convention?
- Lifecycle issues: singletons, database client lifecycle, hot reload, resources that are never closed.
- Test REALISM: are the real integrations (database queries, transactions, locking, external adapters, webhooks) exercised by any test, or only in-memory fakes that behave differently from production? Do tests assert real behaviour rather than mocks? Are the riskiest paths (concurrency, failure handling) tested at all? If coverage thresholds are configured: are they real (business logic included, not excluded or lowered to pass)?
- Fresh clone: can a new developer install, generate code (ORM clients etc.), type-check, test and build with the documented steps? Check postinstall/generate hooks, .env.example completeness, README accuracy, scripts.
- Dead code, duplication, over-engineering or premature abstractions for the scope; UI accessibility basics (labels, ids, keyboard, focus).`,
  },
};

const SPECIALIST_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          title: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'integer' },
          problem: { type: 'string' },
          scenario: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['severity', 'title', 'file', 'problem', 'scenario', 'fix'],
      },
    },
    strengths: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'findings'],
};

function specialistPrompt({ job, key, scope, lang, depAudit }) {
  const sp = SPECIALISTS[key];
  const deps = key === 'security' && depAudit ? `\n# Dependency audit (production dependencies, already run)\n${depAudit.summary}${depAudit.highCritical?.length ? `\nHigh/critical: ${depAudit.highCritical.join(', ')}` : ''}\n` : '';
  const reqs = specialistRequirements(job, key).map((r) => `- ${r.id}: ${r.text}`).join('\n');
  const tm = key === 'security' && (job.plan.threatModel || []).length ? `\n# Threat model of this product\n${job.plan.threatModel.map((t) => `- ${t}`).join('\n')}\n` : '';
  return `You are a senior ${sp.role} on an independent review panel of three specialists (security; business rules & data integrity; architecture, tests & operability). Autonomous coding agents built ${scope} of the project below, and a general reviewer has already checked the acceptance criteria. Your ONLY job is your specialty: find the real defects that a general review misses. You did NOT write this code — be skeptical and evidence-driven.

You are in the project folder in READ-ONLY mode. Prefer the Read, Grep and Glob tools; each Bash call must be one plain command (no loops, cd chains, pipes or redirections). Do not install packages, start servers or run builds. Time budget: about 10 minutes — go deep on the riskiest code rather than skimming everything. ${REVIEWER_RULES}

# Your specialty
${sp.focus}

# Method
1. Read docs/sonda/SPEC.md and docs/sonda/REQUEST.md for the rules relevant to your specialty, then read the relevant source files completely — including code written in earlier phases that this part builds on, and code that is not wired to a route yet (latent bugs count).
2. Report only real, evidenced defects. Every finding needs: file and line, the problem, a concrete failure scenario (the inputs or sequence of events that produce the wrong outcome) and a specific fix. Libraries may be newer than your training data: check node_modules or the installed docs before claiming an API is missing or behaves differently — never guess.
3. Severity: critical/high = violates a spec rule or invariant, loses or corrupts data, is a security hole, or breaks normal use; medium = real bug in a less common path, missing hardening, or a setup/test gap that will bite; low = minor. No style nits; report one finding per root cause.
4. List up to 5 strengths (short).
Your FINAL action must be calling the StructuredOutput tool with the result. "summary", titles and strengths in ${lang || 'the language of the user request'}; problem, scenario and fix in English.

# Project
${job.plan.summary}
Stack: ${job.plan.stack.join(', ')}

# Requirements (reference${key === 'security' ? '; security ones first' : ''})
${reqs || '(none)'}
${tm}
# Additional user instructions (treat as requirements)
${(job.userNotes || []).map((n) => `- ${n}`).join('\n') || '(none)'}
${key === 'quality' ? designReviewText(job) : ''}${maintenanceReviewText(job)}${deps}${openIssuesText(job, null)}`;
}

// Uzmanın göreceği gereksinimler: güvenlik uzmanı için [SEC] olanlar önce (listenin sonunda kalıp kesilmesinler);
// diğerleri için iş kuralları önce. Çok büyük listelerde toplam uzunluk sınırlanır.
function specialistRequirements(job, key) {
  const all = job.plan.requirements || [];
  const isSec = (r) => /^\s*\[SEC\]/i.test(r.text);
  const ordered = key === 'security' ? [...all.filter(isSec), ...all.filter((r) => !isSec(r))] : [...all.filter((r) => !isSec(r)), ...all.filter(isSec)];
  const out = [];
  let used = 0;
  for (const r of ordered) {
    used += String(r.text).length + 8;
    if (used > 24000) break;
    out.push(r);
  }
  return out;
}

// Görev sonu uzman incelemesi: yalnızca bu görevin değiştirdiği dosyalar + dokunduğu yüzeyler.
// Faz panelinden daha dar ve kısa; amaç hatayı fazın sonunda değil, yazıldığı görevde yakalamak.
// Her uzmanın görev sonu yöntemi ve önem ölçütü (faz panelindeki odak metni aynen kullanılır).
const TASK_REVIEW = {
  security: {
    method: `1. For every new or changed entry point (page, route, server action, webhook, job): who can reach it, what it trusts, what it must reject. Check the negative cases actually exist in code (unauthenticated → rejected, other user's record → rejected, invalid input → rejected).
2. Verify every [SEC] requirement this task claims to cover, and check that the task did not violate any other.`,
    severity: 'critical/high = exploitable, violates a [SEC] requirement or the spec, or lets one user reach another\'s data or a privileged action; medium = real weakness in a less exposed path or missing hardening the spec requires; low = minor',
  },
  logic: {
    method: `1. List the business rules and invariants this task implements or touches (from the requirements below, docs/sonda/SPEC.md and the acceptance criteria) and prove from the changed code that each ALWAYS holds — under concurrent requests, retries, partial failures, time boundaries and unexpected ordering.
2. Walk every failure path of the changed code: each external call or write failing or timing out, the process stopping between two writes, the same event arriving twice or late, a restart in the middle. What state is left behind — can a record stay "in progress" forever, can a terminal state be overwritten, does the user see the failure? Check the same pattern in sibling code paths, not only the line you started from.
3. Give the exact sequence of events (or inputs) that breaks a rule; a rule that holds only on the happy path is a finding.`,
    severity: 'critical/high = a required rule can be violated, data can be lost, duplicated or corrupted, or normal use breaks; medium = real bug in a less common path or a missing guard the spec implies; low = minor',
  },
  quality: {
    method: `1. Check that the change fits the codebase: layering and dependency direction, reuse of existing modules instead of duplicates (see docs/sonda/MEMORY.md), resources and lifecycles handled.
2. Check test realism for the changed code: do the tests exercise the real logic and its failure paths, or only mocks and the happy path? Would a fresh clone still install, type-check, test and build with the documented steps?`,
    severity: 'critical/high = the change breaks the build, a fresh clone or an existing contract, or its tests would pass with the feature broken; medium = real maintainability or test gap that will bite; low = minor',
  },
};

function taskSpecialistPrompt({ job, task, key, changedFiles, lang }) {
  const sp = SPECIALISTS[key];
  const how = TASK_REVIEW[key];
  const all = job.plan.requirements || [];
  const covered = new Set(task.covers || []);
  const secReqs = all.filter((r) => /^\s*\[SEC\]/i.test(r.text));
  const tm = (job.plan.threatModel || []).map((t) => `- ${t}`).join('\n');
  const reqBlock = key === 'security'
    ? `${tm ? `# Threat model of this product\n${tm}\n\n` : ''}# Security requirements ([SEC]) — ${secReqs.length ? 'verify every one this task claims to cover, and check that this task did not violate any other' : 'none defined; apply the security baseline for this product\'s exposure'}
${secReqs.map((r) => `- ${r.id}${covered.has(r.id) ? ' [claimed by this task]' : ''}: ${r.text}`).join('\n') || '(none)'}`
    : `# Requirements this task must satisfy
${all.filter((r) => covered.has(r.id)).map((r) => `- ${r.id}: ${r.text}`).join('\n') || '(none listed — use the acceptance criteria and docs/sonda/SPEC.md)'}`;
  return `You are a senior ${sp.role} doing a focused post-task review inside an automated build pipeline (Sonda). A coding agent just finished ONE task; a general reviewer checks its acceptance criteria separately. Your ONLY job is your specialty, applied to what this task changed and the surfaces it touches. You did NOT write this code — be skeptical; read the code, do not trust summaries.

You are in the project folder in READ-ONLY mode. Prefer Read, Grep and Glob; each Bash call must be one plain command (no loops, cd chains, pipes or redirections). Do not install packages, start servers or run builds. Time budget: about 4 minutes — read the changed files completely, then only what they call into. ${REVIEWER_RULES}

# Your specialty
${sp.focus}

# Task just completed
${task.title}
Goal: ${task.goal}
Acceptance criteria:
${(task.acceptance || []).map((a) => `- ${a}`).join('\n')}

# Files changed by this task
${(changedFiles || []).map((f) => `- ${f}`).join('\n') || '(unknown — inspect git status)'}
${lessonsText(job, '# Project rules distilled from defects verified earlier (a violation of one of these in the changed code is a finding)')}
${reqBlock}

# Method
${how.method}
3. Report only real, evidenced defects with file and line, the problem, a concrete failure scenario and a specific fix. Libraries may be newer than your training data: check node_modules before claiming an API is missing.
4. Severity: ${how.severity}. One finding per root cause, no style nits.
5. Also list up to 3 strengths (short).
Your FINAL action must be calling the StructuredOutput tool with the result. "summary", titles and strengths in ${lang || 'the language of the user request'}; problem, scenario and fix in English.

# Additional user instructions (treat as requirements)
${(job.userNotes || []).map((n) => `- ${n}`).join('\n') || '(none)'}
${key === 'quality' ? designReviewText(job) : ''}${maintenanceReviewText(job)}`;
}

// Düzeltme turundan sonra: daha önce doğrulanmış bulgular GÜNCEL kodda yeniden kontrol edilir.
const FINDING_RECHECK_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          verdict: { type: 'string', enum: ['fixed', 'still_present', 'uncertain'] },
          reason: { type: 'string' },
        },
        required: ['id', 'verdict', 'reason'],
      },
    },
  },
  required: ['results'],
};

function findingRecheckPrompt({ items, lang }) {
  return `You are an independent senior engineer acting as the VERIFIER of a code review panel. The defects below were verified in this project earlier and engineers were asked to fix them. Check each one again in the CURRENT code of the project folder: read the cited location and whatever it depends on, follow the failure scenario step by step, and look for the test that now covers it. The excerpts show the current code around the cited lines; read more wherever needed — code may have moved.

You are in READ-ONLY mode. Prefer the Read, Grep and Glob tools; each Bash call must be one plain command (no loops, cd chains, pipes or redirections). Time budget: about 6 minutes. ${REVIEWER_RULES}

For every finding decide:
- fixed: the root cause is gone — the failure scenario can no longer happen in the current code. A guard that only hides the symptom, a comment, a TODO or a test without a code change is NOT a fix;
- still_present: the scenario still happens, or the fix is partial (it covers one path but a sibling path or another variant of the same defect remains) — say exactly what is still wrong and where;
- uncertain: you cannot decide from the code.
Be strict in both directions: do not call something fixed that you did not verify, and do not keep a finding open when the code now clearly prevents it.
Your FINAL action must be calling the StructuredOutput tool with one result per finding id. "reason": one or two sentences in ${lang || 'the language of the user request'}; for still_present, state what remains to be done.

# Findings
${items
  .map(({ f, code }) => `## ${f.id} — ${f.area || 'review'} · ${f.severity} · ${f.title}
File: ${f.file || '?'}${f.line ? `:${f.line}` : ''}
Problem: ${f.problem}
Failure scenario: ${f.scenario}
Expected fix: ${f.fix}
Current code at that location:
\`\`\`
${code}
\`\`\``)
  .join('\n\n')}`;
}

const PANEL_VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          verdict: { type: 'string', enum: ['confirmed', 'rejected', 'uncertain'] },
          reason: { type: 'string' },
        },
        required: ['index', 'verdict', 'reason'],
      },
    },
  },
  required: ['results'],
};

// Bulgu doğrulayıcı: panelden bağımsız ikinci bir Claude oturumu her bulguyu kodda kontrol eder.
function panelVerifyPrompt({ items, lang, decisive = false }) {
  return `You are an independent senior engineer acting as the VERIFIER of a code review panel. ${decisive ? 'An earlier verification pass left the findings below UNDECIDED. Decide them now: read as much of the code as it takes (callers, callees, tests), and where a single quick command would settle it (one unit test file, the type-check), run it. "uncertain" is acceptable only when the answer truly depends on something outside the repository.' : 'The panel reported the findings below about this project.'} Before any engineer spends time on them, verify each one yourself by reading the cited code — and whatever it depends on — in the project folder. A short excerpt around the cited line is included to get you started; read more wherever needed.

You are in READ-ONLY mode. Prefer the Read, Grep and Glob tools; each Bash call must be one plain command (no loops, cd chains, pipes or redirections). Time budget: about 6 minutes. ${REVIEWER_RULES}

For every finding decide:
- confirmed: you verified in the code that the defect is real and the failure scenario follows from it (or the rule it cites in docs/sonda/SPEC.md / docs/sonda/REQUEST.md is really violated);
- rejected: the code contradicts the claim — it is already handled elsewhere, the location is wrong, an API is misread, or no rule is actually violated;
- uncertain: you cannot decide from the code.
Be strict: confirm only what you verified yourself. Libraries may be newer than your training data — check node_modules before judging a claim about an API.${items.some(({ f }) => f.kind === 'readiness') ? '\nA READINESS finding claims that an upcoming task (not built yet) needs something the existing code cannot provide. Confirm it only when that task\'s part of docs/sonda/SPEC.md really requires it AND the current code cannot support it without rework or a workaround; reject it when the existing design already allows it or the need is speculative.' : ''}
Your FINAL action must be calling the StructuredOutput tool with one result per finding index. "reason": one short sentence in ${lang || 'the language of the user request'}.

# Findings
${items
  .map(({ i, f, code }) => `## Finding #${i} — ${f.area} · ${f.severity} · ${f.title}
File: ${f.file || '?'}${f.line ? `:${f.line}` : ''}${f.kind ? `\nKind: ${f.kind}${f.before ? ` · first upcoming task that depends on it: ${f.before}` : ''}` : ''}
Problem: ${f.problem}
Failure scenario: ${f.scenario}
Proposed fix: ${f.fix}
Excerpt:
\`\`\`
${code}
\`\`\``)
  .join('\n\n')}`;
}

module.exports = {
  SPECIALISTS,
  SPECIALIST_SCHEMA,
  specialistPrompt,
  taskSpecialistPrompt,
  FINDING_RECHECK_SCHEMA,
  findingRecheckPrompt,
  PANEL_VERIFY_SCHEMA,
  panelVerifyPrompt,
};
