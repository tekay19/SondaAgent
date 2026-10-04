// Planlama: keşif, gereksinimler, şartname bölümleri, görev planı, Claude planı, yönetici değerlendirmesi, plan eleştirisi.
const { DESIGN_CRAFT, ROBUSTNESS_BASELINE, REVIEWER_RULES, reqListText } = require('./base');
const { designFilesText } = require('./context');

// ---------- Planlama ----------
// Planlama 4 adımdır: (1) gereksinimler, (2) teknik şartname (bölüm bölüm, serbest Markdown),
// (3) fazlar + görevler, (4) kapsam denetimi. Tek büyük JSON istendiğinde model
// özetlemeye başlıyor; adımlara bölmek her çıktının tam ve ayrıntılı olmasını sağlar.
// 0. adım: Keşif — kısa fikir, kıdemli bir ürün yöneticisi gözüyle tam ürün tanımına genişletilir
// ve yalnızca kullanıcının verebileceği kararlar (varsayılanlarıyla) sorulur.
const DISCOVERY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    productBrief: { type: 'STRING', description: 'complete product definition in Markdown, in the user language' },
    questions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          question: { type: 'STRING' },
          why: { type: 'STRING', description: 'one sentence: what changes depending on the answer' },
          options: { type: 'ARRAY', items: { type: 'STRING' } },
          default: { type: 'STRING', description: 'recommended answer, one of the options' },
        },
        required: ['question', 'options', 'default'],
      },
    },
  },
  required: ['productBrief', 'questions'],
};

const STEP_DISCOVERY = `
STEP 0 — PRODUCT DISCOVERY. Act as a senior product manager and UX lead at a top agency. Before any engineering, turn the request into a complete product definition — the document a real team would agree on with the client. Return JSON with "productBrief" and "questions".

productBrief (GitHub Markdown, in the SAME language the user wrote in), with these sections:
1. Vision & goals — what the product is for, success criteria.
2. Target users — 2–4 personas with needs and context (device, frequency, expertise).
3. User journeys — the key end-to-end journeys per persona, step by step, including what happens when things go wrong.
4. Screens & navigation — EVERY page/screen (public, account, admin…) with its purpose and main content; the navigation structure.
5. Features — grouped by area, each marked Must / Should / Could. Benchmark against the best products in this category and include the features users would reasonably expect even if the request did not mention them (e.g. for a restaurant: opening hours, dietary/allergen filters, reservation capacity rules, confirmation emails, admin menu editing, SEO, maps) — but mark non-requested extras as Should/Could, not Must.
6. Business rules — concrete rules with numbers where possible (limits, time windows, validation, statuses and transitions, notifications).
7. Content & data — what data exists, who creates it, sample content needed.
8. Quality expectations — design quality and brand feel, responsive, accessibility, SEO, performance, security/privacy, languages.
9. Out of scope — what will explicitly NOT be built now.
For long detailed requests or attached documents: organize and complete — never contradict or drop anything the user specified, and do not bloat scope beyond it.

questions: 3–6 decisions that ONLY the user can make and that materially change scope, UX or architecture (e.g. who can edit content, payment or not, languages, login methods, brand style). Each with 2–4 concrete options, a one-sentence "why", and your recommended "default" (one of the options). No questions whose answer is obvious or already given. Questions, options and why in the user's language.`;

function discoveryBlock(discovery) {
  if (!discovery?.productBrief) return '';
  const qa = (discovery.answers || []).map((a) => `- ${a.question} → ${a.answer}`).join('\n');
  return `\n\n# Product definition (from discovery — the agreed product scope)\n${discovery.productBrief}${qa ? `\n\n# User decisions (binding)\n${qa}` : ''}`;
}

const REQ_ITEM = {
  type: 'OBJECT',
  properties: { id: { type: 'STRING', description: 'R1, R2, ...' }, text: { type: 'STRING' } },
  required: ['id', 'text'],
};

const REQUIREMENTS_SCHEMA = {
  type: 'OBJECT',
  properties: {
    projectName: { type: 'STRING', description: 'kebab-case English name' },
    summary: { type: 'STRING', description: '2-4 sentences, in the user language' },
    language: { type: 'STRING', description: 'Language of the product UI text, e.g. Turkish' },
    userLanguage: { type: 'STRING', description: 'Language the user wrote the request in, e.g. Turkish (reviews and reports are written in it)' },
    stack: { type: 'ARRAY', items: { type: 'STRING' } },
    features: { type: 'ARRAY', items: { type: 'STRING' } },
    assumptions: { type: 'ARRAY', items: { type: 'STRING' } },
    questions: { type: 'ARRAY', items: { type: 'STRING' }, description: 'open questions for the user, in the user language' },
    threatModel: { type: 'ARRAY', items: { type: 'STRING' }, description: 'attack surface, assets, likely attacks and who must never see/do what — for this product' },
    designDirection: { type: 'STRING', description: 'Markdown design direction for the product UI (empty string if the product has no UI): concept & mood, typography (named fonts), palette (hex), layout principles, signature details, component style, motion, imagery & iconography, avoid list' },
    requirements: { type: 'ARRAY', items: REQ_ITEM },
  },
  required: ['projectName', 'summary', 'language', 'stack', 'features', 'assumptions', 'threatModel', 'designDirection', 'requirements'],
};

const TASK_ITEM = {
  type: 'OBJECT',
  properties: {
    phase: { type: 'STRING', description: 'phase/milestone name this task belongs to' },
    title: { type: 'STRING' },
    goal: { type: 'STRING' },
    details: { type: 'STRING' },
    acceptance: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Given/When/Then statements' },
    tests: { type: 'ARRAY', items: { type: 'STRING' }, description: 'concrete automated test cases: level + name + what it asserts' },
    covers: { type: 'ARRAY', items: { type: 'STRING' }, description: 'requirement ids' },
  },
  required: ['phase', 'title', 'goal', 'details', 'acceptance', 'tests', 'covers'],
};

