// Sonda çekirdek birim testleri: `npm test`
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ADAPTERS, parseResetAt } = require('../src/main/agents');
const { planChecks } = require('../src/main/verify');
const docs = require('../src/main/docs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sonda-test-'));

test('parseResetAt: Claude ve Codex limit mesajlarını çözer', () => {
  const now = new Date('2026-09-26T18:30:00').getTime();
  const at = (t) => new Date(parseResetAt(t, now));
  assert.strictEqual(parseResetAt('Claude AI usage limit reached|1790000000', now), 1790000000 * 1000);
  assert.strictEqual(at('5-hour limit reached ∙ resets 9pm').getHours(), 21);
  const half = at("You've hit your limit · resets 7:30pm (Europe/Istanbul)");
  assert.deepStrictEqual([half.getHours(), half.getMinutes()], [19, 30]);
  assert.strictEqual(parseResetAt('Try again in 2 hours 13 minutes.', now), now + 133 * 60000);
  assert.strictEqual(parseResetAt('Please try again in 45 minutes', now), now + 45 * 60000);
  // Geçmiş saat → ertesi gün.
  assert.ok(at('limit reached, resets 9am') > new Date(now));
  // Anlaşılamayan mesaj → 30 dk.
  assert.strictEqual(parseResetAt('Rate limited', now), now + 30 * 60000);
});

test('Claude stream-json ayrıştırıcı: araç, metin ve sonuç', () => {
  const p = ADAPTERS.claude.createParser();
  const lines = [
    { type: 'system', subtype: 'init', session_id: 's1', model: 'opus' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'boom', is_error: true }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Bitti.' }] } },
    { type: 'result', subtype: 'success', is_error: false, result: 'Özet', session_id: 's1', total_cost_usd: 0.5 },
  ].flatMap((e) => p.onLine(JSON.stringify(e)));
  assert.deepStrictEqual(lines.map((l) => l.lvl), ['info', 'tool', 'warn', 'text', 'ok']);
  assert.strictEqual(lines[1].text, 'Bash · npm test');
  assert.deepStrictEqual([p.state.sessionId, p.state.text, p.state.costUsd, p.state.isError], ['s1', 'Özet', 0.5, false]);
});

test('Claude ayrıştırıcı: kimlik doğrulama hatası is_error olarak yakalanır', () => {
  const p = ADAPTERS.claude.createParser();
  p.onLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Failed to authenticate: OAuth session expired' }));
  assert.strictEqual(p.state.isError, true);
  assert.match(p.state.errorText, /Failed to authenticate/);
});

test('Codex JSON ayrıştırıcı: komut, dosya ve mesaj olayları', () => {
  const p = ADAPTERS.codex.createParser();
  const out = [
    { type: 'thread.started', thread_id: 't1' },
    { type: 'item.started', item: { type: 'command_execution', command: 'pnpm build' } },
    { type: 'item.completed', item: { type: 'command_execution', command: 'pnpm build', exit_code: 1, aggregated_output: 'error TS2322' } },
    { type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'src/a.ts', kind: 'update' }] } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'Tamam' } },
    { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } },
  ].flatMap((e) => p.onLine(JSON.stringify(e)));
  assert.deepStrictEqual(out.map((l) => l.lvl), ['info', 'tool', 'warn', 'tool', 'text', 'ok']);
  assert.deepStrictEqual([p.state.sessionId, p.state.text, p.state.gotResult], ['t1', 'Tamam', true]);
});

test('Ajan argümanları: tam otomatik ve güvenli mod', () => {
  const full = ADAPTERS.claude.buildArgs({ settings: { claudePermission: 'full', claudeModel: 'opus', claudeEffort: 'high' }, resumeId: 'abc' });
  assert.ok(full.includes('--dangerously-skip-permissions'));
  assert.deepStrictEqual(full.slice(full.indexOf('--resume'), full.indexOf('--resume') + 2), ['--resume', 'abc']);
  const safe = ADAPTERS.claude.buildArgs({ settings: { claudePermission: 'safe' } });
  assert.ok(safe.includes('acceptEdits') && !safe.includes('--dangerously-skip-permissions'));
  const codex = ADAPTERS.codex.buildArgs({ settings: { codexPermission: 'full' }, lastMessageFile: '/tmp/x' });
  assert.strictEqual(codex[codex.length - 1], '-', 'istem stdin üzerinden okunmalı');
});

test('planChecks: normal mod temel betikleri, tam mod entegrasyon/e2e ve servisleri ekler', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { lint: 'x', typecheck: 'x', test: 'x', 'test:integration': 'x', 'test:e2e': 'x', build: 'x', dev: 'x' } }));
  fs.mkdirSync(path.join(dir, 'node_modules'));
  const normal = planChecks(dir).checks.map((c) => c.name);
  assert.deepStrictEqual(normal, ['Kod denetimi', 'Tip kontrolü', 'Testler', 'Derleme']);
  const full = planChecks(dir, { full: true, setupCommands: ['docker compose up -d --wait postgres'], extraCommands: ['npm run build', 'pnpm prisma migrate deploy', 'npm run dev'] }).checks;
  assert.deepStrictEqual(full.map((c) => c.name), ['docker compose up -d --wait postgres', 'pnpm prisma migrate deploy', 'Kod denetimi', 'Tip kontrolü', 'Testler', 'Entegrasyon testleri', 'Derleme', 'Uçtan uca testler']);
  assert.ok(full[0].setup, 'servis komutu setup olarak işaretlenmeli');
  // Planın tekrar ettiği temel komutlar farklı paket yöneticisi yazımıyla da ayıklanır.
  const dup = planChecks(dir, { full: true, extraCommands: ['pnpm run lint', 'pnpm typecheck', 'yarn test', 'pnpm prisma generate'] }).checks.map((c) => c.name);
  assert.strictEqual(dup.filter((n) => n === 'Kod denetimi').length, 1);
  assert.ok(!dup.includes('pnpm run lint') && !dup.includes('pnpm typecheck') && !dup.includes('yarn test'));
  assert.ok(dup.includes('pnpm prisma generate'));
});

test('writeAgentGuides: yönetilen blok tekrar yazılınca çoğalmaz, kullanıcı içeriği korunur', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Benim notlarım\n');
  docs.writeAgentGuides(dir, '- kural 1');
  docs.writeAgentGuides(dir, '- kural 2');
  const text = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
  assert.match(text, /^# Benim notlarım/);
  assert.strictEqual(text.match(/sonda:start/g).length, 1);
  assert.match(text, /kural 2/);
  assert.doesNotMatch(text, /kural 1/);
  assert.ok(fs.existsSync(path.join(dir, 'AGENTS.md')));
});

test('writeRequest: istekler birebir saklanır, sonraki istekler sona eklenir', () => {
  const dir = tmp();
  docs.writeRequest(dir, { id: 'a', idea: 'İlk istek **aynen**', attachments: [] });
  docs.writeRequest(dir, { id: 'a', idea: 'İlk istek **aynen**', attachments: [] }); // aynı iş tekrar → eklenmez
  docs.writeRequest(dir, { id: 'b', idea: 'Favoriler ekle', attachments: [] });
  const text = fs.readFileSync(path.join(dir, 'docs/sonda/REQUEST.md'), 'utf8');
  assert.strictEqual(text.match(/İlk istek \*\*aynen\*\*/g).length, 1);
  assert.ok(text.indexOf('Favoriler ekle') > text.indexOf('İlk istek'));
});

