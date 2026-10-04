// Bakım işleri (özellik ekleme, hata düzeltme, refactor): salt okunur analiz ve plan istemi.
const { REVIEWER_RULES } = require('./base');

const MAINTENANCE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'diagnosis (bug fix) or code-health overview (refactor), in the user language' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['bug', 'refactor', 'design'] },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          title: { type: 'string' },
          detail: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
        },
        required: ['type', 'severity', 'title', 'detail', 'files'],
      },
    },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['bug', 'refactor', 'feature'] },
          title: { type: 'string' },
          goal: { type: 'string' },
          details: { type: 'string' },
          acceptance: { type: 'array', items: { type: 'string' } },
          tests: { type: 'array', items: { type: 'string' } },
          covers: { type: 'array', items: { type: 'string' }, description: 'ids of the NEW requirements this task implements (feature jobs)' },
        },
        required: ['type', 'title', 'goal', 'details', 'acceptance', 'tests'],
      },
    },
    routes: { type: 'array', items: { type: 'string' }, description: 'up to 6 URL paths worth opening in the browser test after the change' },
    requirements: {
      type: 'array',
      description: 'feature jobs only: NEW atomic, testable requirements the feature adds (security ones prefixed with [SEC])',
      items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'text'] },
    },
    specAddendum: { type: 'string', description: 'feature jobs only: Markdown section to append to the technical specification (data model, API, UI, flows, security of the feature)' },
    assumptions: { type: 'array', items: { type: 'string' }, description: 'feature jobs only: decisions you made where the request was silent' },
    threats: { type: 'array', items: { type: 'string' }, description: 'feature jobs only: new attack surface the feature adds' },
    project: {
      type: 'object',
      description: 'only when no Sonda plan exists for this project',
      properties: {
        name: { type: 'string' },
        summary: { type: 'string' },
        stack: { type: 'array', items: { type: 'string' } },
        language: { type: 'string' },
        overview: { type: 'string', description: 'Markdown: architecture, modules, data model, routes, conventions, commands' },
      },
    },
  },
  required: ['summary', 'findings', 'tasks'],
};