const TASKS_SCHEMA = {
  type: 'OBJECT',
  properties: {
    tasks: { type: 'ARRAY', items: TASK_ITEM },
    specAddendum: { type: 'STRING', description: 'Markdown corrections/clarifications to the spec from the plan review; empty if none' },
    verify: {
      type: 'OBJECT',
      properties: {
        setup: { type: 'ARRAY', items: { type: 'STRING' }, description: 'commands that start services needed by integration/e2e tests' },
        commands: { type: 'ARRAY', items: { type: 'STRING' }, description: 'extra checks; each must exit 0 on a working product; to assert that something FAILS (e.g. a CLI rejecting bad input) prefix the command with "! " — error cases normally belong in the test suite' },
        devCommand: { type: 'STRING', description: 'command that starts the main web UI for browser tests; empty = auto' },
        devUrl: { type: 'STRING', description: 'URL of the main web UI when devCommand is set' },
        routes: { type: 'ARRAY', items: { type: 'STRING' } },
      },
    },
  },
  required: ['tasks', 'verify'],
};

const PLANNER_BASE = `You are the principal engineer and product lead of "Sonda", an automated software factory. A user describes an application (often briefly, often in Turkish) and may attach technical documents (specs, PRDs, API docs, wireframes, screenshots). Autonomous coding agents (Claude Code or OpenAI Codex CLI) will build it task by task in a local folder with NO human in the loop. The quality bar is what a strong senior team would ship.

Global rules:
- The user's request is saved verbatim to docs/sonda/REQUEST.md and agents read it too. A long, detailed request IS a specification: preserve every rule — never simplify, drop or "modernize away" what the user explicitly asked for (named technologies, structure, entities, fields, statuses, security rules, phases, edge cases).
- Attached documents are a primary source of truth: preserve every requirement, entity, field, business rule, naming, endpoint, screen and constraint. Where they are silent or ambiguous, choose the most professional option and record it as an assumption. Images/wireframes define layout and visual intent.
- Attached DESIGN files (HTML/CSS pages, a design folder, mockup images or PDFs) define the visual design, not just intent: the product's UI must reproduce them faithfully — same page structure and sections, typography, colors, spacing, imagery and responsive behavior — ported into the chosen stack. Plan the UI from them (derive the design tokens and components from the files), and turn fidelity into explicit requirements prefixed "[UI]". On visuals the design wins over the documents; on behavior and data the documents win. The design may cover only some screens (e.g., only the landing page while the documents also describe an admin panel): screens it does not cover are designed in the SAME visual language — the tokens, typography, components and spacing derived from the supplied files — and listed in assumptions as "no design supplied; derived from the design system". A screen without a design is never an error, a blocker or a question back to the user.
- When NO design files are supplied, the visual design is a deliverable in its own right: the design direction (designDirection) is binding for every screen, and the plan sets it up (tokens, fonts, base layout, shared components) before screens are built. ${DESIGN_CRAFT}
- With only a short idea, infer a sensible, modern, polished scope (a working, well-crafted product beats a sprawling half-finished one).
- Stack: honor anything the user or documents specify. Default for web apps: Next.js (App Router) + TypeScript (strict) + Tailwind CSS + zod, Vitest for tests. Avoid paid services and secret API keys unless explicitly requested: local mock data / SQLite / JSON and mock payments.
- If an existing project is provided, build on it (no re-scaffolding) and respect its conventions. If it contains Sonda memory files (docs/sonda/REQUEST.md, SPEC.md, MEMORY.md, PROGRESS.md), they describe what was already built: keep the existing product intact; requirements and spec describe the UPDATED FULL product (existing + new), while tasks cover only new/changed work.
- If previous plan output and user feedback are provided, revise accordingly and keep everything the feedback does not change.
- THE GOAL is to hand the user a complete, fully working application that does exactly what they asked for — every requested feature working end-to-end, nothing half-done.
- ROBUSTNESS IS PART OF THE PLAN, designed in from the first task — not patched in after reviewers find stuck states. For every flow decide what happens when each step fails, and write it down as requirements, specification and acceptance criteria. ROBUSTNESS BASELINE (like the security baseline: scaled to the product, never "unrequested scope"): ${ROBUSTNESS_BASELINE}
- Proportionality: match the engineering depth to the request. Build everything the user asked for completely, but do NOT add infrastructure or product features they did not ask for and the product does not need (Docker, CI/CD, health endpoints, caching layers, microservices, admin tools, monitoring/observability stacks…). For small apps and sites keep operations minimal (a README with setup/run/test instructions). Add such things only when the request asks for them or the product clearly cannot work without them. The security baseline below is never "unrequested scope".
- If current library versions are provided, design for exactly those versions and their current APIs; never use removed or deprecated APIs.
- SECURITY IS PART OF THE PLAN, scaled to the product: think like an attacker about THIS product (who can reach it, what is valuable, which inputs cross a trust boundary — public forms, uploads, webhooks, payments, admin panels, multi-tenant data, background jobs) and turn the defenses into explicit, testable security requirements. A public site with a contact form needs a few; a multi-user or money-handling app needs many. Each defense belongs to the task that builds the surface it protects, never to a final "security task" only.
- SECURITY BASELINE (the one rule every planning, coding and review step applies — nothing beyond it is demanded, nothing in it is optional): (a) always — server-side validation of every external input, parameterized queries, output escaping, no secrets in code, logs or URLs, safe error messages, no dependency with a known high/critical vulnerability; (b) as soon as the product has accounts, sessions or non-public data — authentication and object-level authorization on every protected surface, secure session/cookie settings, CSRF protection for state-changing requests, rate limiting on login/OTP/password-reset and other abuse-prone public write endpoints, security headers, safe file uploads; (c) only when the request asks for it — production security infrastructure (WAF, audit-log pipelines, secrets managers, monitoring).`;