test('appendProgress: günlük yalnızca büyür', () => {
  const dir = tmp();
  docs.appendProgress(dir, '## Görev 1');
  docs.appendProgress(dir, '## Görev 2');
  const text = fs.readFileSync(path.join(dir, 'docs/sonda/PROGRESS.md'), 'utf8');
  assert.ok(text.indexOf('Görev 1') < text.indexOf('Görev 2'));
});

test('renderMarkdown: HTML kaçışı yapar, yalnızca https bağlantılarına izin verir', () => {
  global.window = {};
  require('../src/renderer/markdown.js');
  const html = global.window.renderMarkdown('# Başlık\n\n<script>alert(1)</script> **kalın** [x](javascript:alert(1)) [ok](https://example.com)\n\n```\n<b>kod</b>\n```');
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<strong>kalın<\/strong>/);
  assert.doesNotMatch(html, /href="javascript/);
  assert.match(html, /data-href="https:\/\/example.com"/);
  assert.match(html, /&lt;b&gt;kod&lt;\/b&gt;/);
});

test('İnceleme modu: Claude salt okunur çalışır, yazma araçları ve MCP kapalıdır', () => {
  const args = ADAPTERS.claude.buildArgs({ settings: { claudePermission: 'full' }, mode: 'review', schema: { type: 'object' }, resumeId: 'x' });
  assert.ok(!args.includes('--dangerously-skip-permissions'), 'inceleyici tam yetki almamalı');
  assert.ok(args.includes('--resume'), 'salt-okunur oturum (ör. plan revizyonu) devam ettirilebilmeli');
  assert.ok(!ADAPTERS.claude.buildArgs({ settings: {}, mode: 'review' }).includes('--resume'));
  assert.strictEqual(args[args.indexOf('--tools') + 1], 'Read,Grep,Glob,Bash');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(args.includes('--json-schema'));
  const allowed = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools'));
  assert.ok(allowed.includes('Bash(npm test:*)') && allowed.includes('Bash(git diff:*)'));
  assert.ok(!allowed.some((a) => /Write|Edit|rm|touch|find|>/.test(a)), 'yazma / silme izni olmamalı');
  // İnceleyici, kullanıcının gerçek değerlerini taşıyan .env dosyalarını okuyamaz (örnek dosyası okunabilir).
  const denied = args.slice(args.indexOf('--disallowedTools') + 1, args.indexOf('--json-schema'));
  assert.ok(denied.includes('Read(.env)') && denied.includes('Read(**/.env.local)') && !denied.some((d) => /example/.test(d)));
  // Kodlama modunda MCP yalnızca ayar açıksa kullanılabilir.
  assert.ok(ADAPTERS.claude.buildArgs({ settings: {} }).includes('--strict-mcp-config'));
  assert.ok(!ADAPTERS.claude.buildArgs({ settings: { claudeAllowMcp: true } }).includes('--strict-mcp-config'));
  // Codex inceleyici salt-okunur sandbox'ta çalışır.
  const codex = ADAPTERS.codex.buildArgs({ settings: { codexPermission: 'full' }, mode: 'review' });
  assert.deepStrictEqual(codex.slice(codex.indexOf('--sandbox'), codex.indexOf('--sandbox') + 2), ['--sandbox', 'read-only']);
  assert.ok(!codex.includes('--dangerously-bypass-approvals-and-sandbox'));
});

test('jsonFromText: yapılandırılmış çıktı yoksa metindeki son JSON bloğunu okur', () => {
  const { jsonFromText } = require('../src/main/agents');
  assert.deepStrictEqual(jsonFromText('özet\n```json\n{"a":1}\n```\nara\n```json\n{"verdict":"fix"}\n```'), { verdict: 'fix' });
  assert.deepStrictEqual(jsonFromText('sonuç: {"verdict":"pass","issues":[]}'), { verdict: 'pass', issues: [] });
  assert.strictEqual(jsonFromText('JSON yok'), null);
});

test('İstemler: TDD bloğu ve plan eleştirisi doğru içeriği taşır', () => {
  const P = require('../src/main/prompts');
  const job = { plan: { summary: 's', stack: ['x'], language: 'Turkish', requirements: [{ id: 'R1', text: 'kural' }], spec: 'spec' }, tasks: [], memory: '', userNotes: [] };
  const task = { id: 't1', title: 'Görev', goal: 'g', details: 'd', acceptance: ['Given a, when b, then c'], tests: ['unit: x — y'], covers: ['R1'], tddFiles: ['src/a.test.ts'] };
  job.tasks.push(task);
  const prompt = P.taskPrompt(job, task, '- std', null);
  assert.match(prompt, /Tests written FIRST by the QA engineer/);
  assert.match(prompt, /src\/a\.test\.ts/);
  assert.match(prompt, /unit: x — y/);
  const author = P.testAuthorPrompt(job, task, '- std');
  assert.match(author, /Write ONLY tests/);
  const crit = P.planCritiquePrompt({ lang: 'Turkish', base: '# User request\nx', head: { projectName: 'p', summary: 's', stack: ['x'], assumptions: [], requirements: job.plan.requirements }, spec: 'spec', draft: { tasks: [task] } });
  assert.match(crit, /READ-ONLY/);
  assert.match(crit, /npm view/);
});

test('Claude ayrıştırıcı: StructuredOutput araç çağrısını ve tüm mesajları yakalar', () => {
  const p = ADAPTERS.claude.createParser();
  p.onLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Analiz 1' }] } }));
  p.onLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'StructuredOutput', input: { verdict: 'fix', issues: [] } }] } }));
  p.onLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Zaten gönderdim.' }] } }));
  p.onLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Zaten gönderdim.' }));
  assert.deepStrictEqual(p.state.structured, { verdict: 'fix', issues: [] });
  assert.deepStrictEqual(p.state.texts, ['Analiz 1', 'Zaten gönderdim.']);
});

test('isEmptyDir: yalnızca kalıntı (.git, .env, .next…) içeren klasör boş sayılır', () => {
  const { isEmptyDir } = require('../src/main/project');
  const dir = tmp();
  for (const f of ['.env', '.gitignore', '.DS_Store']) fs.writeFileSync(path.join(dir, f), 'x');
  for (const d of ['.git', '.next', 'node_modules']) fs.mkdirSync(path.join(dir, d));
  assert.strictEqual(isEmptyDir(dir), true);
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  assert.strictEqual(isEmptyDir(dir), false);
});

test('toGeminiSchema: JSON Schema tiplerini Gemini biçimine çevirir', () => {
  const { toGeminiSchema } = require('../src/main/gemini');
  const out = toGeminiSchema({ type: 'object', properties: { a: { type: 'array', items: { type: 'string', enum: ['x'] } } }, required: ['a'], additionalProperties: false });
  assert.deepStrictEqual(out, { type: 'OBJECT', properties: { a: { type: 'ARRAY', items: { type: 'STRING', enum: ['x'] } } }, required: ['a'] });
});