function maintenancePlanPrompt({ kind, text, plan, existing, feedback, previous, lang, refs }) {
  const known = plan
    ? `# Project
${plan.summary}
Stack: ${(plan.stack || []).join(', ')}
Product UI language: ${plan.language || 'match the user request'}
Specification: docs/sonda/SPEC.md · architecture memory: docs/sonda/MEMORY.md · build log: docs/sonda/PROGRESS.md

# Requirements (the accepted behavior — must keep holding)
${(plan.requirements || []).map((r) => `- ${r.id}: ${r.text}`).join('\n') || '(none recorded)'}`
    : `# Project
No Sonda plan exists for this folder. Inspect it first (README, package manifests, source tree) and also fill "project": name (kebab-case), summary, stack, language (of the product UI) and overview (Markdown: architecture, modules, data model, routes, conventions, how to install/test/build).${existing ? `\n\n${existing}` : ''}`;
  const common = `You are in the project folder in READ-ONLY mode. Prefer Read, Grep and Glob; each Bash call must be one plain command (no loops, cd chains, pipes or redirections). You may run the existing test suite, type-check and lint to gather evidence; you cannot install packages, start servers or change files. Libraries may be newer than your training data — check node_modules before judging an API. ${REVIEWER_RULES}`;
  const nextReq = Math.max(0, ...((plan && plan.requirements) || []).map((r) => Number(String(r.id).replace(/\D/g, '')) || 0)) + 1;
  const rules = kind === 'feature'
    ? `You are the principal engineer of an existing product that works and already passed acceptance. The user wants the feature below ADDED. Your job is to design it so that it looks like it was always part of this codebase.

${common}

Method:
1. Learn the house style before designing: read the specification/memory and the code that the feature will touch or sit next to — folder structure and naming, layering (where validation, business logic and data access live), the data model and migration style, API/route and error conventions, the design system (tokens, shared UI components, states, texts and their language), test layout and helpers.
2. Design the feature to FIT: reuse existing modules, components, helpers and patterns instead of writing parallel ones; put new files where similar ones live and name them the same way; extend the data model through a NEW migration (never edit old ones); keep existing routes, contracts and screens working unchanged. No restructuring or restyling of existing code, no new dependencies unless the feature cannot be built without them (say why).
3. Think like an attacker about the new surface (new inputs, routes, permissions, data) and design the defenses in.
4. If the request is really a different product or a rewrite, or it contradicts an existing requirement, say so in "summary" and plan the smallest change that gives the user what they asked for.
5. The request may list SEVERAL features (numbered): design each; share tasks where they overlap.
Output:
- "requirements": the NEW requirements the feature adds — atomic and testable, ids continuing from R${nextReq}; security ones prefixed with "[SEC]". Do not repeat existing requirements.
- "specAddendum": the Markdown section to append to the specification — data model changes, API/server contract, pages and UI (all states), flows and business rules, security — concrete enough that two engineers would build the same thing, written in the style of the existing specification.
- "assumptions": every decision you made where the request was silent. "threats": the new attack surface.
- "findings" (type "design"): the integration points and key design decisions — which existing modules are reused or extended and why; severity = risk of the change for existing behavior.
- "tasks" (type "feature"): 1–10 sequential vertical slices, each leaving the project building, tested and runnable. details: files/modules (existing ones to extend, new ones to add and where), data shapes, components, states, edge cases. acceptance: at least 4 Given/When/Then statements including the rejected cases. tests: at least 2 concrete tests. covers: the new requirement ids — every new requirement must be covered.`
    : kind === 'bugfix'
    ? `You are the senior engineer on call for an existing product. The user reported the bug below. Diagnose before prescribing.

${common}

Method:
1. Read the relevant parts of the specification/memory and the code path the report describes.
2. Find the ROOT CAUSE — file, line and why it produces the reported behavior — not the symptom. Use the existing tests or a focused test run as evidence where it helps. Check whether the same defect pattern exists in sibling code and include those places.
3. If the reported behavior is what the specification demands, say so in "summary" and plan the smallest change that gives the user what they expect.
4. The report may list SEVERAL bugs (numbered): diagnose each one separately — one finding per bug with its own root cause. If two reports share a root cause, say so and plan one fix.
5. Plan the fix as small tasks (type "bug"), usually one per bug, at most 8 in total. For each: details (files and the exact change), acceptance criteria as Given/When/Then including the reported scenario, and tests — the FIRST test must be a regression test that fails before the fix and passes after it. No unrelated refactors, no new features.
6. If you cannot find a defect for a report, do not invent one: state in "summary" what you checked and what information is missing, and leave it out of the tasks.
"findings": the root cause(s) you identified (type "bug").`
    : `You are a staff engineer asked for a code-health pass on a product that works and already passed acceptance. Decide what is actually worth changing.${text ? '' : ' The user gave no focus: survey the whole codebase.'}

${common}

Method:
1. Measure before judging: file sizes, import graph, grep for duplicated logic, test coverage of the risky paths.
2. Look for: real duplication; oversized modules mixing responsibilities; layering or boundary violations; dead code; misleading names; inconsistent patterns for the same job; brittle or missing tests around risky logic; and BUGS you notice while reading (wrong behavior against the specification, unhandled error paths, races).
3. Rank by value against risk. Skip cosmetic churn: a refactor that does not make the next change easier or safer is not worth a task.
4. Plan 2–8 tasks, each independently shippable:
   - type "refactor": behavior-preserving. details: files and the target structure. acceptance: what must stay identical (routes, API request/response shapes, DB schema, UI text, env variables) and what improves. tests: the existing suite stays green without weakening assertions; add characterization tests first where the touched code has thin coverage.
   - type "bug": for each real bug found. Regression test first (fails before, passes after), then the fix.
   Order tasks so that bug fixes and characterization tests come before the refactors that depend on them.
"findings": every candidate you judged worth doing (type "refactor") and every bug (type "bug"), with severity = how much it matters.`;
  return `${rules}

Your FINAL action must be calling the StructuredOutput tool with the complete result. Language: "summary", finding titles and details, task titles and goals MUST be written in ${lang || (plan && plan.language) || 'the language of the user request'} — the user reads them — even though the code and these instructions are in English; task details, acceptance and tests in English. "summary": 2–5 plain sentences, no headings. "routes": up to 6 URL paths worth opening in the browser after the change.

# ${kind === 'bugfix' ? "User's bug report (verbatim)" : kind === 'feature' ? "User's feature request (verbatim)" : "User's refactor request (verbatim)"}
${text || '(no specific focus — full code-health pass)'}
${(refs || []).length ? `\n# Files attached by the user (screenshots, logs, wireframes, documents; files under docs/sonda/design are the visual design the UI must match) — open each with the Read tool\n${refs.map((r) => `- ${r}`).join('\n')}\n` : ''}${feedback ? `\n# User feedback on your previous plan — revise accordingly\n${feedback}\n\n# Your previous plan (JSON)\n${JSON.stringify(previous || {})}\n` : ''}
${known}`;
}

module.exports = {
  MAINTENANCE_SCHEMA,
  maintenancePlanPrompt,
};