const STEP_REQUIREMENTS = `
STEP 1 of 4 — REQUIREMENTS. Return JSON:
- projectName (kebab-case English), summary (2–4 sentences), language (product UI language), userLanguage (the language the user wrote in), stack, features (major capabilities), assumptions, questions.
- requirements: an EXHAUSTIVE, ATOMIC list (R1, R2, …) — one concrete, testable rule per item. Walk through the request and documents section by section and turn EVERY entity (with its fields and statuses), endpoint, screen/section, business rule, validation rule, security rule, stated non-functional rule (performance, logging, i18n, a11y, SEO, DevOps, docs, tests — those the request or documents actually ask for, plus accessibility and tests which always apply) and edge case into requirements. Use the product definition from discovery (if given) as the agreed scope: every Must and Should feature, screen, journey and business rule becomes requirements; Could items only if cheap. After discovery, even short ideas typically yield 40–90 requirements; large detailed specifications 80–200. Never merge unrelated rules into one item.
- questions: usually EMPTY — discovery already asked the user. Only add a question if something critical is still unclear; the plan must work with the defaults stated in assumptions.
- threatModel: 3–12 short lines for THIS product — attack surface (entry points, trust boundaries), assets worth attacking, the most likely attacks, and who must never see/do what. Then make sure each defense the security baseline requires for THIS product's exposure exists as a requirement (level (a) always; level (b) — auth/authorization per surface, CSRF, rate limiting, secure sessions, safe uploads — only where the product has accounts, sessions or non-public data). Prefix security requirement texts with "[SEC]".
- Robustness requirements: turn the robustness baseline into requirements for THIS product, prefixed "[ROB]" (typically 4–12; a static site needs few, a product with external providers, background work or money needs many). Name the concrete things: which operations and external calls exist and what the user sees when each fails or times out; each state machine with its states, terminal states and the rule that every failure path reaches one; what is transactional; what must be idempotent; limits on inputs and lists; what happens on restart.
- designDirection: if the product has any UI (web, mobile, desktop), write its design direction in Markdown (10–30 lines) the way an art director briefs a team: (1) concept & mood in 2–3 sentences rooted in the domain and audience, with 1–2 real-world references; (2) typography — a NAMED distinctive display face and a body face (e.g. Google Fonts; never Inter/Roboto/Arial/system-ui as the display face) and the scale; (3) palette — 5–8 named colors with hex values (background, surface, text, primary, accent, semantic) derived from the concept, not a default gradient; (4) layout principles (grid, density, rhythm, whitespace, editorial devices); (5) 1–2 signature details that make the product recognizable; (6) component style (radius, borders/shadows, buttons, forms, tables, navigation); (7) motion; (8) imagery & iconography (icon set, illustration/photo approach — never emoji as icons); (9) a short "avoid" list. Vary the direction with the product: a bakery, a law firm and a fintech must not look alike. Then add a "[UI]" requirement that the product implements this direction through design tokens and shared components, and that no screen looks like a generic template. If design files are attached, describe instead the design system derived from them (tokens, type, components) so that screens they do not cover match them. Empty string only for products without a UI (CLI, API-only, library).
Language: summary, features, assumptions, questions, threatModel, designDirection and requirement texts in the SAME language the user wrote in.`;

// Büyük projelerde şartname bölüm bölüm yazılır: önce temel (mimari, veri modeli), sonra
// diğer bölümler paralel olarak bu temele dayanarak. Her bölüm kendi uzmanlığına odaklanır.
const SPEC_SECTIONS = [
  { key: 'architecture', title: '1. Overview & Architecture', focus: 'Goals and scope; apps/packages/modules and their boundaries; the COMPLETE folder tree for every app and package; layering (e.g. controller → service → repository); cross-cutting concerns: config & env validation, error model and response envelope, logging, auth/session, i18n, money and time handling; key technology choices with one-line rationale; how the pieces communicate.' },
  { key: 'data', title: '2. Data Model', focus: 'Every entity/table with every field (type, nullability, default, unique, index), enums with all values, relations with cardinality and onDelete behavior, soft delete, audit fields, money representation, multi-tenancy readiness. Write it as a complete, valid schema for the chosen ORM (e.g. a full Prisma schema in a code block) followed by notes on migrations and realistic seed data.' },
  { key: 'api', title: '3. API Contract', focus: 'The complete endpoint catalog grouped by module: method, path (with version prefix), auth & roles, path/query/body parameters with validation rules, response shape, error codes, pagination/sorting/filtering, rate limits, idempotency keys, caching; the shared success/error/list envelopes; webhook and queue job contracts; how shared types/validation schemas are shared with the frontends.' },
  { key: 'ui', title: '4. Pages & UI', focus: 'Every route/screen of every frontend app: purpose, layout sections, components, data needed (server vs client fetching, caching/revalidation), all states (loading/empty/error/success), forms with fields and validation messages, interactions, responsive behavior per breakpoint, SEO/metadata and indexing rules. Then the design system: tokens (colors with hex, typography scale, spacing, radius, shadows), component variants, a11y rules — implementing the design direction exactly (same fonts, palette, signature details, component style); if no direction is given, define one that is genuinely designed for this product, never a generic template look.' },
  { key: 'flows', title: '5. Key Flows & Business Rules', focus: 'Step-by-step sequences for every key flow (e.g. registration/login/refresh, cart & merge, checkout, order creation, stock reservation/release, payment & webhooks, admin status changes, emails): business rules and calculations (exact formulas and rounding), validation, transactions, concurrency and idempotency handling, domain events, edge cases and failure handling for each. For every flow add a FAILURE-MODE TABLE: step → what can go wrong (dependency down or timing out, invalid/duplicate/out-of-order event, crash between two writes, second actor at the same time, restart mid-flow) → resulting state → what the user sees → how it recovers. List every state machine with all states, legal transitions and terminal states; state the invariants (every failure path ends in a terminal state; terminal states are never overwritten) and name the single module that performs the transitions. Every [ROB] requirement must be traceable to a mechanism here.' },
  { key: 'ops', title: '6. Security, Quality & Operations', focus: 'SCALED TO THE PROJECT (see the proportionality rule): the security design for the threat model — where authentication and object-level authorization are enforced and how, input validation and CSRF strategy, session/cookie/token settings, rate limits, security headers, secrets and logging rules, safe file handling, with concrete module names so every [SEC] requirement maps to a mechanism; performance essentials, the testing strategy (unit/integration/e2e scope with named critical test cases, including an e2e test for each key user journey of a web app; root scripts lint/typecheck/test/test:integration/test:e2e/build), environment variables (.env.example), how to set up, run and test locally, and out of scope. Only for requests that ask for production infrastructure: caching with invalidation, observability, Docker, CI/CD, deployment.' },
];