test('procs: yalnızca sahipsiz kalan süreç kapatılır; sahibi yaşayan sürece dokunulmaz', { skip: process.platform === 'win32' }, async () => {
  const { projectProcesses, killOrphans, orphansOf } = require('../src/main/procs');
  const { spawn, execFileSync } = require('child_process');
  // Saf işlev: terminaldeki (sahipli), ajanın bıraktığı (yetim) ve çalışan inceleyiciye ait süreçler.
  const T = new Map([
    [1, { ppid: 0, name: 'launchd' }],
    [100, { ppid: 1, name: 'Terminal' }], [101, { ppid: 100, name: 'login' }], [102, { ppid: 101, name: 'zsh' }], [103, { ppid: 102, name: 'npm' }], [104, { ppid: 103, name: 'node' }],
    [200, { ppid: 1, name: 'zsh' }], [201, { ppid: 200, name: 'npm' }], [202, { ppid: 201, name: 'node' }],
    [300, { ppid: 1, name: 'Sonda Agent' }], [301, { ppid: 300, name: 'claude' }], [302, { ppid: 301, name: 'zsh' }], [303, { ppid: 302, name: 'node' }],
    [400, { ppid: 1, name: 'node' }],
    [500, { ppid: 9999, name: 'node' }],
  ]);
  const cands = [103, 104, 201, 202, 303, 400, 500, 777].map((pid) => ({ pid, name: 'x' }));
  assert.deepStrictEqual(orphansOf(cands, T).map((p) => p.pid), [201, 202, 400, 500]);

  // Gerçek süreçler: biri bu testin çocuğu (sahipli), diğeri çift çatalla koparılmış (sahipsiz).
  const dir = fs.realpathSync(tmp());
  const owned = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: dir, stdio: 'ignore' });
  execFileSync('/bin/sh', ['-c', `cd "${dir}" && ("${process.execPath}" -e "setInterval(() => {}, 1000)" >/dev/null 2>&1 &)`]);
  try {
    await new Promise((r) => setTimeout(r, 900));
    const found = await projectProcesses(dir);
    assert.strictEqual(found.length, 2, 'iki süreç de bulunmalı');
    const killed = await killOrphans(dir);
    assert.strictEqual(killed.length, 1);
    assert.notStrictEqual(killed[0].pid, owned.pid, 'sahibi yaşayan süreç kapatılmamalı');
    await new Promise((r) => setTimeout(r, 300));
    assert.throws(() => process.kill(killed[0].pid, 0), 'yetim süreç kapanmış olmalı');
    assert.doesNotThrow(() => process.kill(owned.pid, 0), 'sahipli süreç çalışmaya devam etmeli');
  } finally {
    owned.kill('SIGKILL');
  }
  // Başka klasördeki süreçlere dokunulmaz.
  assert.deepStrictEqual(await projectProcesses(tmp()), []);
});

test('İstemler: sürüm notları, yanlış TDD testini düzeltme izni ve açık sorunlar', () => {
  const P = require('../src/main/prompts');
  const vb = P.versionsBlock({ tailwindcss: '4.3.3', zod: '4.6.5', next: '16.3.6' });
  assert.match(vb, /tailwindcss 4: CSS-first/);
  assert.match(vb, /zod 4: `errorMap` was removed/);
  assert.match(vb, /official scaffolder/);
  assert.strictEqual(P.versionsBlock({}), '');
  const job = { plan: { summary: 's', stack: ['x'], language: 'Turkish', requirements: [], spec: 'spec' }, tasks: [], memory: '', userNotes: [], discovery: { productBrief: '## Kullanıcı yolculukları\n- Menüyü açar, filtreler, rezervasyon yapar' } };
  const failed = { id: 't1', title: 'Form', goal: 'g', details: 'd', acceptance: ['a'], tests: [], covers: [], status: 'failed', review: { issues: ['Ondalıklı sayı girilemiyor'] }, tddFiles: ['src/a.test.ts'] };
  job.tasks.push(failed);
  const fix = P.fixPrompt(job, failed, { issues: ['x'], fixInstructions: 'y' }, [], { resumed: true, standards: '' });
  assert.match(fix, /correct that test so it matches the specification/);
  const parts = P.finalReviewParts({ job, checks: [], smoke: null, diff: null, snapshot: '' });
  assert.match(parts[0].text, /Open issues of tasks that did not pass/);
  assert.match(parts[0].text, /Ondalıklı sayı girilemiyor/);
  assert.match(parts[0].text, /user journeys to verify end-to-end/);
  assert.match(P.finalReviewSystem('Turkish'), /every user journey of the product definition works end-to-end/);
  const deep = P.deepReviewPrompt({ job, scope: 'the whole project (final acceptance)', tasks: job.tasks, reqIds: [], checks: [], smoke: null, lang: 'Turkish' });
  assert.match(deep, /verify that every user journey works end-to-end/);
  assert.match(P.PLANNER_BASE, /Proportionality/);
  assert.match(P.specRewriteSystem(P.SPEC_SECTIONS[0]), /NO contradiction/);
});

test('versions: teknoloji eşleşmesi kelime içinde yanlış pozitif vermez', () => {
  const { CANDIDATES } = require('../src/main/versions');
  const hits = (text) => CANDIDATES.filter(([, re]) => re.test(text)).map(([p]) => p);
  const tr = 'Gastronomi deneyimi, expressive tasarım, grafik tasarımcı, restoran hikâyesi';
  assert.ok(!hits(tr).includes('astro'));
  assert.ok(!hits(tr).includes('express'));
  assert.ok(!hits(tr).includes('recharts'));
  assert.deepStrictEqual(hits('Next.js, Tailwind CSS, zod').filter((p) => ['next', 'tailwindcss', 'zod'].includes(p)), ['next', 'tailwindcss', 'zod']);
  assert.ok(hits('Astro ile blog').includes('astro'));
});

test('Claude mühendis planlar, Gemini yönetici değerlendirir: istemler', () => {
  const P = require('../src/main/prompts');
  const head = { projectName: 'mavi-kapi', summary: 'Restoran sitesi', stack: ['Next.js'], language: 'Turkish', assumptions: ['TR'], requirements: [{ id: 'R1', text: 'Menü filtrelenir' }, { id: 'R2', text: 'Rezervasyon formu' }] };
  const plan = P.claudePlanPrompt({ base: '# User request\nrestoran', head });
  assert.match(plan, /READ-ONLY/);
  assert.match(plan, /npm view <package> readme/);
  assert.match(plan, /R1: Menü filtrelenir/);
  assert.match(plan, /Proportionality/);
  assert.match(plan, /StructuredOutput/);
  assert.ok(P.CLAUDE_PLAN_SCHEMA.required.includes('spec') && P.CLAUDE_PLAN_SCHEMA.required.includes('tasks'));
  const review = P.managerReviewUserText({ base: '# User request\nrestoran', head, plan: { stack: ['Next.js'], spec: 'SPEC', tasks: [{ title: 'T1' }], verify: {}, decisions: 'd' }, uncovered: ['R2'], thin: ['- T1 (acceptance 2, tests 1)'] });
  assert.match(review, /not covered by any task: R2/);
  assert.match(review, /T1 \(acceptance 2, tests 1\)/);
  assert.match(P.managerReviewSystem('Turkish'), /You do NOT write the plan yourself/);
  const rev = P.planRevisionPrompt({ summary: 'eksikler var', findings: [{ severity: 'high', area: 'scope', problem: 'Rezervasyon yok', change: 'Görev ekle' }, { severity: 'low', problem: 'ufak', change: 'x' }] }, ['R2'], []);
  assert.match(rev, /Rezervasyon yok → Görev ekle/);
  assert.doesNotMatch(rev, /ufak/);
  assert.match(rev, /COMPLETE revised plan/);
});