function specSectionSystem(section) {
  return `${PLANNER_BASE}

STEP 2 of 4 — TECHNICAL SPECIFICATION, SECTION "${section.title}". The full spec is written section by section by specialists; you write ONLY this section, as GitHub Markdown in English, starting with the heading "## ${section.title}". Focus: ${section.focus}
Be exhaustive and concrete — agents implement exactly what it says, and anything you leave vague will be improvised inconsistently. Cover every relevant requirement (reference R-ids). Stay consistent with the sections already written (given below): same names, types, paths and decisions. Typical length for a large product: 6,000–12,000 characters for this section. Output only the section.`;
}

function specSectionUserText(base, head, doneSections) {
  const prev = doneSections.length ? `\n\n# Sections already written (stay consistent)\n${doneSections.join('\n\n')}` : '';
  return `${specUserText(base, head)}${prev}`;
}

const STEP_TASKS = `
STEP 3 of 4 — PHASES & TASKS. Requirements and the specification are given. Return JSON with "tasks" and "verify".
- tasks: sequential vertical slices; count scales with scope — small apps 3–6, medium products 6–12, large multi-app platforms 25–45. Each task fits ONE focused agent session (roughly 20–60 minutes of agent work) and leaves the project building and runnable. A task that would touch many unrelated modules must be split.
- phase: if the request defines phases/milestones, mirror them EXACTLY (same names, same order) and split large phases into 2–6 tasks each; otherwise group tasks into logical phases of usually 2–5 tasks each (small apps: 2–3 phases, medium: 3–5). Avoid single-task phases unless unavoidable — Sonda runs a full, fairly slow quality gate at the end of each phase.
- The first task scaffolds IN THE CURRENT DIRECTORY (".") with non-interactive commands and sets up tooling (strict TS, lint, formatter, test runner, the root scripts lint/typecheck/test/test:integration/test:e2e/build, folder structure, design tokens, base layout). For products with real business logic it also configures test coverage with enforced thresholds for the business-logic modules (at least 80% lines and branches; UI components, generated code and configuration excluded) so the root \`test\` script fails below them. Include tests in the tasks where the logic lives. The final task is a hardening pass (responsive polish, states, a11y, SEO, docs/README) — it polishes; it must not be the place where failure handling is first built.
- details: precise — files/modules to create or change, data shapes, endpoints, components, behaviors, states, edge cases; reference spec sections.
- acceptance: at least 4 (typically 4–10) objectively checkable statements in Given/When/Then form (e.g. "Given a table for 4 is fully booked at 19:00, when a guest requests 19:00 for 2, then the form shows the next free slots and no reservation is created"). Cover the happy path, validation failures and edge cases. Every task that has logic, I/O or state must include at least 2 FAILURE-PATH criteria taken from the spec's failure-mode tables (e.g. "Given the search provider times out, when the stage runs, then the run ends FAILED with a visible message and no stage stays RUNNING"); [ROB] requirements go to the task that builds the mechanism, not to the hardening task.
- tests: at least 2 concrete automated tests this task must add, each as "<unit|integration|e2e>: <name> — <what it asserts>". Business logic always gets unit tests; every key user journey of a web app gets an e2e test in the task that completes it; each failure-path criterion gets a test that makes the dependency fail.
- covers: the requirement IDs it implements — EVERY requirement must be covered by at least one task.
- verify.setup: commands that start services for integration/e2e tests at phase gates (e.g. \`docker compose up -d --wait postgres redis\` then migrations); empty if none.
- verify.commands: extra commands that must pass at phase gates and at the end (e.g. \`pnpm prisma migrate deploy\`); never repeat lint/typecheck/test/build (Sonda runs those after every task). Each command must exit 0 when the product works — never list a command that is expected to fail (a CLI given bad input…) as is: put such error cases in the test suite, or prefix the command with "! " so Sonda requires a non-zero exit.
- verify.devCommand / verify.devUrl: for monorepos or multi-app setups, the command that starts the main web UI with what it needs (e.g. the API) and the URL to open; empty for single apps (auto-detected).
- verify.routes: up to 6 URL paths for the automated browser test; empty for non-web projects.
Language: task titles and goals in the user's language; details and acceptance in English.`;