test('Faz kapısı hızlandırma: hedefli yeniden doğrulama, kanıt önceliği, kurulu sürümler', () => {
  const P = require('../src/main/prompts');
  const { installedVersions } = require('../src/main/project');
  const job = { plan: { summary: 's', stack: [], language: 'Turkish', requirements: [], spec: 'x' }, tasks: [], userNotes: [] };
  const re = P.deepReviewPrompt({ job, scope: 'phase "P1"', tasks: [], reqIds: [], checks: [], smoke: null, lang: 'Turkish', focus: [{ severity: 'high', title: 'Hero görünmüyor', file: 'Hero.tsx', detail: 'opacity 0' }] });
  assert.match(re, /RE-VERIFICATION, not a new full review/);
  assert.match(re, /Hero görünmüyor/);
  const full = P.deepReviewPrompt({ job, scope: 'phase "P1"', tasks: [], reqIds: [], checks: [], smoke: null, lang: 'Turkish' });
  assert.match(full, /Time budget: aim to finish within about 8 minutes/);
  assert.match(P.reviewSystem('Turkish'), /NEVER claim an API does not exist/);
  // Faz kapısında cila önerileri engellemez; gerçek kusurlar bulgu olarak doğrulanıp bu kapıda düzeltilir.
  assert.match(P.phaseReviewSystem('Turkish', 'P1'), /Polish and minor points go to "suggestions"/);
  assert.match(P.phaseReviewSystem('Turkish', 'P1'), /real defects in "findings" \(they are verified and fixed at this gate/);
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { zod: '^4' }, devDependencies: { vitest: '^5' } }));
  fs.mkdirSync(path.join(dir, 'node_modules', 'zod'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'zod', 'package.json'), JSON.stringify({ version: '4.6.5' }));
  assert.deepStrictEqual(installedVersions(dir), { zod: '4.6.5' });
});

test('.env.example: bölümler, açıklamalar, gerekli / varsayılan / isteğe bağlı ayrımı', () => {
  const E = require('../src/main/envfile');
  const vars = E.parseExample(`# --- Payments ---------------------------------------------------------
# Stripe secret key (Dashboard > Developers > API keys).
STRIPE_SECRET_KEY="sk_test_xxxxxxxxxxxx"
STRIPE_WEBHOOK_SECRET="whsec_real_looking"   # stripe listen çıktısı
# --- App ---
APP_NAME="Demo Shop"
PORT=3000
FEATURE_ENABLED=true
PUBLIC_URL="https://your-app.vercel.app"
# ADMIN_EMAIL=admin@example.com
`);
  const by = Object.fromEntries(vars.map((v) => [v.name, v]));
  assert.deepStrictEqual(vars.map((v) => v.name), ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'APP_NAME', 'PORT', 'FEATURE_ENABLED', 'PUBLIC_URL', 'ADMIN_EMAIL']);
  assert.strictEqual(by.STRIPE_SECRET_KEY.section, 'Payments');
  assert.match(by.STRIPE_SECRET_KEY.hint, /Dashboard > Developers/);
  assert.strictEqual(by.STRIPE_WEBHOOK_SECRET.hint, 'stripe listen çıktısı');
  assert.strictEqual(by.STRIPE_WEBHOOK_SECRET.example, 'whsec_real_looking');
  assert.ok(by.STRIPE_SECRET_KEY.needs && by.STRIPE_WEBHOOK_SECRET.needs && by.PUBLIC_URL.needs);
  assert.ok(!by.APP_NAME.needs && !by.PORT.needs && !by.FEATURE_ENABLED.needs);
  assert.strictEqual(by.APP_NAME.section, 'App');
  assert.ok(by.ADMIN_EMAIL.optional && !by.ADMIN_EMAIL.needs);
});

test('.env yazımı: yerinde güncelleme, diğer satırlar korunur, $ ve boşluk kaçışı, .env.local gölgelemez', () => {
  const E = require('../src/main/envfile');
  const text = '# yorum\nPORT=3000\nSTRIPE_SECRET_KEY=sk_test_placeholder\n';
  const out = E.upsertEnv(text, { STRIPE_SECRET_KEY: 'sk_live_a$b', NEW_ONE: 'two words' }, { escapeDollar: true });
  assert.match(out, /^# yorum\nPORT=3000\nSTRIPE_SECRET_KEY="sk_live_a\\\$b"\n/);
  assert.match(out, new RegExp(`${E.HEADER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\nNEW_ONE="two words"\n$`));
  // İkinci yazım aynı sonucu verir (tekrar ekleme yok).
  assert.strictEqual(E.upsertEnv(out, { STRIPE_SECRET_KEY: 'sk_live_a$b', NEW_ONE: 'two words' }, { escapeDollar: true }), out);
  assert.strictEqual(E.parseEnv(E.upsertEnv('', { A: 'x y', B: 'line1\nline2' })).B, 'line1\nline2');
  assert.strictEqual(E.serializeValue('plain_value-1'), 'plain_value-1');

  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { next: '16' } }));
  fs.writeFileSync(path.join(dir, '.env.local'), 'API_KEY=placeholder\nKEEP=1\n');
  fs.writeFileSync(path.join(dir, '.env.development'), 'API_KEY=public-dev\n');
  const written = E.writeEnvFiles([dir], { API_KEY: 'real$secret' });
  assert.deepStrictEqual(written.map((f) => path.basename(f)).sort(), ['.env', '.env.local']);
  assert.match(fs.readFileSync(path.join(dir, '.env.local'), 'utf8'), /^API_KEY="real\\\$secret"\nKEEP=1\n$/);
  assert.strictEqual(fs.readFileSync(path.join(dir, '.env.development'), 'utf8'), 'API_KEY=public-dev\n');
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(path.join(dir, '.env.local')).mode & 0o777, 0o600);
});

test('Gizli değerler: maskeleme, Basic Auth çifti, gizli sayılmayan ayarlar', () => {
  const E = require('../src/main/envfile');
  const vars = { TWILIO_AUTH_TOKEN: 'abc123def456ghi789', PORT: '3000', NODE_ENV: 'production', DATABASE_URL: 'postgresql://u:p4ss@db.example.com/app', BASIC_AUTH_USER: 'admin', BASIC_AUTH_PASSWORD: 'S3cret-pass' };
  const red = E.makeRedactor(vars);
  const out = red('token=abc123def456ghi789 url=postgresql://u:p4ss@db.example.com/app port 3000 mode production');
  assert.match(out, /token=‹gizli:TWILIO_AUTH_TOKEN› url=‹gizli:DATABASE_URL› port 3000 mode production/);
  assert.ok(!E.isSensitive('PORT', '3000') && !E.isSensitive('FEATURE', 'true') && E.isSensitive('AGENT_PHONE', '+905551112233'));
  assert.deepStrictEqual(E.basicAuthCreds(vars), { username: 'admin', password: 'S3cret-pass' });
  assert.strictEqual(E.basicAuthCreds({ PORT: '1' }), null);
});

test('Commit koruması: koda yazılmış gizli değer commit dışında kalır', async () => {
  const project = require('../src/main/project');
  const { execFileSync } = require('child_process');
  const dir = tmp();
  execFileSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'ok.ts'), 'export const a = process.env.API_KEY;\n');
  fs.writeFileSync(path.join(dir, 'leak.ts'), 'const key = "sk_live_VERYSECRET123";\n');
  let leaked = null;
  const hash = await project.commitAll(dir, 'test', { secretNeedles: ['sk_live_VERYSECRET123'], onLeak: (f) => (leaked = f) });
  assert.ok(hash);
  assert.deepStrictEqual(leaked, ['leak.ts']);
  const tracked = execFileSync('git', ['ls-files'], { cwd: dir, encoding: 'utf8' }).trim().split('\n');
  assert.ok(tracked.includes('ok.ts') && !tracked.includes('leak.ts'));
});

test('İstemler: ajanlar yalnızca anahtar adlarını görür, değerleri asla', () => {
  const P = require('../src/main/prompts');
  const job = { plan: { summary: 's', stack: [], language: 'Turkish', requirements: [], spec: 'x' }, tasks: [{ id: 't', title: 'T', goal: 'g', details: 'd', acceptance: ['a'] }], userNotes: [], env: { names: ['STRIPE_SECRET_KEY'], missing: ['DATABASE_URL'], exampleFile: '.env.example' } };
  const tp = P.taskPrompt(job, job.tasks[0], '', null);
  assert.match(tp, /The user supplied real values for: STRIPE_SECRET_KEY/);
  assert.match(tp, /still have no value: DATABASE_URL/);
  assert.match(P.planUserText({ idea: 'x', env: job.env }), /ALREADY provided values for: STRIPE_SECRET_KEY/);
  assert.match(P.envReviewText(job.env), /‹gizli:NAME›/);
  assert.strictEqual(P.envBlock({ names: [], missing: [] }), '');
});

test('CLI: kurulum türü ve sürüm karşılaştırma', () => {
  const { installKind, cmpVersion } = require('../src/main/agents');
  assert.strictEqual(installKind('/opt/homebrew/Caskroom/claude-code/2.1.277/claude').kind, 'brew');
  assert.strictEqual(installKind('/Users/x/.local/share/claude/versions/2.1.284').kind, 'native');
  assert.strictEqual(installKind('/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js').kind, 'npm');
  assert.ok(cmpVersion('2.1.284', '2.1.277') > 0 && cmpVersion('2.1.9', '2.1.10') < 0 && cmpVersion('1.0.0', '1.0.0') === 0);
});

test('Uzman paneli: dosya/satır çözümü ve kod alıntısı proje içinde kalır', () => {
  const { parseFileRef, codeExcerpt } = require('../src/main/panel');
  assert.deepStrictEqual(parseFileRef('src/core/services/dial.service.ts:52-80'), { file: 'src/core/services/dial.service.ts', line: 52 });
  assert.deepStrictEqual(parseFileRef('./next.config.ts', 3), { file: 'next.config.ts', line: 3 });
  assert.deepStrictEqual(parseFileRef('src/a.ts, src/b.ts (line 12)'), { file: 'src/a.ts', line: 12 });
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'a.ts'), Array.from({ length: 100 }, (_, i) => `line${i + 1}`).join('\n'));
  const ex = codeExcerpt(dir, 'a.ts', 50, { radius: 2 });
  assert.match(ex, /^ {2}48 {2}line48\n {2}49 {2}line49\n {2}50 {2}line50/);
  assert.strictEqual(codeExcerpt(dir, '../../etc/passwd', 1), '(outside the project)');
  assert.strictEqual(codeExcerpt(dir, 'yok.ts', 1), '(file not found)');
});

test('Uzman paneli: yalnızca doğrulanan bulgular düzeltme açar; doğrulanmış orta bulgu da engeller', () => {
  const { mergePanel } = require('../src/main/panel');
  const f = (severity, title) => ({ severity, title, area: 'logic', file: 'src/x.ts', line: 3, problem: 'p', scenario: 's', fix: 'x' });
  const panel = { confirmed: [f('high', 'Yarış durumu'), f('medium', 'Başlık eksik')], uncertain: [f('high', 'Belki')], rejected: [f('high', 'Yanlış alarm')], summaries: [] };
  const gate = mergePanel({ verdict: 'pass', issues: [], suggestions: [] }, panel, { labels: { logic: 'İş kuralları' } });
  assert.strictEqual(gate.verdict, 'fix');
  assert.strictEqual(gate.panel.blocking, 2);
  assert.match(gate.issues[0], /Uzman · İş kuralları \[high\]: Yarış durumu \(src\/x\.ts:3\)/);
  assert.match(gate.fixInstructions, /verified against the code[\s\S]*Yarış durumu[\s\S]*Başlık eksik/);
  assert.ok(!gate.issues.some((i) => /Belki|Yanlış alarm/.test(i)));
  // Doğrulanmış orta bulgu tek başına da düzeltme turu açar (sonraki görevlere devredilmez); düşük bulgu öneridir.
  const onlyMedium = mergePanel({ verdict: 'pass', issues: [], suggestions: [] }, { confirmed: [f('medium', 'Başlık eksik'), f('low', 'Adlandırma')], uncertain: [], rejected: [] });
  assert.deepStrictEqual([onlyMedium.verdict, onlyMedium.panel.blocking, onlyMedium.suggestions.length], ['fix', 1, 1]);
  assert.match(onlyMedium.fixInstructions, /Also fix in this round \(verified, lower severity\):[\s\S]*Adlandırma/);
  const onlyLow = mergePanel({ verdict: 'pass', issues: [], suggestions: [] }, { confirmed: [f('low', 'Adlandırma')], uncertain: [], rejected: [] });
  assert.deepStrictEqual([onlyLow.verdict, onlyLow.panel.blocking], ['pass', 0]);
});