const STEP_TASKS_REVIEW = `
STEP 4 of 4 — PLAN REVIEW. A draft task plan is given, plus the list of requirement IDs that no task covers and (if present) an independent critique written by another senior engineer who inspected the target folder and checked current library versions. Act as a demanding principal engineer and return the complete, improved JSON (tasks + verify + specAddendum):
- address EVERY high and medium finding of the independent critique (fix the tasks; describe every spec correction you decide on — versions, APIs, paths, data model fixes, resolved contradictions — in specAddendum as a concrete Markdown list; the spec sections will be rewritten with these decisions); ignore a finding only if it is clearly wrong;
- bring every task listed as "below minimum" up to at least 4 Given/When/Then acceptance criteria and 2 concrete tests;
- remove scope the user did not ask for (proportionality rule) unless the critique shows the product needs it — the security baseline is never unrequested scope;
- cover every uncovered requirement (extend a fitting task or add tasks);
- split tasks that are too large for one focused session; fix ordering so dependencies come first;
- make vague details concrete; every task must have Given/When/Then acceptance criteria and concrete tests; ensure a11y, responsive design and a hardening pass are planned;
- robustness: every task with logic, I/O or state has at least 2 failure-path acceptance criteria with tests, every [ROB] requirement is covered by the task that builds the mechanism, and state machines are designed in the task that introduces them (not fixed later);
- check that every Must/Should feature, screen and journey of the product definition is really built by some task;
- keep phase names exactly as in the request; keep what is already good and do not drop detail.`;

// npm kayıt defterinden alınan güncel sürümler (Gemini'nin eski API bilgisini düzeltmek için).
function versionsBlock(versions) {
  const entries = Object.entries(versions || {});
  if (!entries.length) return '';
  const hints = [];
  const major = (name) => parseInt(String(versions[name] || '').split('.')[0], 10);
  if (major('tailwindcss') >= 4) hints.push('tailwindcss 4: CSS-first configuration (`@import "tailwindcss"` and `@theme` in the global CSS); tailwind.config.* is not used by default.');
  if (major('zod') >= 4) hints.push('zod 4: `errorMap` was removed — use the `error` / `message` params; use z.flattenError / z.treeifyError for error shapes.');
  if (versions.motion) hints.push('animation: the `motion` package (import from "motion/react") supersedes `framer-motion`.');
  return `\n\n# Latest published versions on npm (today)\nUse the versions the official scaffolder / package manager installs; use this list to know which MAJOR version's APIs are current, and never write code for APIs that were removed in these majors.\n${entries.map(([k, v]) => `- ${k}: ${v}`).join('\n')}${hints.length ? `\nNotes:\n${hints.map((h) => `- ${h}`).join('\n')}` : ''}`;
}

function planUserText({ idea, existing, feedback, previousPlan, attachmentNames, designNames, discovery, versions, env }) {
  const parts = [`# User request\n${idea || '(No text — build what the attached documents describe.)'}${discoveryBlock(discovery)}${versionsBlock(versions)}`];
  if (designNames?.length) parts.push(`# Design files (binding for the UI)\n${designNames.map((n) => `- ${n}`).join('\n')}\nThese files ARE the visual design of the product. Their sources and rendered previews follow below. The UI must match them page by page; do not invent a different look. Screens they do not cover get the same visual language (derived tokens and components) — never a different style, never an error. Add "[UI]" requirements for fidelity (structure, tokens, responsive behavior) and note in assumptions anything the design leaves undefined (including screens without a design).`);
  parts.push(`# Configuration and credentials\nEvery external credential or deployment setting (API keys, database URLs, SMTP, webhook secrets, admin passwords) must be an environment variable listed in \`.env.example\` with a comment saying what it is and where to get it — Sonda shows that file to the user, collects the real values and writes them into \`.env\`.${env?.names?.length ? ` The user has ALREADY provided values for: ${env.names.join(', ')} — plan to use exactly these names and make the related integrations real (not mocked).` : ''}`);
  if (attachmentNames?.length) parts.push(`# Attached documents\n${attachmentNames.map((n) => `- ${n}`).join('\n')}\n(Their contents follow below.)`);
  if (existing) parts.push(`# Existing project in the target folder\n${existing}`);
  else parts.push('# Target folder\nEmpty — this is a new project.');
  if (previousPlan) parts.push(`# Previous plan (JSON)\n${JSON.stringify(previousPlan)}`);
  if (feedback) parts.push(`# User feedback on the previous plan — revise accordingly\n${feedback}`);
  return parts.join('\n\n');
}

function specUserText(base, head) {
  const tm = (head.threatModel || []).length ? `\n\n# Threat model\n${head.threatModel.map((t) => `- ${t}`).join('\n')}` : '';
  const dd = String(head.designDirection || '').trim() ? `\n\n# Design direction (binding for every screen)\n${head.designDirection.trim()}` : '';
  return `${base}\n\n# Step 1 result\nProject: ${head.projectName}\nSummary: ${head.summary}\nStack: ${head.stack.join(', ')}\nAssumptions:\n${head.assumptions.map((a) => `- ${a}`).join('\n')}${tm}${dd}\n\n# Requirements\n${reqListText(head.requirements)}`;
}

function tasksUserText(base, head, spec) {
  return `${specUserText(base, head)}\n\n# Technical specification\n${spec}`;
}

function tasksReviewUserText(base, head, spec, draft, uncovered, critique, thin = []) {
  const crit = critique
    ? `\n\n# Independent critique (another senior engineer)\nVerdict: ${critique.verdict}\n${critique.summary}\n${(critique.findings || []).map((f) => `- [${f.severity}/${f.area}] ${f.problem} → ${f.recommendation}`).join('\n')}${critique.missingItems?.length ? `\nMissing: ${critique.missingItems.join('; ')}` : ''}`
    : '';
  return `${tasksUserText(base, head, spec)}\n\n# Draft task plan (JSON)\n${JSON.stringify(draft)}\n\n# Requirements not covered by any task\n${uncovered.length ? uncovered.join(', ') : '(none)'}\n\n# Tasks below minimum (need >= 4 acceptance criteria and >= 2 tests)\n${thin.length ? thin.join('\n') : '(none)'}${crit}`;
}