test('Uzman paneli istemleri: üç alan, kanıt zorunluluğu, Claude doğrulayıcı', () => {
  const P = require('../src/main/prompts');
  assert.deepStrictEqual(Object.keys(P.SPECIALISTS), ['security', 'logic', 'quality']);
  const job = { plan: { summary: 's', stack: ['Next.js'], requirements: [{ id: 'R33', text: 'tek aktif arama' }], spec: 'x' }, tasks: [], userNotes: [] };
  const logic = P.specialistPrompt({ job, key: 'logic', scope: 'phase "P1"', lang: 'Turkish' });
  assert.match(logic, /check-then-act races/);
  assert.match(logic, /cleanup \/ timeout \/ reaper jobs/);
  assert.match(logic, /R33: tek aktif arama/);
  const sec = P.specialistPrompt({ job, key: 'security', scope: 'x', lang: 'Turkish', depAudit: { summary: 'critical 0, high 1', highCritical: ['lodash (high, düzeltme var)'] } });
  assert.match(sec, /REJECTED in production/);
  assert.match(sec, /High\/critical: lodash/);
  const ver = P.panelVerifyPrompt({ items: [{ i: 0, f: { area: 'logic', severity: 'high', title: 't', file: 'a.ts', line: 3, problem: 'p', scenario: 's', fix: 'f' }, code: '   3  x' }], lang: 'Turkish' });
  assert.match(ver, /VERIFIER/);
  assert.match(ver, /## Finding #0 — logic · high · t/);
  assert.match(ver, /confirm only what you verified yourself/);
});

test('Kodlayan ajan yalnızca kodlama araçlarıyla çalışır; alt ajan ve uyandırma yok', () => {
  const { ADAPTERS, CODE_TOOLS } = require('../src/main/agents');
  const args = ADAPTERS.claude.buildArgs({ settings: {}, mode: 'code' });
  const tools = args[args.indexOf('--tools') + 1].split(',');
  assert.ok(tools.includes('Bash') && tools.includes('Edit') && tools.includes('Write'));
  assert.ok(!tools.includes('Agent') && !tools.includes('ScheduleWakeup') && !tools.includes('Artifact'));
  assert.strictEqual(args[args.indexOf('--tools') + 1], CODE_TOOLS);
  const P = require('../src/main/prompts');
  const job = { plan: { summary: 's', stack: [], language: 'Turkish', requirements: [], spec: 'x' }, tasks: [{ id: 't', title: 'T', goal: 'g', details: 'd', acceptance: ['a'] }], userNotes: [] };
  assert.match(P.taskPrompt(job, job.tasks[0], '', null), /do not start sub-agents, background reviewers, loops or scheduled wake-ups/);
});

test('Güvenlik planla uyumlu: tehdit modeli şemada, istemlerde ve [SEC] görev kuralında', () => {
  const P = require('../src/main/prompts');
  assert.ok(P.REQUIREMENTS_SCHEMA.required.includes('threatModel'));
  assert.match(P.STEP_REQUIREMENTS, /threatModel: 3–12 short lines/);
  assert.match(P.STEP_REQUIREMENTS, /Prefix security requirement texts with "\[SEC\]"/);
  assert.match(P.PLANNER_BASE, /SECURITY IS PART OF THE PLAN/);
  const head = { projectName: 'p', summary: 's', stack: ['Next.js'], language: 'Turkish', assumptions: [], threatModel: ['Herkese açık iletişim formu: spam ve enjeksiyon'], requirements: [{ id: 'R1', text: '[SEC] Form girdileri sunucuda doğrulanır' }] };
  const plan = P.claudePlanPrompt({ base: 'x', head });
  assert.match(plan, /# Threat model[\s\S]*Herkese açık iletişim formu/);
  assert.match(plan, /\[SEC\] requirements go to the task that builds the surface they protect/);
  assert.match(plan, /6\. Security — for the threat model/);
  assert.match(P.DEFAULT_STANDARDS, /object-level authorization on the server/);
});

test('Görev sonu uzman incelemesi ve kalibre puan', () => {
  const P = require('../src/main/prompts');
  const job = { plan: { summary: 's', stack: [], language: 'Turkish', threatModel: ['Admin paneli'], requirements: [{ id: 'R2', text: '[SEC] Admin rotaları oturum ister' }, { id: 'R3', text: 'Liste sayfalanır' }], spec: 'x' }, userNotes: [] };
  const t = P.taskSpecialistPrompt({ job, task: { title: 'Admin', goal: 'g', acceptance: ['a'], covers: ['R2'] }, key: 'security', changedFiles: ['src/app/admin/page.tsx'], lang: 'Turkish' });
  assert.match(t, /R2 \[claimed by this task\]/);
  assert.match(t, /src\/app\/admin\/page\.tsx/);
  assert.match(t, /Time budget: about 4 minutes/);
  // Yönetici incelemesi: önce kırmayı dener, puan ve karar en sonda; puan kanıtla sınırlanır.
  assert.match(P.reviewSystem('Turkish'), /qualityScore is your overall and can never be higher than the lowest of correctness and robustness/);
  assert.deepStrictEqual(P.REVIEW_SCHEMA.propertyOrdering.slice(0, 2), ['riskAnalysis', 'acceptanceChecks']);
  assert.ok(P.REVIEW_SCHEMA.propertyOrdering.indexOf('verdict') > P.REVIEW_SCHEMA.propertyOrdering.indexOf('findings'), 'karar, bulgulardan sonra yazılır');
  // Süre bütçesi: küçük görev 20 dk, büyük görev 45 dk'da tavanlanır.
  assert.strictEqual(P.taskBudgetMin({ acceptance: ['a'], tests: [] }), 20);
  assert.strictEqual(P.taskBudgetMin({ acceptance: new Array(8).fill('a'), tests: new Array(4).fill('t') }), 45);
  assert.match(P.taskPrompt({ ...job, tasks: [{ id: 't', title: 'T', goal: 'g', details: 'd', acceptance: ['a'] }] }, { id: 't', title: 'T', goal: 'g', details: 'd', acceptance: ['a'] }, '', null), /## Time budget: about 20 minutes/);
});

test('Zip paketi: kaynak ve git içeride; node_modules, derleme ve .env dosyaları dışarıda', async () => {
  const archive = require('../src/main/archive');
  const { execFileSync } = require('child_process');
  const dir = path.join(tmp(), 'Mavi Proje');
  fs.mkdirSync(path.join(dir, 'src', 'build'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.next'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1;');
  fs.writeFileSync(path.join(dir, 'src', 'build', 'maker.ts'), 'export const b = 2;'); // "build" adlı kaynak klasörü
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"p"}');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.next/\n.env\n.env*.local\n*.key\ndev.db\n');
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1');
  fs.writeFileSync(path.join(dir, '.env.local'), 'SECRET=2');
  fs.writeFileSync(path.join(dir, '.env.example'), 'SECRET=');
  fs.writeFileSync(path.join(dir, 'dev.db'), 'sqlite');
  fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'i.js'), '');
  fs.writeFileSync(path.join(dir, '.next', 'b.js'), '');
  fs.writeFileSync(path.join(dir, 'server.key'), 'k');
  fs.writeFileSync(path.join(dir, '.DS_Store'), '');
  if (process.platform !== 'win32') fs.symlinkSync('/etc/hosts', path.join(dir, 'disari'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'ilk'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'src', 'sizinti.ts'), 'const k = "sk_live_GERCEKdeger123";'); // commit'e girmemiş sızıntı
  const found = await archive.collect(dir, { needles: ['sk_live_GERCEKdeger123'] });
  assert.ok(found.files.includes('src/a.ts') && found.files.includes('src/build/maker.ts') && found.files.includes('package.json') && found.files.includes('.env.example'));
  assert.ok(found.gitIncluded && found.files.some((f) => f.startsWith('.git/')));
  assert.ok(!found.files.some((f) => /^(node_modules|\.next)\//.test(f) || ['.env', '.env.local', 'server.key', '.DS_Store', 'dev.db', 'disari', 'src/sizinti.ts'].includes(f)));
  assert.deepStrictEqual(found.leaked, ['src/sizinti.ts']);
  if (process.platform !== 'win32') {
    const out = await archive.zipProject(dir, { outDir: path.dirname(dir), name: 'Mavi Proje', needles: ['sk_live_GERCEKdeger123'] });
    assert.match(path.basename(out.file), /^Mavi-Proje-\d{8}\.zip$/);
    assert.ok(out.size > 0 && out.count === found.files.length);
    const list = execFileSync('unzip', ['-Z1', out.file], { encoding: 'utf8' }).split('\n');
    assert.ok(list.includes('src/a.ts') && !list.includes('.env') && !list.some((f) => f.startsWith('node_modules')) && !list.includes('src/sizinti.ts'));
  }
  // Zip proje klasörünün içine yazılamaz.
  await assert.rejects(() => archive.zipProject(dir, { target: path.join(dir, 'x.zip') }), /kendi klasörüne/);
});

test('Zip paketi: geçmişte gizli dosya ya da değer varsa git geçmişi pakete girmez', async () => {
  const archive = require('../src/main/archive');
  const { execFileSync } = require('child_process');
  const mk = () => {
    const dir = tmp();
    const g = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: dir, encoding: 'utf8' });
    g('init', '-q');
    return { dir, g };
  };
  // (a) .env bir zamanlar commit'lenmiş
  const a = mk();
  fs.writeFileSync(path.join(a.dir, '.env'), 'K=v');
  fs.writeFileSync(path.join(a.dir, 'a.ts'), '1');
  a.g('add', '-A', '-f');
  a.g('commit', '-qm', 'oops');
  a.g('rm', '-q', '--cached', '.env');
  a.g('commit', '-qm', 'untrack');
  let r = await archive.collect(a.dir, {});
  assert.ok(!r.gitIncluded && /gizli dosya/.test(r.gitExcluded) && !r.files.some((f) => f.startsWith('.git/')));
  // (b) gizli değer eski bir commit'te
  const b = mk();
  fs.writeFileSync(path.join(b.dir, 'config.ts'), 'export const t = "tok_LIVE_abcdef123456";');
  b.g('add', '-A');
  b.g('commit', '-qm', 'leak');
  fs.writeFileSync(path.join(b.dir, 'config.ts'), 'export const t = process.env.T;');
  b.g('add', '-A');
  b.g('commit', '-qm', 'fix');
  r = await archive.collect(b.dir, { needles: ['tok_LIVE_abcdef123456'] });
  assert.ok(!r.gitIncluded && /gizli bir değer/.test(r.gitExcluded));
  assert.deepStrictEqual(r.files, ['config.ts']);
  // (c) uzak depo adresinde jeton
  b.g('remote', 'add', 'origin', 'https://user:ghp_x@github.com/x/y.git');
  r = await archive.collect(b.dir, {});
  assert.ok(/kimlik bilgisi/.test(r.gitExcluded));
  // (d) git deposu olmayan klasör: tarama, gizli dosyalar ve bağımlılıklar dışarıda
  const c = tmp();
  fs.mkdirSync(path.join(c, 'node_modules', 'y'), { recursive: true });
  fs.writeFileSync(path.join(c, 'node_modules', 'y', 'i.js'), '1');
  fs.writeFileSync(path.join(c, 'a.js'), '1');
  fs.writeFileSync(path.join(c, '.env.production'), 'X=1');
  fs.writeFileSync(path.join(c, '.npmrc'), '//registry/:_authToken=abc');
  r = await archive.collect(c, {});
  assert.deepStrictEqual(r.files, ['a.js']);
  assert.strictEqual(r.skippedSecrets, 2);
});