// ---------- Şartname bölümlerini kararlarla yeniden yazma (ek yerine: çelişki kalmasın) ----------
function specRewriteSystem(section) {
  return `${PLANNER_BASE}

SPEC REVISION — SECTION "${section.title}". The plan was reviewed; corrections were decided. Rewrite this section of the technical specification so that it fully incorporates every relevant correction below and contains NO contradiction with them (paths, versions, APIs, data model, rules, scope). Keep everything that is still correct — do not shorten or drop detail. Remove statements that the corrections supersede instead of keeping both. GitHub Markdown in English, starting with "## ${section.title}". Output only the section.`;
}

function specRewriteUserText({ base, head, sectionText, critique, decisions }) {
  const crit = (critique?.findings || []).map((f) => `- [${f.severity}/${f.area}] ${f.problem} → ${f.recommendation}`).join('\n');
  return `${specUserText(base, head)}\n\n# Corrections decided in plan review (binding)\n${decisions || '(none)'}\n\n# Independent critique findings\n${crit || '(none)'}\n\n# Current section text\n${sectionText}`;
}

// ---------- Claude mühendis planlar, Gemini yönetici onaylar ----------
// Gemini ürünü ve "bitti"nin tanımını (gereksinimler) belirler; teknik şartnameyi ve görev planını
// araçlarla çalışan Claude yazar (klasörü inceler, güncel sürümleri ve komutları doğrular).
// Gemini planı kullanıcının isteğine göre denetler ve gerekirse değişiklik ister.
const CLAUDE_PLAN_SCHEMA = {
  type: 'object',
  properties: {
    stack: { type: 'array', items: { type: 'string' } },
    spec: { type: 'string', description: 'complete technical specification, GitHub Markdown' },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          phase: { type: 'string' },
          title: { type: 'string' },
          goal: { type: 'string' },
          details: { type: 'string' },
          acceptance: { type: 'array', items: { type: 'string' } },
          tests: { type: 'array', items: { type: 'string' } },
          covers: { type: 'array', items: { type: 'string' } },
        },
        required: ['phase', 'title', 'goal', 'details', 'acceptance', 'tests', 'covers'],
      },
    },
    verify: {
      type: 'object',
      properties: {
        setup: { type: 'array', items: { type: 'string' } },
        commands: { type: 'array', items: { type: 'string' }, description: 'extra checks; each must exit 0 on a working product; to assert that something FAILS (e.g. a CLI rejecting bad input) prefix the command with "! " — error cases normally belong in the test suite' },
        devCommand: { type: 'string' },
        devUrl: { type: 'string' },
        routes: { type: 'array', items: { type: 'string' } },
      },
    },
    decisions: { type: 'string', description: 'key technical decisions and what you verified (versions, commands)' },
  },
  required: ['stack', 'spec', 'tasks', 'verify', 'decisions'],
};

function claudePlanPrompt({ base, head, job }) {
  return `You are the principal engineer of a senior team inside an automated software factory (Sonda). The product manager has already defined WHAT to build (product definition, requirements = the definition of done). Your job is HOW: the complete technical specification and the task plan that autonomous coding agents (you, in later sessions) will execute task by task with no human in the loop.

You are in the target project folder in READ-ONLY mode. Ground every decision in facts before writing:
- inspect the files on disk (if any) — the plan must fit what exists; ignore git history of deleted files;
- check current versions with \`npm view <package> version\` (Python packages: \`pip index versions <package>\`) and verify CLI flags / config formats with \`npm view <package> readme\` (e.g. the scaffolder's non-interactive flags) — never assume APIs from older major versions;
- check which toolchains this machine really has before depending on them: \`<tool> --version\` (python3, pip3, uv, poetry, docker, cargo…), \`go version\`, \`docker compose version\`, \`docker info\` (is the daemon running?). Plan with what is installed; when the product needs a tool that is missing or not running, record it in "decisions" and make the first task's README name the exact prerequisite — never assume it silently;
- each Bash call must be one plain command: no loops, no \`cd\` chains, no pipes, no redirections; you cannot install, download or execute packages.
- ${REVIEWER_RULES}

Rules from the product side (binding):
${PLANNER_BASE.split('Global rules:')[1] || ''}

Technical specification ("spec", GitHub Markdown, English) — concrete enough that two engineers would build the same thing, scaled to the project (small site ≈ 15–30K characters, large platform more). Sections:
1. Overview & Architecture — structure, the COMPLETE folder tree, layering, cross-cutting concerns, key choices with one-line rationale.
2. Data Model — every entity/type with fields, types, validation, relations (a complete schema for the chosen ORM if there is a database), sample/seed data.
3. API / Server contract — every endpoint or server action with inputs, outputs, validation and error handling.
4. Pages & UI — every route/screen: sections, components, all states (loading/empty/error/success), forms with fields and messages, responsive behavior, SEO; design tokens and component variants; a11y rules.
5. Key Flows & Business Rules — step by step with exact rules, formulas, edge cases. For every flow a FAILURE-MODE TABLE (step → what can go wrong: dependency down or timing out, invalid/duplicate/out-of-order event, crash between two writes, a second actor at the same time, restart mid-flow → resulting state → what the user sees → recovery). Every state machine with all states, legal transitions and terminal states, the invariants (every failure path ends in a terminal state; a terminal state is never overwritten) and the ONE module that performs transitions. Each [ROB] requirement must be traceable to a mechanism here.
6. Security — for the threat model given below: where authentication and authorization are enforced (and how), input validation and CSRF strategy, session/cookie/token settings, rate limits, security headers, secrets and logging rules, safe file handling. Concrete file/module names; each [SEC] requirement must be traceable to a mechanism here.
7. Quality & Operations — scaled to the project: testing strategy (named critical tests, including security tests such as "unauthenticated request → 401" and "user A cannot read user B's record"; root scripts lint/typecheck/test/test:integration/test:e2e/build), env vars, how to set up/run/test; production infrastructure only if requested.
The spec must not contradict itself or the requirements. Reference requirement IDs (R…).

Task plan:
- sequential vertical slices; small apps 3–6, medium 6–12, large platforms 25–45; respect any task/phase limits the user stated. Each task fits one focused agent session and leaves the project building and runnable.
- "phase": mirror phases named in the request exactly; otherwise 2–5 tasks per phase (small apps 2–3 phases); avoid single-task phases.
- the first task scaffolds IN THE CURRENT DIRECTORY with verified non-interactive commands and sets up tooling and the root scripts; the last task is a hardening pass.
- details: files/modules, data shapes, components, behaviors, states, edge cases (reference spec sections).
- acceptance: at least 4 Given/When/Then statements per task; tests: at least 2 concrete tests per task ("<unit|integration|e2e>: <name> — <what it asserts>"). Every task with logic, I/O or state includes at least 2 FAILURE-PATH criteria from the failure-mode tables, each with a test that makes the dependency fail; robustness is built in the task that introduces the mechanism — the hardening task only polishes.
- for products with real business logic the first task configures test coverage with enforced thresholds for business-logic modules (≥ 80% lines and branches; UI, generated code and config excluded) so the root \`test\` script fails below them.
- covers: requirement IDs — EVERY requirement below must be covered by at least one task. [SEC] requirements go to the task that builds the surface they protect (auth with the first protected page, authorization with each data access, CSRF with the first mutation…), and their acceptance criteria include the negative case (what must be rejected). [ROB] requirements go to the task that builds the operation, external call or state machine they describe.
- verify: setup (services for integration/e2e tests, else empty), commands (extra checks, never lint/typecheck/test/build; each must exit 0 when the product works — an error-case check that must FAIL is written with a leading "! ", but error cases normally belong in the test suite), devCommand/devUrl (only for multi-app setups), routes (up to 6 URL paths for the browser test).
- task titles and goals in the user's language; everything else in English.

Your FINAL action must be calling the StructuredOutput tool with the complete plan (stack, spec, tasks, verify, decisions) — do not only describe it in text.

${base}
${designFilesText(job)}${job?.designRefs?.length ? 'Inspect the design files now (pages, styles, assets) and plan the UI tasks to reproduce them: derive design tokens and components from them, list which page each task ports, and make "[UI]" fidelity requirements testable (structure, texts, tokens, responsive breakpoints).\n' : ''}
# Product definition summary
Project: ${head.projectName}
Summary: ${head.summary}
Suggested stack (from the manager — you may refine it with reasons): ${head.stack.join(', ')}
Product UI language: ${head.language}
Assumptions:
${head.assumptions.map((a) => `- ${a}`).join('\n')}

# Threat model (from the product side — design the defenses in, task by task)
${(head.threatModel || []).map((t) => `- ${t}`).join('\n') || '(none stated — derive it yourself from the product)'}
${String(head.designDirection || '').trim() ? `\n# Design direction (binding for every UI task)\n${head.designDirection.trim()}\nPlan the UI from it: the scaffolding task sets up the design tokens, fonts, base layout and shared components exactly as described; every screen task's acceptance criteria include fidelity to this direction (fonts, palette, signature details, component style, all states). ${DESIGN_CRAFT}\n` : ''}
# Requirements (definition of done)
${reqListText(head.requirements)}`;
}

const MANAGER_REVIEW_SCHEMA = {
  type: 'OBJECT',
  // Önce bulgular, karar en sonda: yönetici planı sorgulamadan "onay" yazmasın.
  propertyOrdering: ['findings', 'verdict', 'summary'],
  properties: {
    verdict: { type: 'STRING', enum: ['approve', 'revise'] },
    summary: { type: 'STRING' },
    findings: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          severity: { type: 'STRING', enum: ['high', 'medium', 'low'] },
          area: { type: 'STRING' },
          problem: { type: 'STRING' },
          change: { type: 'STRING', description: 'the concrete change the engineer must make' },
        },
        required: ['severity', 'problem', 'change'],
      },
    },
  },
  required: ['verdict', 'summary', 'findings'],
};

function managerReviewSystem(lang) {
  return `You are the product manager and delivery lead who owns the outcome: the user must receive a complete, fully working application that does exactly what they asked for. The principal engineer (another AI) wrote the technical specification and task plan below. You do NOT write the plan yourself — you judge it and request precise changes, like a demanding manager.

Check:
- fidelity to the user's request and the product definition: every requested feature, screen, journey and rule is planned; nothing important is missing; nothing unrequested is added (proportionality — the security baseline for this product's exposure does not count as unrequested); explicit user constraints (task/phase limits, technologies, languages) are respected;
- every requirement is covered by a task (see the computed list) and each task's acceptance criteria are measurable Given/When/Then with at least 4 criteria and 2 meaningful tests;
- the spec is complete for what agents must build and does not contradict itself or the requirements;
- task order and size are realistic; risky or vague parts are made concrete;
- every verify command exits 0 on a working product (a check that must fail is written with a leading "! "); otherwise the final acceptance can never pass;
- robustness is designed in: the spec has failure-mode tables and explicit state machines for the flows, every [ROB] requirement is covered by the task that builds the mechanism, and tasks with logic, I/O or state have failure-path acceptance criteria with tests — a plan that only describes the happy path, or that postpones failure handling to the hardening task, gets a high finding;
- for a product with a UI: the design (supplied design files or the design direction) is set up early — tokens, fonts, base layout, shared components — and the screen tasks build on it; a plan that leaves the visual design to improvisation, or that would produce a generic template look, gets a finding.
Work in this order (the output is ordered the same way): FIRST write the findings — walk the user's request sentence by sentence and the requirement list item by item against the tasks, then walk each flow's failure paths — and only THEN decide. verdict "approve" only if the plan can be executed as is to deliver what the user wants; otherwise "revise" with high/medium findings, each with the exact change to make. Low findings are optional polish. An approval with no findings must say in the summary what you checked.
"summary" and each finding's "problem" in ${lang || 'the language of the user request'} (the user reads them); "change" in English.`;
}