test('Bakım işleri: hata teşhisi ve refactor istemleri, kodlayan ajan ve inceleyici kuralları', () => {
  const P = require('../src/main/prompts');
  assert.deepStrictEqual(P.MAINTENANCE_SCHEMA.required, ['summary', 'findings', 'tasks']);
  const plan = { summary: 'Sigorta arama sistemi', stack: ['Next.js'], language: 'Turkish', requirements: [{ id: 'R33', text: 'Aynı anda tek arama' }], spec: 'x' };
  const bug = P.maintenancePlanPrompt({ kind: 'bugfix', text: '1) Durdurunca arama sürüyor\n\n2) CSV Türkçe karakter bozuk', plan, refs: ['docs/sonda/references/hata.png'] });
  assert.match(bug, /Find the ROOT CAUSE/);
  assert.match(bug, /SEVERAL bugs \(numbered\)/);
  assert.match(bug, /regression test that fails before the fix/);
  assert.match(bug, /do not invent one/);
  assert.match(bug, /2\) CSV Türkçe karakter bozuk/);
  assert.match(bug, /docs\/sonda\/references\/hata\.png/);
  assert.match(bug, /R33: Aynı anda tek arama/);
  const ref = P.maintenancePlanPrompt({ kind: 'refactor', text: '', plan: null, existing: 'package.json: …' });
  assert.match(ref, /behavior-preserving/);
  assert.match(ref, /BUGS you notice while reading/);
  assert.match(ref, /No Sonda plan exists for this folder/);
  assert.match(ref, /no specific focus — full code-health pass/);

  const task = { id: 't1', title: 'T', goal: 'g', details: 'd', acceptance: ['a'], tests: ['t'] };
  const mk = (kind) => ({ plan: { ...plan, maintenance: { kind, request: 'istek', summary: 'özet', findings: [] } }, tasks: [task], userNotes: [] });
  const fix = P.taskPrompt(mk('bugfix'), task, '', null);
  assert.match(fix, /Maintenance job: BUG FIX/);
  assert.match(fix, /SEE IT FAIL for the reported reason/);
  assert.ok(!/Refactor tasks are behavior-preserving/.test(fix));
  const rf = P.taskPrompt(mk('refactor'), task, '', null);
  assert.match(rf, /Maintenance job: REFACTOR/);
  assert.match(rf, /WITHOUT changing their assertions/);
  assert.match(rf, /Never weaken, skip or delete an existing test/);
  // Normal işlerde bakım kuralı yok.
  assert.ok(!/Maintenance job/.test(P.taskPrompt({ plan, tasks: [task], userNotes: [] }, task, '', null)));
  assert.match(P.reviewUserText({ job: mk('refactor'), task, agentSummary: '', checks: [], diff: null, files: null, installed: {} }), /Verify behavior preservation/);
  assert.match(P.maintenanceReviewText(mk('bugfix')), /a regression test exists that would fail without the fix/);
  assert.strictEqual(P.maintenanceReviewText({ plan }), '');
});