function managerReviewUserText({ base, head, plan, uncovered, thin }) {
  return `${base}

# Requirements (definition of done)
${reqListText(head.requirements)}

# Computed checks
Requirements not covered by any task: ${uncovered.length ? uncovered.join(', ') : '(none)'}
Tasks below minimum (need >= 4 acceptance criteria and >= 2 tests): ${thin.length ? `\n${thin.join('\n')}` : '(none)'}

# Engineer's plan
Stack: ${(plan.stack || []).join(', ')}
Decisions: ${plan.decisions || '-'}
Verify: ${JSON.stringify(plan.verify || {})}

## Tasks (JSON)
${JSON.stringify(plan.tasks)}

## Technical specification
${plan.spec}`;
}

function planRevisionPrompt(review, uncovered, thin) {
  return `The product manager reviewed your plan and requests changes before approving it:
${(review.findings || []).filter((f) => f.severity !== 'low').map((f) => `- [${f.severity}${f.area ? `/${f.area}` : ''}] ${f.problem} → ${f.change}`).join('\n') || '- see summary'}
${uncovered.length ? `\nRequirements still not covered by any task: ${uncovered.join(', ')}` : ''}${thin.length ? `\nTasks below minimum (>= 4 acceptance criteria, >= 2 tests):\n${thin.join('\n')}` : ''}
Manager's summary: ${review.summary}

Apply every change (verify facts with your read-only tools where needed), keep everything that was fine, and return the COMPLETE revised plan by calling the StructuredOutput tool again (stack, spec, tasks, verify, decisions).`;
}

// ---------- Claude: plan eleştirisi (salt okunur) ----------
const PLAN_CRITIQUE_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['solid', 'needs_changes'] },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          area: { type: 'string', enum: ['requirements', 'spec', 'data-model', 'stack', 'tasks', 'order', 'testing', 'security', 'ux', 'scope', 'other'] },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          problem: { type: 'string' },
          recommendation: { type: 'string' },
        },
        required: ['area', 'severity', 'problem', 'recommendation'],
      },
    },
    missingItems: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'summary', 'findings', 'missingItems'],
};

function planCritiquePrompt({ lang, base, head, spec, draft }) {
  return `You are an independent principal engineer. Another engineer (Gemini) wrote the plan below; autonomous coding agents will execute it task by task with no human in the loop, so every flaw becomes a bug. Critique it hard but fairly BEFORE any code is written.

You are working in the target project folder in READ-ONLY mode. Use your tools:
- inspect the existing files ON DISK (if any) — the plan must fit what is already there. Judge only the current working tree: ignore git history and files that were deleted from disk (do not use \`git show HEAD:...\` to reconstruct removed code);
- check CURRENT versions and breaking changes of the chosen libraries/frameworks with \`npm view <package> version\` (and your knowledge of their current APIs) — e.g. scaffolding flags, config formats, removed commands. To verify a CLI's flags use \`npm view <package> readme\` — you cannot run npx/npm create/install or any command that downloads and executes packages;
- you cannot modify anything, and each Bash call must be a single plain command: no loops, no \`cd\` chains, no pipes (\`|\`), no redirections (\`2>&1\`, \`>\`) — the permission system rejects them.
- ${REVIEWER_RULES}

Check: requirements vs the product definition (missing or contradictory items), scope the user did NOT ask for (over-engineering such as infrastructure a simple product does not need — report as area "scope"; the security baseline for this product's exposure is never over-engineering), architecture and data model soundness (relations, constraints, money/time handling, concurrency), stack choices and versions, task order and dependencies, task size (one focused agent session each), testability (acceptance criteria and tests), robustness gaps (flows without defined failure behaviour, state machines that can get stuck or whose terminal states can be overwritten, external calls without timeouts or a degraded mode, no recovery after a restart, failure paths without tests), security and UX gaps, scaffolding commands that would fail or prompt interactively, anything an agent would have to improvise.

Your FINAL action must be calling the StructuredOutput tool with the complete result — do not only describe the findings in text.
Return findings as concrete, actionable items (area, severity, problem, recommendation). High = will cause a broken or wrong product; medium = significant quality/maintainability risk; low = nice to have. "summary" and each finding's "problem" in ${lang || 'the language of the user request'} (the user reads them); "recommendation" in English.

${tasksUserText(base, head, spec)}

# Draft task plan (JSON)
${JSON.stringify(draft)}`;
}

module.exports = {
  DISCOVERY_SCHEMA,
  STEP_DISCOVERY,
  REQUIREMENTS_SCHEMA,
  TASKS_SCHEMA,
  PLANNER_BASE,
  STEP_REQUIREMENTS,
  SPEC_SECTIONS,
  specSectionSystem,
  specSectionUserText,
  STEP_TASKS,
  STEP_TASKS_REVIEW,
  versionsBlock,
  planUserText,
  specUserText,
  tasksUserText,
  tasksReviewUserText,
  specRewriteSystem,
  specRewriteUserText,
  CLAUDE_PLAN_SCHEMA,
  claudePlanPrompt,
  MANAGER_REVIEW_SCHEMA,
  managerReviewSystem,
  managerReviewUserText,
  planRevisionPrompt,
  PLAN_CRITIQUE_SCHEMA,
  planCritiquePrompt,
};