test('İnceleyici izinleri: birim ve entegrasyon testlerini çalıştırabilir', () => {
  const { REVIEW_ALLOWED } = require('../src/main/agents');
  assert.ok(REVIEW_ALLOWED.includes('Bash(npm run test:integration:*)'));
  assert.ok(REVIEW_ALLOWED.includes('Bash(pnpm run test:unit:*)'));
  assert.ok(!REVIEW_ALLOWED.some((r) => /test:e2e|run dev|install|Bash\(find/.test(r)));
  // Node dışı projelerde de testleri kendisi çalıştırabilir.
  assert.ok(['Bash(pytest:*)', 'Bash(go test:*)', 'Bash(cargo test:*)', 'Bash(pnpm exec vitest:*)', 'Bash(npm run check-types:*)'].every((r) => REVIEW_ALLOWED.includes(r)));
  // Planlayıcı makinedeki araçları ve PyPI sürümlerini yoklayabilir (kurulum ve ağ indirmesi yine yok).
  assert.ok(['Bash(docker --version)', 'Bash(docker compose version)', 'Bash(docker info)', 'Bash(uv --version)', 'Bash(python3 --version)', 'Bash(go version)', 'Bash(pip3 index versions:*)', 'Bash(python3 -m pip index versions:*)'].every((r) => REVIEW_ALLOWED.includes(r)));
  assert.ok(!REVIEW_ALLOWED.some((r) => /curl|wget|docker (run|compose up|exec|pull)|pip3? (download|wheel)/.test(r)));
  // uv / poetry ile çalışan Python projesinde inceleyici testleri kendisi çalıştırabilir; `uv run <herhangi bir şey>` yok.
  assert.ok(['Bash(uv run pytest:*)', 'Bash(uv run python -m pytest:*)', 'Bash(uv run ruff check:*)', 'Bash(uv run mypy:*)', 'Bash(poetry run pytest:*)', 'Bash(.venv/bin/pytest:*)', 'Bash(.venv/bin/python -m pytest:*)'].every((r) => REVIEW_ALLOWED.includes(r)));
  assert.ok(!REVIEW_ALLOWED.some((r) => /^Bash\((uv run|poetry run|\.venv\/bin\/python)(:\*)?\)$|uv run python:\*|uv (pip|add|sync|tool)|--prefix|--directory/.test(r)));
  const P2 = require('../src/main/prompts');
  for (const text of [P2.taskReviewPrompt({ job: { plan: { requirements: [], spec: '', summary: '', stack: [] }, tasks: [], userNotes: [] }, task: { title: 't', goal: 'g', details: 'd', acceptance: [], tests: [], covers: [] }, checks: [], changed: [] }), P2.deepReviewPrompt({ job: { plan: { requirements: [], spec: '', summary: '', stack: [] }, tasks: [], userNotes: [], gates: {} }, scope: 'x', tasks: [], checks: [], smoke: null })]) {
    assert.match(text, /uv run pytest\|ruff check\|mypy[\s\S]*retry it once in a permitted form/);
  }
  assert.match(require('../src/main/prompts').claudePlanPrompt({ base: 'b', head: { projectName: 'p', summary: 's', stack: [], assumptions: [], requirements: [], language: 'Turkish' } }), /pip index versions <package>[\s\S]*docker info\\?`? \(is the daemon running\?\)/);
});

test('Özellik ekleme: projeye uyum kuralları, yeni gereksinim numaraları, inceleyici ölçütü', () => {
  const P = require('../src/main/prompts');
  const plan = { summary: 'Rezervasyon sitesi', stack: ['Next.js'], language: 'Turkish', requirements: [{ id: 'R1', text: 'a' }, { id: 'R37', text: 'b' }], spec: 'x' };
  const t = P.maintenancePlanPrompt({ kind: 'feature', text: 'Rezervasyon iptali', plan });
  assert.match(t, /looks like it was always part of this codebase/);
  assert.match(t, /Learn the house style before designing/);
  assert.match(t, /ids continuing from R38/);
  assert.match(t, /NEW migration \(never edit old ones\)/);
  assert.match(t, /every new requirement must be covered/);
  assert.ok(P.MAINTENANCE_SCHEMA.properties.requirements && P.MAINTENANCE_SCHEMA.properties.specAddendum);
  const task = { id: 't1', title: 'T', goal: 'g', details: 'd', acceptance: ['a'], tests: ['t'] };
  const job = { plan: { ...plan, maintenance: { kind: 'feature', request: 'iptal', summary: 'özet', findings: [] } }, tasks: [task], userNotes: [] };
  const tp = P.taskPrompt(job, task, '', null);
  assert.match(tp, /Maintenance job: FEATURE ADDITION/);
  assert.match(tp, /never write a parallel version of something that exists/);
  assert.match(tp, /every existing test stays green and unmodified/);
  assert.match(P.maintenanceReviewText(job), /Verify the feature FITS the codebase/);
});

test('Simgeler: kullanılan her simge tanımlıdır; metin işaretleri yerine tek dilde (baklava / köşeli) simgeler kullanılır', () => {
  const dir = path.join(__dirname, '..', 'src', 'renderer');
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const files = fs.readdirSync(path.join(dir, 'app')).filter((f) => f.endsWith('.js')).map((f) => [f, fs.readFileSync(path.join(dir, 'app', f), 'utf8')]);
  const defined = new Set([...html.matchAll(/<symbol id="([a-z0-9-]+)"/g)].map((m) => m[1]));
  const used = new Set();
  for (const text of [html, ...files.map(([, t]) => t)]) {
    for (const m of text.matchAll(/href="#([a-z0-9-]+)"/g)) used.add(m[1]);
    for (const m of text.matchAll(/\bico\('([a-z0-9-]+)'\)/g)) used.add(`i-${m[1]}`);
    for (const m of text.matchAll(/\bstIcon\('([a-z0-9-]+)'\)/g)) used.add(`st-${m[1]}`);
  }
  const missing = [...used].filter((id) => !defined.has(id));
  assert.deepStrictEqual(missing, [], `tanımsız simge: ${missing.join(', ')}`);
  // Durum baklavaları ve ayarlar için Selçuklu yıldızı.
  for (const id of ['st-pending', 'st-done', 'st-failed', 'st-half', 'st-skip', 'i-selcuklu']) assert.ok(defined.has(id), id);
  assert.match(html, /id="settingsBtn"[^>]*>\s*<svg[^>]*><use href="#i-selcuklu"\/><\/svg>\s*<\/button>/, 'ayarlar düğmesi yalnızca simge');
  // Eski metin işaretleri arayüz kodunda kalmamalı (günlük satırı çevirisi hariç).
  const stray = [];
  for (const [f, t] of files) {
    for (const g of ['✕', '○', '◐', '↻']) if (t.includes(g)) stray.push(`${f}: ${g}`);
    // Tooltip (title) metinleri düz metindir; ✓ / ✗ yalnızca onlarda ve günlük satırı çevirisinde (logs.js) kalabilir.
    if (f !== 'logs.js' && /[✓✗]/.test(t.replace(/toast\([^)]*\)/g, '').replace(/const tip = [^\n]*/g, ''))) stray.push(`${f}: ✓/✗`);
  }
  for (const g of ['✕', '○', '◐', '↻']) if (html.includes(g)) stray.push(`index.html: ${g}`);
  assert.deepStrictEqual(stray, [], `metin işareti kaldı: ${stray.join('; ')}`);
});
