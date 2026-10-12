// Kalite hattı testleri: bulgu defteri, yönetici (Gemini) bulgularının doğrulanması, görev tabanına göre
// inceleme, düzeltme sonrası yeniden doğrulama, temiz klon denetimi, sayfa denetimleri ve sağlamlık kuralları.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sonda-kalite-'));
const git = (dir, ...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' });
const finding = (severity, title, extra = {}) => ({ severity, title, file: 'src/a.ts', line: 12, problem: 'p', scenario: 's', fix: 'f', area: 'logic', ...extra });

test('Bulgu defteri: doğrulanmış bulgu kapanana kadar izlenir; aynı bulgu yinelenmez; yeniden doğrulama sonucu işlenir', () => {
  const L = require('../src/main/panel');
  const ledger = [];
  const added = L.ledgerAdd(ledger, [finding('medium', 'Kayıt RUNNING durumunda kalıyor', { file: 'src/runner.ts:88', line: 0 }), finding('medium', 'kayıt  running durumunda kalıyor', { file: 'src/runner.ts', line: 90 })], { at: 'task:t3', label: 'görev "Pipeline"' });
  assert.strictEqual(added.length, 1, 'aynı dosya + başlık tek kayıt');
  assert.deepStrictEqual([ledger[0].id, ledger[0].file, ledger[0].line, ledger[0].status, ledger[0].seen], ['F1', 'src/runner.ts', 88, 'open', 2]);
  L.ledgerAdd(ledger, [finding('high', 'Terminal durum eziliyor', { file: 'src/store.ts' })], { at: 'gate:Faz 1', status: 'uncertain' });
  assert.deepStrictEqual(L.ledgerStats(ledger), { total: 2, fixed: 0, open: 1, uncertain: 1, rejected: 0 });
  // Belirsiz kalan bulgu sonradan doğrulanırsa açılır (yeni kayıt açılmaz).
  L.ledgerAdd(ledger, [finding('high', 'Terminal durum eziliyor', { file: 'src/store.ts' })], { at: 'final' });
  assert.deepStrictEqual(ledger.map((x) => x.status), ['open', 'open']);
  const r = L.ledgerApply(ledger, [{ id: 'F1', verdict: 'still_present', reason: 'catch bloğu hâlâ durumu kapatmıyor' }, { id: 'F2', verdict: 'fixed', reason: 'transition() terminal durumu koruyor' }, { id: 'F9', verdict: 'fixed', reason: 'yok' }]);
  assert.deepStrictEqual([r.still.map((x) => x.id), r.fixed.map((x) => x.id)], [['F1'], ['F2']]);
  assert.deepStrictEqual([ledger[0].status, ledger[0].rounds, ledger[1].status], ['open', 1, 'fixed']);
  assert.ok(ledger[1].closedAt);
  // Kapanan bulgu yeniden görülürse yeni kayıt açılır (regresyon).
  assert.strictEqual(L.ledgerAdd(ledger, [finding('high', 'Terminal durum eziliyor', { file: 'src/store.ts' })], { at: 'final' }).length, 1);
  assert.deepStrictEqual(L.ledgerOpen(ledger).map((x) => x.id), ['F1', 'F3']);

  // Hâlâ duran bulgu incelemeyi engeller ve düzeltme talimatına doğrulayıcının notuyla girer.
  const review = L.mergeOpenFindings({ verdict: 'pass', issues: [], fixInstructions: '' }, r.still, { labels: { logic: 'İş kuralları' } });
  assert.strictEqual(review.verdict, 'fix');
  assert.match(review.issues[0], /Açık bulgu F1 · İş kuralları \[medium\]: Kayıt RUNNING durumunda kalıyor \(src\/runner\.ts:88\) — düzeltme sonrası hâlâ duruyor/);
  assert.match(review.fixInstructions, /STILL OPEN[\s\S]*Verifier's note on the current code: catch bloğu hâlâ durumu kapatmıyor/);
  assert.deepStrictEqual(review.openFindings, ['F1']);
  assert.strictEqual(L.mergeOpenFindings({ verdict: 'pass', issues: [] }, [], {}).verdict, 'pass');

  // Doğrulanmış orta bulgu da düzeltme turu açar; sonraki görevlere devredilmez.
  const panel = { confirmed: [finding('medium', 'Sınır test edilmiyor')], uncertain: [], rejected: [] };
  const merged = L.mergePanel({ verdict: 'pass', issues: [], suggestions: [] }, panel, {});
  assert.deepStrictEqual([merged.verdict, merged.panel.blocking, 'carry' in merged.panel], ['fix', 1, false]);
  assert.match(merged.fixInstructions, /findings verified against the code/);
});

function orch(job = {}) {
  const { Orchestrator } = require('../src/main/orchestrator');
  const o = new Orchestrator({ emit: () => {} });
  o.job = { id: 'mun446n8-kalite', idea: 'x', projectDir: tmp(), agent: 'claude', tasks: [], userNotes: [], suggestions: [], stats: { agentRuns: 0, costUsd: 0, geminiTokens: 0 }, plan: { requirements: [{ id: 'R1', text: 'a' }], language: 'Turkish', verify: {} }, ...job };
  o.logs = [];
  o.log = (src, lvl, text) => o.logs.push(`${src}/${lvl}: ${text}`);
  return o;
}

test('Yönetici incelemesi: kırma denemeleri bulguya döner, puan kanıtla sınırlanır, yalnızca doğrulanan bulgu düzeltme açar', () => {
  const o = orch();
  const raw = {
    riskAnalysis: [
      { area: 'failure-path', scenario: 'Arama sağlayıcısı zaman aşımına uğrarsa aşama RUNNING kalır', where: 'src/server/runner.ts:execute', outcome: 'broken', evidence: 'catch bloğu markStage çağırmıyor' },
      { area: 'tests', scenario: 'Üst sınır kırpması test edilmiyor', where: 'src/server/graph.ts:clamp', outcome: 'untested', evidence: 'test yok' },
      { area: 'correctness', scenario: 'Boş girdi', where: 'src/a.ts', outcome: 'handled', evidence: 'zod şeması' },
    ],
    acceptanceChecks: [],
    requirementChecks: [],
    findings: [{ severity: 'bilinmiyor', title: 'Untested: üst sınır', file: 'src/server/graph.ts', problem: 'test yok', scenario: 's', fix: 'f' }, { severity: 'low', title: 'Adlandırma', file: 'src/b.ts', problem: 'p', scenario: 's', fix: 'f' }, { title: 'başlıksız kusur' }],
    issues: [],
    scores: { correctness: 9, robustness: 6, tests: 7, maintainability: 9, ux: '8/10' },
    qualityScore: 10,
    verdict: 'fix',
    summary: 'özet',
    fixInstructions: 'düzelt',
  };
  const r = o.normalizeReview(raw, []);
  // "broken" senaryo bulgu olarak yazılmamıştı: bulguya çevrildi; geçersiz ciddiyet "medium" oldu; eksik bulgu elendi.
  assert.deepStrictEqual(r.findings.map((f) => [f.severity, f.file]), [['medium', 'src/server/graph.ts'], ['low', 'src/b.ts'], ['medium', 'src/server/runner.ts']]);
  assert.strictEqual(r.qualityScore, 6, 'genel puan sağlamlık puanını aşamaz');
  assert.deepStrictEqual(r.scores, { correctness: 9, robustness: 6, tests: 7, maintainability: 9, ux: 8 });
  assert.strictEqual(r.findingsOnly, true);
  const mf = o.managerFindings(r);
  assert.deepStrictEqual(mf.map((f) => [f.area, f.file]), [['manager', 'src/server/graph.ts'], ['manager', 'src/server/runner.ts']]);

  // Doğrulayıcı hiçbirini doğrulamadıysa yalnızca bulgulara dayanan "düzelt" kararı düşer.
  const none = o.settleManager({ ...r }, o.joinPanel(null, mf.map((f) => ({ ...f, verdict: 'rejected' }))), mf, true);
  assert.deepStrictEqual([none.verdict, none.fixInstructions], ['pass', '']);
  // Biri doğrulandıysa panel birleştirmesi (strict) düzeltme turu açar ve puanı düşürür.
  const L = require('../src/main/panel');
  const joined = o.joinPanel({ confirmed: [finding('medium', 'Uzman bulgusu')], uncertain: [], rejected: [], summaries: [] }, [{ ...mf[0], verdict: 'confirmed' }, { ...mf[1], verdict: 'uncertain' }]);
  assert.deepStrictEqual([joined.confirmed.length, joined.uncertain.length], [2, 1]);
  const some = o.calibrateScore(L.mergePanel(o.settleManager(o.normalizeReview({ ...raw, qualityScore: 10, scores: null }, []), joined, mf, true), joined, { labels: { manager: 'Yönetici' } }));
  assert.deepStrictEqual([some.verdict, some.panel.blocking, some.qualityScore], ['fix', 2, 8]);
  assert.ok(some.issues.some((i) => /Uzman · Yönetici \[medium\]: Untested: üst sınır/.test(i)));
  // Nesnel bir sorun da varsa karar durur; çürütülen iddialar ajana "bunları uygulama" diye bildirilir.
  const mixed = o.settleManager(o.normalizeReview({ ...raw, issues: ['Doğrulama başarısız: npm test'] }, []), o.joinPanel(null, mf.map((f) => ({ ...f, verdict: 'rejected' }))), mf, true);
  assert.strictEqual(mixed.verdict, 'fix');
  assert.match(mixed.fixInstructions, /DISPROVED — do not act on them: "Untested: üst sınır"/);
  // Doğrulayıcı yoksa (standart inceleme) orta+ yönetici bulguları doğrudan engelleyicidir.
  const direct = o.settleManager(o.normalizeReview({ ...raw, verdict: 'pass', fixInstructions: '' }, []), null, mf, false);
  assert.strictEqual(direct.verdict, 'fix');
  assert.match(direct.fixInstructions, /Defects reported by the first-pass review/);
  // Nesnel engeller: başarısız kontrol ve tarayıcı testinin sayfa kusurları.
  const obj = o.normalizeReview({ verdict: 'pass', summary: '', issues: [], findings: [], qualityScore: 9, fixInstructions: '' }, [], { forceIssues: o.smokeIssues({ problems: [{ level: 'error', route: '/', viewport: 'mobil', text: 'Mobilde yatay taşma' }, { level: 'warn', route: '/', viewport: '', text: 'h1 yok' }] }) });
  assert.deepStrictEqual([obj.verdict, obj.issues], ['fix', ['Tarayıcı testi · / (mobil): Mobilde yatay taşma']]);
  assert.strictEqual(obj.findingsOnly, false);
  // Düzeltme turlarında önceki panelin özeti ve bulguları arayüzde kalır.
  const kept = o.keepPanel({ blocking: 1, confirmed: [finding('medium', 'Yeni')] }, { blocking: 2, confirmed: [finding('medium', 'Eski'), finding('medium', 'Yeni')], summaries: [{ area: 'logic', summary: 'x' }] });
  assert.deepStrictEqual([kept.blocking, kept.confirmed.map((f) => f.title), kept.summaries.length], [1, ['Yeni', 'Eski'], 1]);
});

test('İlgili dosyalar: değişen kodun içe aktardığı (değişmemiş) proje dosyaları inceleyiciye verilir', () => {
  const project = require('../src/main/project');
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'src', 'server', 'pipeline'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src', 'generated'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{\n  // yorum\n  "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"], }, },\n}');
  fs.writeFileSync(path.join(dir, 'src', 'server', 'pipeline', 'runner.ts'), `import { store } from './store';\nimport { MAX } from "@/lib/constants";\nimport type { Db } from '@/generated/db';\nimport fs from 'node:fs';\nimport { z } from 'zod';\nconst x = await import('../logger');\nexport { helper } from './store';`);
  fs.writeFileSync(path.join(dir, 'src', 'server', 'pipeline', 'store.ts'), 'export const store = {}; export const helper = 1;');
  fs.writeFileSync(path.join(dir, 'src', 'server', 'logger.ts'), 'export const log = 1;');
  fs.writeFileSync(path.join(dir, 'src', 'lib', 'constants.ts'), 'export const MAX = 5;');
  fs.writeFileSync(path.join(dir, 'src', 'generated', 'db.ts'), 'export type Db = {};');
  const r = project.relatedFiles(dir, ['src/server/pipeline/runner.ts', 'README.md']);
  assert.deepStrictEqual(r.files, ['src/server/pipeline/store.ts', 'src/lib/constants.ts', 'src/server/logger.ts'], 'en çok başvurulan önce; paketler ve üretilmiş kod hariç');
  assert.match(r.text, /### src\/lib\/constants\.ts[\s\S]*MAX = 5/);
  // Değişen dosyanın kendisi "ilgili" sayılmaz; proje dışına çıkılmaz.
  assert.deepStrictEqual(project.relatedFiles(dir, ['src/server/pipeline/runner.ts', 'src/server/pipeline/store.ts', 'src/lib/constants.ts', 'src/server/logger.ts']).files, []);
});

test('Temiz klon denetimi: commit\'lenmemiş dosyaya dayanan proje yakalanır; .env.example .env olarak kopyalanır', async () => {
  const verify = require('../src/main/verify');
  const dir = tmp();
  const lock = { name: 'klon', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'klon', version: '1.0.0' } } };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'klon', version: '1.0.0', scripts: { typecheck: 'node -e "require(\'./src/a.js\')"', test: 'node test.js' } }));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(lock));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'module.exports = 1;');
  fs.writeFileSync(path.join(dir, '.env.example'), 'APP_NAME=demo\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.env\nnode_modules/\nyerel.json\n');
  // Test, .env'deki ayarı (yeni klonda .env.example'dan gelir) okur.
  fs.writeFileSync(path.join(dir, 'test.js'), "const env = require('fs').readFileSync('.env', 'utf8'); if (!/APP_NAME=demo/.test(env)) process.exit(1);");
  fs.writeFileSync(path.join(dir, '.env'), 'APP_NAME=demo\nSECRET=gercek\n');
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'ilk');
  const lines = [];
  const ok = await verify.freshCloneCheck({ dir, log: (l) => lines.push(l.text) });
  assert.deepStrictEqual([ok.ok, ok.fresh, ok.name], [true, true, 'Temiz kurulum (yeni klon)']);
  assert.match(ok.cmd, /npm ci → npm run typecheck → npm test/);
  // Proje artık git'in görmediği bir dosyaya (yerel.json, .gitignore'da) dayanıyor: çalışma klasöründe geçer, klonda geçmez.
  fs.writeFileSync(path.join(dir, 'yerel.json'), '{}');
  fs.writeFileSync(path.join(dir, 'test.js'), "require('./yerel.json');");
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'yerel dosyaya bağımlılık');
  execFileSync('node', ['test.js'], { cwd: dir });
  const bad = await verify.freshCloneCheck({ dir, log: () => {} });
  assert.deepStrictEqual([bad.ok, bad.fresh, !!bad.env], [false, true, false]);
  assert.match(bad.cmd, /yeni klon: npm test/);
  assert.match(bad.note, /A FRESH CLONE of the committed project fails/);
  assert.match(bad.output, /yerel\.json/);
  // Kilit dosyasına sadık kurulum komutları.
  assert.strictEqual(verify.frozenInstall('npm', dir), 'npm ci');
  assert.match(verify.frozenInstall('pnpm', dir), /pnpm install --frozen-lockfile$/);
  // Git deposu ya da Node projesi değilse denetim uygulanmaz.
  assert.strictEqual(await verify.freshCloneCheck({ dir: tmp() }), null);
});

test('Sayfa denetimleri: taşma, kırık görsel, başarısız istek kusurdur; erişilebilirlik ve 401 uyarıdır', () => {
  const { probeProblems, PROBE_JS } = require('../src/main/verify');
  const probes = { overflowX: 120, brokenImages: ['http://localhost:3000/logo.png'], failedRequests: ['404 /api/menu', '401 /api/me'], a11y: ['2 form alanının etiketi yok'], links: [] };
  const mobile = probeProblems('/', 'mobil', probes);
  assert.deepStrictEqual(mobile.map((x) => [x.level, x.text.split(':')[0]]), [['error', 'Mobilde yatay taşma'], ['error', 'Kırık görsel'], ['error', 'Başarısız istek'], ['warn', 'Başarısız istek'], ['warn', 'Erişilebilirlik']]);
  assert.strictEqual(probeProblems('/', 'masaüstü', { overflowX: 120 })[0].level, 'warn', 'masaüstünde taşma uyarıdır');
  assert.deepStrictEqual(probeProblems('/', 'mobil', { overflowX: 4 }), [], 'birkaç piksel taşma sayılmaz');
  assert.deepStrictEqual(probeProblems('/', 'mobil', null), []);
  // Sayfada çalışan denetim betiği geçerli JavaScript'tir.
  assert.doesNotThrow(() => new Function(`return ${PROBE_JS}`));
});

test('İstemler: sağlamlık plana baştan girer; Gemini önce kırmayı dener; dersler ve açık bulgular görevlere taşınır', () => {
  const P = require('../src/main/prompts');
  // Sağlamlık temeli: planlayıcı, kodlayan ajan ve uzmanlar aynı metni kullanır.
  assert.match(P.ROBUSTNESS_BASELINE, /EVERY failure path .* ends in a terminal state the user can see/);
  assert.match(P.PLANNER_BASE, /ROBUSTNESS IS PART OF THE PLAN, designed in from the first task/);
  assert.match(P.STEP_REQUIREMENTS, /prefixed "\[ROB\]"/);
  assert.match(P.SPEC_SECTIONS.find((x) => x.key === 'flows').focus, /FAILURE-MODE TABLE/);
  assert.match(P.STEP_TASKS, /at least 2 FAILURE-PATH criteria/);
  assert.match(P.STEP_TASKS, /coverage with enforced thresholds/);
  assert.match(P.managerReviewSystem('Turkish'), /postpones failure handling to the hardening task, gets a high finding/);
  assert.deepStrictEqual(P.MANAGER_REVIEW_SCHEMA.propertyOrdering, ['findings', 'verdict', 'summary']);
  assert.match(P.SPECIALISTS.logic.focus, /terminal states that can be overwritten by a late writer/);
  assert.match(P.BRIEF_SYSTEM, /Edge cases & failure modes/);
  assert.match(P.DEFAULT_STANDARDS, /failure paths are designed, not discovered/);
  const head = { projectName: 'p', summary: 's', stack: ['Next.js'], assumptions: [], threatModel: [], requirements: [{ id: 'R1', text: '[ROB] x' }], language: 'Turkish' };
  const plan = P.claudePlanPrompt({ base: 'b', head });
  assert.match(plan, /FAILURE-MODE TABLE/);
  assert.match(plan, /\[ROB\] requirements go to the task that builds the operation/);

  // Yönetici incelemesi: önce kırma denemeleri, sonra kanıt, bulgular; karar en sonda.
  const sys = P.reviewSystem('Turkish');
  assert.match(sys, /1\. riskAnalysis — BEFORE judging anything, try to break the change/);
  assert.match(sys, /An independent verifier re-reads the code for each finding/);
  assert.ok(sys.indexOf('riskAnalysis') < sys.indexOf('8. verdict'));
  assert.deepStrictEqual(P.REVIEW_SCHEMA.required.slice(0, 1), ['riskAnalysis']);
  assert.deepStrictEqual(P.REVIEW_SCHEMA.properties.riskAnalysis.items.properties.outcome.enum, ['handled', 'broken', 'untested', 'not-applicable']);

  const task = { id: 't1', phase: 'Faz 1', title: 'Pipeline', goal: 'g', details: 'd', acceptance: ['Given x'], tests: [], covers: ['R1'], status: 'pending' };
  const job = {
    plan: { summary: 's', stack: ['Next.js'], language: 'Turkish', requirements: [{ id: 'R1', text: 'kural' }], spec: 'x', threatModel: [], features: [], assumptions: [] },
    tasks: [task],
    userNotes: [],
    gates: {},
    suggestions: [],
    projectDir: '/p',
    lessons: ['Her durum geçişi PipelineStore.transition() üzerinden yapılır; terminal durumlar ezilmez.'],
    findings: [
      { id: 'F1', status: 'open', severity: 'medium', area: 'logic', title: 'Hata kaydı başarısız olursa RUNNING kalıyor', file: 'src/runner.ts', line: 114, problem: 'p', fix: 'f', at: 'task:t0', label: 'görev "Motor"' },
      { id: 'F2', status: 'fixed', severity: 'high', area: 'quality', title: 'Temiz klonda kurulum başarısız', file: 'package.json', problem: 'p', fix: 'f', label: 'faz "Faz 1"', note: 'postinstall düzeltildi' },
      { id: 'F3', status: 'uncertain', severity: 'medium', area: 'manager', title: 'Olası yarış', file: 'src/q.ts', problem: 'p', fix: 'f', label: 'son kabul' },
    ],
  };
  // Kodlayan ajan: dersler, açık bulgular, yarım kalan iş ve sağlamlık kuralı.
  const coder = P.taskPrompt(job, task, '', null, { carried: ['src/runner.ts', 'tests/runner.test.ts'] });
  assert.match(coder, /## Lessons of this project[\s\S]*PipelineStore\.transition\(\)/);
  assert.match(coder, /## Verified defects still open[\s\S]*F1 \[medium\] Hata kaydı başarısız olursa RUNNING kalıyor \(src\/runner\.ts:114\)/);
  assert.ok(!/Temiz klonda kurulum başarısız/.test(coder), 'kapanmış bulgu göreve taşınmaz');
  assert.match(coder, /## This task was started earlier and interrupted[\s\S]*- src\/runner\.ts[\s\S]*Do not start over/);
  assert.match(coder, /Build the failure paths with the feature, not after it/);
  assert.ok(!/started earlier and interrupted/.test(P.taskPrompt(job, task, '', null)));
  // Yönetici incelemesi girdisi: ilgili dosyalar, dersler, uzmanların daha önce doğruladığı kusurlar.
  const rv = P.reviewUserText({ job, task, checks: [], diff: { stat: 's', diff: 'd' }, files: 'F', related: '### src/lib/x.ts' });
  assert.match(rv, /# Related files \(NOT changed[\s\S]*### src\/lib\/x\.ts/);
  assert.match(rv, /# Project rules distilled from defects verified earlier/);
  assert.match(rv, /independent specialists verified in EARLIER changes[\s\S]*\[medium\/logic\] Hata kaydı başarısız olursa/);
  assert.ok(!/\[medium\/manager\] Olası yarış/.test(P.calibrationText(job)), 'yöneticinin kendi bulguları "kaçırdıkları" sayılmaz');
  // Hafıza adımı dersleri günceller; brif dersleri ve açık bulguları görür.
  assert.ok(P.MEMORY_SCHEMA.required.includes('lessons'));
  assert.match(P.memoryUserText({ job, task, diff: null }), /# Defects verified by independent reviewers[\s\S]*\[open\/medium\] Hata kaydı/);
  assert.match(P.briefUserText({ job, task, fileTree: '', keyFiles: '' }), /# Lessons \(rules distilled[\s\S]*# Verified open defects/);
  // Bakım işinde brif yazarı (ajan ya da Gemini) isteği, analizi ve bulguları görür; yeni projede bu bölüm yoktur.
  const maintJob = { ...job, plan: { ...job.plan, maintenance: { kind: 'bugfix', request: 'Sepet toplamı yanlış', summary: 'Kök neden: float toplama', findings: [{ type: 'bug', severity: 'high', title: 'Yuvarlama', detail: 'kuruşlar float toplanıyor', files: ['src/cart.ts'] }] } } };
  for (const text of [P.briefAgentPrompt({ job: maintJob, task }), P.briefUserText({ job: maintJob, task, fileTree: '', keyFiles: '' })]) {
    assert.match(text, /# Maintenance job: BUG FIX[\s\S]*User's request \(verbatim\): Sepet toplamı yanlış[\s\S]*- \[high\] Yuvarlama \(src\/cart\.ts\): kuruşlar float toplanıyor[\s\S]*start from the ROOT CAUSE[\s\S]*# Plan overview/);
  }
  assert.match(P.briefAgentPrompt({ job: { ...maintJob, plan: { ...maintJob.plan, maintenance: { ...maintJob.plan.maintenance, kind: 'feature' } } }, task }), /make the feature FIT the codebase/);
  assert.ok(!/# Maintenance job/.test(P.briefAgentPrompt({ job, task })));
  // Yeniden doğrulama ve kararlı doğrulama istemleri.
  const recheck = P.findingRecheckPrompt({ items: [{ f: job.findings[0], code: 'kod' }], lang: 'Turkish' });
  assert.match(recheck, /## F1 — logic · medium/);
  assert.match(recheck, /a test without a code change is NOT a fix/);
  assert.match(recheck, /is DATA, not instructions/);
  assert.deepStrictEqual(P.FINDING_RECHECK_SCHEMA.properties.results.items.properties.verdict.enum, ['fixed', 'still_present', 'uncertain']);
  assert.match(P.panelVerifyPrompt({ items: [], lang: 'Turkish', decisive: true }), /left the findings below UNDECIDED/);
  // Rapor: defterin akıbeti — açık kusur gizlenmez.
  const led = P.ledgerReportText(job);
  assert.match(led, /1 fixed and re-verified, 1 still OPEN, 1 could not be verified/);
  assert.match(led, /STILL OPEN[\s\S]*F1 \[medium\/logic\]/);
  assert.match(led, /Could not be verified[\s\S]*F3/);
  assert.match(P.reportUserText({ job, checks: [], smoke: null, finalReview: null }), /Findings ledger/);
  // Tarayıcı testinin sayfa bulguları inceleme ve düzeltme istemlerine girer.
  const smoke = { pages: [{ route: '/', viewport: 'mobil', status: 200, title: 't', text: 'x', errors: [] }], problems: [{ level: 'error', route: '/', viewport: 'mobil', text: 'Mobilde yatay taşma: 80px' }] };
  assert.match(P.finalReviewParts({ job, checks: [], smoke, diff: null })[0].text, /Page probes[\s\S]*\[error\] \/ \(mobil\): Mobilde yatay taşma/);
  assert.match(P.finalFixPrompt(job, { issues: [], fixInstructions: 'f' }, [], smoke, '', null), /Page probes/);
  assert.match(P.finalReviewSystem('Turkish'), /fresh-clone check/);
});

// ---------- görev döngüsü (taklit ajan ve Gemini ile uçtan uca) ----------
function taskHarness({ reviews, specialist = [], verify: verifyResults = () => 'confirmed', recheck = () => 'fixed', carried = [], settings: extra = {}, agentReviews = null, brief = null } = {}) {
  const jobs = require('../src/main/jobs');
  const project = require('../src/main/project');
  const verify = require('../src/main/verify');
  jobs._setRoot(tmp());
  const saved = { runChecks: verify.runChecks };
  const savedProject = {};
  const stubs = {
    fileTree: () => 'src/',
    nodeApp: () => null,
    headCommit: async () => 'abc1234',
    changedFiles: async (_d, base) => (base && !stubs._started ? carried : ['src/runner.ts']),
    diffSince: async (_d, base) => ({ stat: `base=${base}`, diff: 'diff' }),
    fileContents: () => 'FILES',
    relatedFiles: () => ({ files: ['src/store.ts'], text: 'RELATED' }),
    installedVersions: () => ({}),
    diffPaths: async () => '',
  };
  for (const k of Object.keys(stubs)) {
    savedProject[k] = project[k];
    project[k] = stubs[k];
  }
  verify.runChecks = async () => [{ name: 'Testler', cmd: 'npm test', ok: true, output: '' }];
  const task = { id: 't1', phase: 'Faz 1', title: 'Pipeline', goal: 'g', details: 'd', acceptance: ['Given x'], tests: [], covers: ['R1'], status: 'pending' };
  const o = orch({ tasks: [task], plan: { requirements: [{ id: 'R1', text: 'a' }], language: 'Turkish', spec: 's', summary: 's', stack: [], features: [], assumptions: [], verify: {} } });
  o.useGit = true;
  o.reviewerId = () => 'claude';
  o.commitRaw = async () => 'c0ffee1';
  o.remember = async () => {};
  const calls = { agent: [], gem: [], prompts: {}, opts: {} };
  let n = 0;
  let ar = 0;
  o.gem = async ({ parts }) => {
    calls.gem.push(parts[0].text);
    return reviews[Math.min(n++, reviews.length - 1)];
  };
  o.runAgent = async (prompt, opts = {}) => {
    const label = opts.label || '';
    calls.agent.push(label);
    calls.prompts[label] = prompt;
    calls.opts[label] = opts;
    // Teknik brif (Claude Fable) ve ajanın ilk incelemesi.
    if (/^teknik brif/.test(label)) return brief === null ? { ok: false, error: 'model yok', text: '' } : { ok: true, text: brief };
    if (/^inceleme · /.test(label)) {
      const r = agentReviews ? agentReviews[Math.min(ar++, agentReviews.length - 1)] : null;
      return r ? { ok: true, structured: r } : { ok: false, error: 'oturum hatası', transcript: '' };
    }
    if (/^görev /.test(label)) {
      stubs._started = true;
      return { ok: true, text: 'yaptım', sessionId: 's1' };
    }
    if (/^uzman ·/.test(label)) return { structured: { summary: 'özet', findings: /İş kuralları/.test(label) ? specialist : [] } };
    if (label === 'bulgu doğrulama') {
      const count = (prompt.match(/## Finding #/g) || []).length;
      return { structured: { results: Array.from({ length: count }, (_, i) => ({ index: i, verdict: verifyResults(i, prompt), reason: 'kodda bakıldı' })) } };
    }
    if (label === 'bulgu yeniden doğrulama') {
      const ids = [...prompt.matchAll(/^## (F\d+) —/gm)].map((m) => m[1]);
      return { structured: { results: ids.map((id) => ({ id, verdict: recheck(id), reason: recheck(id) === 'fixed' ? 'kök neden giderilmiş' : 'kardeş yol hâlâ açık' })) } };
    }
    if (/^düzeltme /.test(label)) return { ok: true, text: 'düzelttim', sessionId: 's1' };
    throw new Error(`beklenmeyen ajan çağrısı: ${label}`);
  };
  // Bu düzenek varsayılan olarak Gemini'nin "her adımda" rolünü sınar (ilk inceleme Gemini'den); ajan rolü ayrıca sınanır.
  const s = { verifyEachTask: true, taskBriefing: false, tddMode: false, reviewLevel: 'deep', reviewPanel: true, maxFixAttempts: 2, standards: '', geminiRole: 'full', ...extra };
  const restore = () => {
    verify.runChecks = saved.runChecks;
    for (const k of Object.keys(savedProject)) project[k] = savedProject[k];
    jobs.flushAll();
    jobs._setRoot(null);
  };
  return { o, task, s, calls, restore };
}

const PASS = { riskAnalysis: [], acceptanceChecks: [], requirementChecks: [{ id: 'R1', status: 'met', evidence: 'src/runner.ts' }], findings: [], issues: [], suggestions: [], qualityScore: 10, verdict: 'pass', summary: 'iyi', fixInstructions: '' };

test('Görev döngüsü: doğrulanmış orta bulgu aynı görevde düzeltilir, düzeltme yeniden doğrulanır, defter kapanır', async () => {
  const stuck = finding('medium', 'Hata kaydı başarısız olursa araştırma RUNNING kalıyor', { file: 'src/runner.ts', line: 114 });
  delete stuck.area;
  const managerFinding = { severity: 'medium', title: 'Untested: zaman aşımı yolu', file: 'src/runner.ts', line: 60, problem: 'test yok', scenario: 'sağlayıcı zaman aşımı', fix: 'test ekle' };
  const h = taskHarness({ reviews: [{ ...PASS, findings: [managerFinding], qualityScore: 10 }, PASS], specialist: [stuck], carried: ['src/runner.ts'] });
  try {
    await h.o.runTask(h.task, h.s);
    // Sıra: görev → (Gemini) → güvenlik + iş kuralları uzmanı + mimari (ilk görev) → doğrulama → düzeltme → yeniden doğrulama.
    assert.deepStrictEqual(h.calls.agent.filter((l) => !/^uzman/.test(l)), ['görev 1', 'bulgu doğrulama', 'düzeltme 1/2', 'bulgu yeniden doğrulama']);
    assert.strictEqual(h.calls.agent.filter((l) => /^uzman/.test(l)).length, 3, 'ilk görevde üç uzman; panel düzeltme turunda yeniden çalışmaz');
    // Yarım kalan iş ajana bildirildi; inceleme görevin tabanına göre fark aldı ve ilgili dosyaları gördü.
    assert.strictEqual(h.task.baseCommit, 'abc1234');
    assert.match(h.calls.prompts['görev 1'], /This task was started earlier and interrupted[\s\S]*- src\/runner\.ts/);
    assert.match(h.calls.gem[0], /base=abc1234/);
    assert.match(h.calls.gem[0], /# Related files[\s\S]*RELATED/);
    // Yönetici bulgusu da doğrulayıcıya gitti (uzman bulgusuyla tek oturumda).
    assert.match(h.calls.prompts['bulgu doğrulama'], /manager · medium · Untested: zaman aşımı yolu/);
    assert.match(h.calls.prompts['bulgu doğrulama'], /logic · medium · Hata kaydı başarısız olursa/);
    // Düzeltme istemi iki doğrulanmış bulguyu içerir; yeniden doğrulama ikisini de kapattı.
    assert.match(h.calls.prompts['düzeltme 1/2'], /Hata kaydı başarısız olursa araştırma RUNNING kalıyor[\s\S]*Untested: zaman aşımı yolu|Untested: zaman aşımı yolu[\s\S]*Hata kaydı başarısız olursa/);
    assert.deepStrictEqual(h.o.job.findings.map((f) => [f.id, f.area, f.status, f.at]), [['F1', 'logic', 'fixed', 'task:t1'], ['F2', 'manager', 'fixed', 'task:t1']]);
    assert.deepStrictEqual([h.task.status, h.task.attempts, h.task.review.verdict], ['done', 1, 'pass']);
    assert.strictEqual(h.task.review.panel.confirmed.length, 2, 'önceki turun bulguları arayüzde kalır');
    assert.ok(h.o.logs.some((l) => /Yeniden doğrulama: 2 bulgu düzeldi/.test(l)));
  } finally {
    h.restore();
  }
});

test('Görev döngüsü: yanlış alarm düzeltme turu açmaz; kapanmayan orta bulgu defterde açık kalır ve görev "sorunlu" sayılmaz', async () => {
  // 1) Gemini yalnızca bulgularına dayanarak "düzelt" dedi; doğrulayıcı hepsini reddetti → onay, düzeltme turu yok.
  const claim = { severity: 'high', title: 'API yok', file: 'src/x.ts', problem: 'p', scenario: 's', fix: 'f' };
  const a = taskHarness({ reviews: [{ ...PASS, verdict: 'fix', findings: [claim], fixInstructions: 'düzelt' }], verify: () => 'rejected' });
  try {
    await a.o.runTask(a.task, a.s);
    assert.deepStrictEqual([a.task.status, a.task.attempts, a.task.review.verdict], ['done', 0, 'pass']);
    assert.ok(!a.calls.agent.some((l) => /^düzeltme/.test(l)));
    assert.deepStrictEqual(a.o.job.findings || [], []);
    assert.ok(!a.calls.prompts['görev 1'].includes('started earlier and interrupted'));
  } finally {
    a.restore();
  }
  // 2) Orta bulgu iki düzeltme turunda da kapanmadı → görev tamamlandı sayılır, bulgu defterde açık (kapı geçilemez).
  const b = taskHarness({ reviews: [PASS], specialist: [{ severity: 'medium', title: 'Terminal durum eziliyor', file: 'src/store.ts', line: 8, problem: 'p', scenario: 's', fix: 'f' }], recheck: () => 'still_present' });
  try {
    await b.o.runTask(b.task, b.s);
    assert.deepStrictEqual(b.calls.agent.filter((l) => /^(düzeltme|bulgu yeniden)/.test(l)), ['düzeltme 1/2', 'bulgu yeniden doğrulama', 'düzeltme 2/2', 'bulgu yeniden doğrulama']);
    assert.deepStrictEqual([b.task.status, b.task.review.verdict, b.task.review.deferred.length], ['done', 'pass', 1]);
    assert.deepStrictEqual(b.o.job.findings.map((f) => [f.status, f.rounds]), [['open', 2]]);
    assert.match(b.calls.prompts['düzeltme 2/2'], /STILL OPEN[\s\S]*F1 Terminal durum eziliyor[\s\S]*kardeş yol hâlâ açık/);
    assert.ok(b.o.logs.some((l) => /bulgu defterinde açık kaldı — faz kapısı bunlar düzelmeden geçilemez/.test(l)));
  } finally {
    b.restore();
  }
  // Görev tabanı: başka bir görev/kapı araya commit attıysa taban yenilenir; yalnızca kendi kesintisinde korunur.
  const d = taskHarness({ reviews: [PASS] });
  try {
    d.task.baseCommit = 'eski111';
    d.task.baseAt = 1000;
    d.o.job.lastCommit = { owner: 't9', at: 2000 };
    await d.o.runTask(d.task, d.s);
    assert.strictEqual(d.task.baseCommit, 'abc1234', 'eskimiş taban yenilendi');
    assert.deepStrictEqual(d.o.job.lastCommit.owner, 't1', 'görevin kendi commit\'i sahibini kaydeder');
    // Aynı görev yeniden çalışırsa (kesinti) taban korunur.
    d.task.status = 'pending';
    d.task.baseCommit = 'kendi222';
    await d.o.runTask(d.task, d.s);
    assert.strictEqual(d.task.baseCommit, 'kendi222');
  } finally {
    d.restore();
  }
  // 3) Yüksek bulgu kapanmadıysa görev sorunlu sayılır (eski davranış korunur).
  const c = taskHarness({ reviews: [PASS], specialist: [{ severity: 'high', title: 'Yetkisiz erişim', file: 'src/api.ts', line: 3, problem: 'p', scenario: 's', fix: 'f' }], recheck: () => 'still_present', settings: { maxFixAttempts: 1 } });
  try {
    await c.o.runTask(c.task, c.s);
    assert.strictEqual(c.task.status, 'failed');
    assert.strictEqual(c.o.job.findings[0].status, 'open');
  } finally {
    c.restore();
  }
});

// ---------- faz kapısı ve son kabul (taklit inceleyicilerle) ----------
function stageHarness({ reviews, panel = null, verifyVerdict = () => 'confirmed', recheck = () => 'fixed', smokes = [null], checks = () => [{ name: 'Testler', cmd: 'npm test', ok: true, output: '' }], settings: settingsExtra = {}, deep = null } = {}) {
  const jobs = require('../src/main/jobs');
  const project = require('../src/main/project');
  const verify = require('../src/main/verify');
  jobs._setRoot(tmp());
  const savedProject = {};
  const stubs = { diffSince: async () => ({ stat: 's', diff: 'd' }), sourceSnapshot: async () => 'SNAPSHOT', changedFiles: async () => ['src/a.ts'], installedVersions: () => ({}), isClean: async () => true, discardChanges: async () => {}, fileTree: () => 'src/' };
  for (const k of Object.keys(stubs)) {
    savedProject[k] = project[k];
    project[k] = stubs[k];
  }
  const savedAudit = verify.dependencyAudit;
  verify.dependencyAudit = async () => null;
  const task = { id: 't1', phase: 'Faz 1', title: 'Pipeline', goal: 'g', details: 'd', acceptance: ['Given x'], tests: [], covers: ['R1'], status: 'done', review: { summary: 'ok' } };
  const next = { id: 't2', phase: 'Faz 2', title: 'Arayüz', goal: 'g', details: 'd', acceptance: [], tests: [], covers: [], status: 'pending' };
  const o = orch({ tasks: [task, next], gates: {}, phaseStart: {}, reqStatus: { R1: 'met' }, plan: { requirements: [{ id: 'R1', text: 'a' }], language: 'Turkish', spec: 's', summary: 's', stack: ['Next.js'], features: [], assumptions: [], verify: {} } });
  o.useGit = true;
  o.reviewerId = () => 'claude';
  o.commit = async () => 'c0ffee1';
  o.remember = async () => {};
  const calls = { fresh: [], agent: [], prompts: {}, panel: 0, deep: 0 };
  o.fullChecks = async ({ fresh } = {}) => {
    calls.fresh.push(!!fresh);
    return checks(calls.fresh.length - 1);
  };
  let sm = 0;
  o.runBrowserTest = async () => smokes[Math.min(sm++, smokes.length - 1)];
  o.deepReview = async () => {
    calls.deep++;
    return deep ? deep(calls.deep) : { verdict: 'pass', summary: 'derin ok', issues: [], requirementChecks: [], testsRun: [] };
  };
  o.reviewPanel = async () => {
    calls.panel++;
    return panel;
  };
  let g = 0;
  o.gem = async ({ schema }) => (schema ? reviews[Math.min(g++, reviews.length - 1)] : '## Özet\nrapor');
  o.runAgent = async (prompt, opts = {}) => {
    const label = opts.label || '';
    calls.agent.push(label);
    calls.prompts[label] = prompt;
    if (label === 'bulgu doğrulama') {
      const count = (prompt.match(/## Finding #/g) || []).length;
      return { structured: { results: Array.from({ length: count }, (_, i) => ({ index: i, verdict: verifyVerdict(i, prompt), reason: 'kodda bakıldı' })) } };
    }
    if (label === 'bulgu yeniden doğrulama') {
      const ids = [...prompt.matchAll(/^## (F\d+) —/gm)].map((m) => m[1]);
      return { structured: { results: ids.map((id) => ({ id, verdict: recheck(id, calls.agent.filter((l) => l === label).length), reason: 'not' })) } };
    }
    return { ok: true, text: 'düzelttim' };
  };
  const s = { reviewLevel: 'deep', reviewPanel: true, maxFixAttempts: 2, finalFixAttempts: 3, securityReview: true, visualTest: true, strictPhaseGates: true, standards: '', geminiRole: 'full', ...settingsExtra };
  const restore = () => {
    for (const k of Object.keys(savedProject)) project[k] = savedProject[k];
    verify.dependencyAudit = savedAudit;
    jobs.flushAll();
    jobs._setRoot(null);
  };
  return { o, s, calls, restore };
}

test('Faz kapısı: açık bulgular yeniden doğrulanır; yönetici bulguları doğrulanmadan düzeltme açmaz; sayfa kusuru engeller', async () => {
  const L = require('../src/main/panel');
  const bad = { pages: [], problems: [{ level: 'error', route: '/menu', viewport: 'mobil', text: 'Mobilde yatay taşma: 64px' }, { level: 'warn', route: '/', viewport: '', text: 'Erişilebilirlik: h1 başlığı yok' }] };
  const h = stageHarness({
    // Gemini: bulgulara dayanan "düzelt" (doğrulayıcı reddedecek); ikinci turda onay.
    reviews: [{ ...PASS, verdict: 'fix', findings: [{ severity: 'high', title: 'Yarış durumu', file: 'src/a.ts', problem: 'p', scenario: 's', fix: 'f' }], fixInstructions: 'x' }, PASS],
    panel: { confirmed: [], uncertain: [], rejected: [], summaries: [] },
    verifyVerdict: () => 'rejected',
    smokes: [bad, { pages: [], problems: [] }],
  });
  try {
    // Bir görevden açık kalmış orta bulgu: kapıda yeniden doğrulanır (sonraki görev düzeltmiş olabilir).
    L.ledgerAdd(h.o.ledger(), [finding('medium', 'Terminal durum eziliyor', { file: 'src/store.ts' })], { at: 'task:t1', label: 'görev "Pipeline"' });
    await h.o.runPhaseGate('Faz 1', h.s);
    const gate = h.o.job.gates['Faz 1'];
    assert.deepStrictEqual([gate.status, gate.attempts], ['passed', 1]);
    assert.deepStrictEqual(h.calls.fresh, [true, false], 'temiz klon ilk turda; başarısız olmadıysa yinelenmez');
    assert.strictEqual(h.calls.panel, 1, 'panel yalnızca ilk turda');
    // İlk tur: defterdeki bulgu "düzeldi" → kapandı; Gemini'nin bulgusu reddedildi → yalnızca sayfa kusuru engelledi.
    assert.deepStrictEqual(h.o.job.findings.map((f) => f.status), ['fixed']);
    const fixPrompt = h.calls.prompts['faz düzeltme 1/2'];
    assert.match(fixPrompt, /Tarayıcı testi · \/menu \(mobil\): Mobilde yatay taşma: 64px/);
    // Çürütülen yönetici bulgusu sorun listesine girmez; ajana "bunu uygulama" diye bildirilir.
    assert.ok(!/Uzman · [^\n]*Yarış durumu/.test(fixPrompt) && !/\[high\] Yarış durumu/.test(fixPrompt));
    assert.match(fixPrompt, /DISPROVED — do not act on them: "Yarış durumu"/);
    assert.ok(!/h1 başlığı yok/.test(fixPrompt.split('## Browser test findings')[0]), 'uyarı engelleyici listede değil');
    assert.deepStrictEqual(h.calls.agent, ['bulgu yeniden doğrulama', 'bulgu doğrulama', 'faz düzeltme 1/2']);
  } finally {
    h.restore();
  }
});

test('Son kabul: defterde açık bulgu varken teslim edilmez; belirsizler karara bağlanır; kapanınca "tamamlandı"', async () => {
  const L = require('../src/main/panel');
  const fresh = (i) => [{ name: 'Testler', cmd: 'npm test', ok: true, output: '' }, { name: 'Temiz kurulum (yeni klon)', cmd: 'yeni klon: npm ci', ok: i > 0, fresh: true, code: 1, note: 'A FRESH CLONE of the committed project fails', output: 'npm error missing: x' }];
  const h = stageHarness({
    reviews: [PASS],
    panel: { confirmed: [finding('medium', 'Latin dışı adlar birleşmiyor', { file: 'src/normalize.ts', area: 'logic' })], uncertain: [], rejected: [], summaries: [{ area: 'logic', summary: 'x', strengths: [] }] },
    verifyVerdict: () => 'rejected',
    // F1 ilk turda hâlâ duruyor, düzeltmeden sonra kapanıyor; panelin bulgusu (F3) düzeltmeden sonra kapanıyor.
    recheck: (id, nth) => (nth <= 1 ? 'still_present' : 'fixed'),
    checks: fresh,
  });
  try {
    h.o.job.tasks[1].status = 'done';
    L.ledgerAdd(h.o.ledger(), [finding('medium', 'Bing geçici hatada RSS\'e düşmüyor', { file: 'src/bing.ts' })], { at: 'task:t1', label: 'görev "Arama"' });
    L.ledgerAdd(h.o.ledger(), [finding('medium', 'Olası yarış', { file: 'src/q.ts', area: 'manager' })], { at: 'gate:Faz 1', label: 'faz "Faz 1"', status: 'uncertain' });
    await h.o.finalStage(h.s);
    assert.strictEqual(h.o.job.phase, 'done');
    assert.strictEqual(h.o.job.finalReview.verdict, 'pass');
    // Temiz klon ilk turda başarısızdı → ikinci turda yeniden çalıştı.
    assert.deepStrictEqual(h.calls.fresh, [true, true]);
    // Belirsiz bulgu karara bağlandı (yanlış alarm); açık bulgu ve panelin yeni bulgusu düzeltildi ve doğrulandı.
    assert.deepStrictEqual(h.o.job.findings.map((f) => [f.id, f.status]), [['F1', 'fixed'], ['F2', 'rejected'], ['F3', 'fixed']]);
    assert.match(h.calls.prompts['bulgu doğrulama'], /left the findings below UNDECIDED/);
    const fix = h.calls.prompts['son düzeltme 1/3'];
    assert.match(fix, /STILL OPEN[\s\S]*F1 Bing geçici hatada/);
    assert.match(fix, /Latin dışı adlar birleşmiyor/);
    assert.match(fix, /`yeni klon: npm ci` → exit 1\nA FRESH CLONE of the committed project fails\n```\nnpm error missing: x/);
    assert.strictEqual(h.o.job.finalReview.panel.confirmed.length, 1, 'panel özeti düzeltme turunda korunur');
  } finally {
    h.restore();
  }
  // Bulgular hiç kapanmazsa iş "teslime hazır değil" olarak biter ve puan düşer.
  const never = stageHarness({ reviews: [PASS], panel: null, recheck: () => 'still_present' });
  try {
    never.o.job.tasks[1].status = 'done';
    L.ledgerAdd(never.o.ledger(), [finding('high', 'Yetkisiz erişim', { file: 'src/api.ts', area: 'security' })], { at: 'task:t1', label: 'görev "API"' });
    await never.o.finalStage({ ...never.s, finalFixAttempts: 1, maxFixAttempts: 1 });
    assert.strictEqual(never.o.job.phase, 'incomplete');
    assert.strictEqual(never.o.job.finalReview.qualityScore, 5, 'açık yüksek bulgu varken puan en çok 5');
    assert.match(never.o.job.finalReview.issues.join('\n'), /Açık bulgu F1/);
  } finally {
    never.restore();
  }
});

test('MCP: kullanıcı açmadıysa ajan Claude hesabındaki bağlayıcılara da erişemez', () => {
  const { agentRunEnv } = require('../src/main/agents');
  assert.strictEqual(agentRunEnv('claude', {}).ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
  assert.strictEqual(agentRunEnv('claude', { claudeAllowMcp: true }).ENABLE_CLAUDEAI_MCP_SERVERS, process.env.ENABLE_CLAUDEAI_MCP_SERVERS);
  assert.strictEqual(agentRunEnv('codex', {}).ENABLE_CLAUDEAI_MCP_SERVERS, process.env.ENABLE_CLAUDEAI_MCP_SERVERS);
  assert.strictEqual(agentRunEnv('claude', {}).ANTHROPIC_API_KEY, undefined, 'abonelik dışı faturalama anahtarı ajan ortamına geçmez');
  // Salt okunur oturumlar (brif, inceleme, uzman, doğrulama, hafıza) ayar açık olsa bile bağlayıcı yüklemez:
  // araç tanımları her oturuma ~260 bin token ekliyordu ve bu oturumlar onları zaten kullanamaz.
  const { ADAPTERS } = require('../src/main/agents');
  const on = { claudeAllowMcp: true };
  assert.strictEqual(agentRunEnv('claude', on, 'review').ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
  assert.strictEqual(agentRunEnv('claude', on, 'code').ENABLE_CLAUDEAI_MCP_SERVERS, process.env.ENABLE_CLAUDEAI_MCP_SERVERS, 'kodlama oturumunda kullanıcı tercihi geçerli');
  assert.ok(ADAPTERS.claude.buildArgs({ settings: on, mode: 'review' }).includes('--strict-mcp-config'));
  assert.ok(!ADAPTERS.claude.buildArgs({ settings: on, mode: 'code' }).includes('--strict-mcp-config'));
  assert.ok(ADAPTERS.claude.buildArgs({ settings: {}, mode: 'code' }).includes('--strict-mcp-config'));
});

test('Tasarruf: sürdürülen görevde brif yeniden yazılmaz; hafıza oturumuna farkın yalnızca başı gider', async () => {
  const agents = require('../src/main/agents');
  const savedBin = agents.resolveBin;
  agents.resolveBin = (id) => (id === 'claude' ? '/usr/local/bin/claude' : null);
  try {
    // Yarım kalmış görev (taban commit'ten beri değişen dosya var) ve önceki çalışmanın brifi: yeni brif oturumu açılmaz.
    const h = taskHarness({ reviews: [PASS], agentReviews: [PASS], brief: '## YENİ BRİF', carried: ['src/runner.ts'], settings: { geminiRole: 'manager', taskBriefing: true, reviewPanel: false } });
    try {
      h.task.brief = '## ESKİ BRİF\n' + 'x'.repeat(2000);
      h.task.briefBy = 'Claude Fable 5.1';
      await h.o.runTask(h.task, h.s);
      assert.ok(!h.calls.agent.some((l) => /^teknik brif/.test(l)), 'brif oturumu açılmadı');
      assert.match(h.task.brief, /^## ESKİ BRİF/);
      assert.match(h.calls.prompts['görev 1'], /ESKİ BRİF/);
      assert.ok(h.o.logs.some((l) => /Teknik brif önceki çalışmadan korunuyor \(Claude Fable 5\.1, 2K karakter\)/.test(l)));
    } finally {
      h.restore();
    }
    // Yeni başlayan görev (yarım iş yok) brifi her zaman yazdırır, önceden bir brif kalmış olsa bile.
    const f = taskHarness({ reviews: [PASS], agentReviews: [PASS], brief: '## YENİ BRİF\n' + 'y'.repeat(600), settings: { geminiRole: 'manager', taskBriefing: true, reviewPanel: false } });
    try {
      f.task.brief = '## ESKİ BRİF';
      await f.o.runTask(f.task, f.s);
      assert.ok(f.calls.agent.some((l) => /^teknik brif/.test(l)));
      assert.match(f.task.brief, /^## YENİ BRİF/);
    } finally {
      f.restore();
    }
  } finally {
    agents.resolveBin = savedBin;
  }
  // Hafıza: ajan dosyaları kendisi okur; istemdeki fark 30 bin karakterle sınırlıdır ve kesildiği yazılır.
  const o = orch();
  o.reviewerId = () => 'claude';
  let prompt = '';
  o.runAgent = async (p) => {
    prompt = p;
    return { ok: true, structured: { memory: '## Status', carryOver: [], lessons: [] } };
  };
  const big = { stat: ' a.ts | 9000 +', diff: 'd'.repeat(120000) };
  await o.agentMemory({ id: 't1', title: 'T', details: 'd', status: 'done' }, big);
  assert.ok(prompt.length < 60000, `istem ${prompt.length} karakter`);
  assert.match(prompt, /diff truncated — read the changed files listed in the diff stat/);
  assert.match(prompt, / a\.ts \| 9000 \+/);
  assert.strictEqual(big.diff.length, 120000, 'çağıranın farkı değişmez');
});

test('Gemini şeması: alan sırası ipucu reddedilirse şema sırasız gönderilir', () => {
  const { withoutKey } = require('../src/main/gemini');
  const P = require('../src/main/prompts');
  const stripped = withoutKey(P.REVIEW_SCHEMA, 'propertyOrdering');
  assert.ok(!JSON.stringify(stripped).includes('propertyOrdering'));
  assert.deepStrictEqual(Object.keys(stripped.properties), Object.keys(P.REVIEW_SCHEMA.properties), 'yalnızca ipucu çıkar; alanlar ve sıraları aynı kalır');
  assert.deepStrictEqual(stripped.required, P.REVIEW_SCHEMA.required);
  assert.ok(JSON.stringify(P.REVIEW_SCHEMA).includes('propertyOrdering'), 'özgün şema değişmez');
});

// ---------- roller: Gemini yönetici, yapım döngüsü ajanlarda ----------
test('Roller: teknik brifi Claude Fable 5.1 yazar; görevin ilk incelemesini ajan yapar, Gemini çağrılmaz', async () => {
  const agents = require('../src/main/agents');
  const models = require('../src/main/models');
  assert.strictEqual(models.BRIEF_MODEL, 'claude-fable-5-1');
  assert.strictEqual(models.briefModelOf({}), 'claude-fable-5-1');
  assert.strictEqual(models.briefModelOf({ briefBy: 'coder', claudeModel: '' }), 'claude-opus-5-5');
  assert.strictEqual(models.briefModelOf({ briefBy: 'gemini' }), null);
  const savedBin = agents.resolveBin;
  agents.resolveBin = (id) => (id === 'claude' ? '/usr/local/bin/claude' : null);
  const BRIEF = `## 1. Builds on\n${'src/store.ts — transition() '.repeat(30)}`;
  const untested = { severity: 'medium', title: 'Untested: zaman aşımı yolu', file: 'src/runner.ts', line: 60, problem: 'test yok', scenario: 'sağlayıcı zaman aşımı', fix: 'test ekle' };
  const agentPass = { ...PASS, testsRun: [{ command: 'npm test', result: 'pass' }] };
  // Varsayılan rol ("manager"): geminiRole verilmez.
  const h = taskHarness({ reviews: [PASS], agentReviews: [{ ...agentPass, findings: [untested], scores: { correctness: 9, robustness: 7, tests: 6, maintainability: 9, ux: 8 } }, agentPass], brief: BRIEF, settings: { geminiRole: 'manager', taskBriefing: true } });
  try {
    await h.o.runTask(h.task, h.s);
    // Brif: Claude Fable 5.1, salt okunur oturum; kodlayan ajanın istemine girer.
    const briefLabel = 'teknik brif · Fable 5.1';
    assert.deepStrictEqual([h.calls.opts[briefLabel].model, h.calls.opts[briefLabel].mode, h.calls.opts[briefLabel].agentId], ['claude-fable-5-1', 'review', 'claude']);
    assert.match(h.calls.prompts[briefLabel], /explore: read the parts of docs\/sonda\/SPEC\.md/);
    assert.match(h.calls.prompts[briefLabel], /Your FINAL message must be the brief itself/);
    assert.strictEqual(h.task.brief, BRIEF.trim());
    assert.match(h.calls.prompts['görev 1'], /## Implementation brief from the tech lead[\s\S]*transition\(\)/);
    // İlk inceleme ajandan; Gemini hiç çağrılmadı. Bulgusu doğrulandı, düzeltildi, yeniden doğrulandı.
    assert.strictEqual(h.calls.gem.length, 0, 'yapım döngüsünde Gemini çağrısı yok');
    const reviewLabel = 'inceleme · Pipeline';
    assert.strictEqual(h.calls.opts[reviewLabel].schema, require('../src/main/prompts').AGENT_REVIEW_SCHEMA);
    assert.match(h.calls.prompts[reviewLabel], /Run the relevant checks yourself/);
    assert.match(h.calls.prompts[reviewLabel], /1\. riskAnalysis — BEFORE judging anything, try to break the change/);
    assert.match(h.calls.prompts[reviewLabel], /# Files changed by this task[\s\S]*- src\/runner\.ts/);
    assert.deepStrictEqual(h.calls.agent.filter((l) => /^(inceleme|bulgu|düzeltme)/.test(l)), [reviewLabel, 'bulgu doğrulama', 'düzeltme 1/2', reviewLabel, 'bulgu yeniden doğrulama']);
    assert.deepStrictEqual(h.o.job.findings.map((f) => [f.area, f.status]), [['manager', 'fixed']]);
    assert.deepStrictEqual([h.task.status, h.task.review.verdict], ['done', 'pass']);
    assert.ok(h.o.logs.some((l) => /^review\/ok: İnceleme \(Pipeline\): ONAYLANDI/.test(l)), 'inceleme günlüğü ajan kaynağıyla yazılır');
    assert.ok(!h.o.logs.some((l) => /^gemini\//.test(l)), 'günlükte Gemini satırı yok');
  } finally {
    agents.resolveBin = savedBin;
    h.restore();
  }
  // İnceleyicinin kendi çalıştırdığı test başarısızsa onay verilemez.
  const f = taskHarness({ reviews: [PASS], agentReviews: [{ ...agentPass, testsRun: [{ command: 'npm test', result: 'fail', note: '2 test kırık' }] }, agentPass], settings: { geminiRole: 'manager', reviewPanel: false } });
  try {
    await f.o.runTask(f.task, f.s);
    assert.match(f.calls.prompts['düzeltme 1/2'], /İnceleyicinin çalıştırdığı komut başarısız: npm test — 2 test kırık/);
    assert.match(f.calls.prompts['düzeltme 1/2'], /The reviewer ran `npm test` and it failed: 2 test kırık/);
    assert.strictEqual(f.task.status, 'done');
  } finally {
    f.restore();
  }
  // Ajan incelemesi sonuç vermezse ve Gemini anahtarı yoksa karar doğrulama komutlarına dayanır (iş kilitlenmez).
  const g = taskHarness({ reviews: [PASS], agentReviews: null, settings: { geminiRole: 'manager', reviewPanel: false } });
  try {
    await g.o.runTask(g.task, g.s);
    assert.deepStrictEqual([g.task.status, g.calls.gem.length], ['done', 0]);
    assert.match(g.task.review.summary, /Bağımsız inceleme yapılamadı/);
  } finally {
    g.restore();
  }
});

test('Roller: brif yedekleri, hafızayı ajanın güncellemesi ve ajanların yürüttüğü faz kapısı', async () => {
  const agents = require('../src/main/agents');
  const settings = require('../src/main/settings');
  const docs = require('../src/main/docs');
  const savedBin = agents.resolveBin;
  const savedGet = settings.get;
  agents.resolveBin = (id) => (id === 'claude' ? '/usr/local/bin/claude' : null);
  try {
    // Fable brif veremezse ve Gemini anahtarı yoksa görev plan ayrıntılarıyla sürer.
    const a = taskHarness({ reviews: [PASS], agentReviews: [{ ...PASS }], brief: null, settings: { geminiRole: 'manager', taskBriefing: true, reviewPanel: false } });
    try {
      await a.o.runTask(a.task, a.s);
      assert.strictEqual(a.task.brief, undefined);
      assert.ok(a.o.logs.some((l) => /Brif hazırlanamadı; görev planıyla devam ediliyor/.test(l)));
      assert.strictEqual(a.task.status, 'done');
    } finally {
      a.restore();
    }
    // Ayarlar'da brif Gemini'ye verildiyse Gemini yazar.
    const b = taskHarness({ reviews: ['## Brief\nGemini brifi'], agentReviews: [{ ...PASS }], settings: { geminiRole: 'manager', taskBriefing: true, briefBy: 'gemini', reviewPanel: false } });
    try {
      await b.o.runTask(b.task, b.s);
      assert.strictEqual(b.task.brief, '## Brief\nGemini brifi');
      assert.ok(!b.calls.agent.some((l) => /^teknik brif/.test(l)));
    } finally {
      b.restore();
    }
    // Hafıza: ajan günceller (dersler dahil); Gemini çağrılmaz.
    const jobs = require('../src/main/jobs');
    jobs._setRoot(tmp());
    const o = orch();
    o.useGit = false;
    o.reviewerId = () => 'claude';
    const seen = [];
    o.gem = async () => {
      throw new Error('Gemini çağrılmamalı');
    };
    o.runAgent = async (prompt, opts) => {
      seen.push([opts.label, opts.effort, opts.mode, prompt]);
      return { ok: true, structured: { memory: '## Status\nPipeline hazır', carryOver: ['runner.ts transition() kullan'], lessons: ['Terminal durum ezilmez.'] } };
    };
    settings.get = () => ({ ...savedGet(), geminiRole: 'manager', standards: '' });
    await o.remember({ id: 't1', title: 'Pipeline', details: 'd', status: 'done', agentSummary: 'özet', review: { verdict: 'pass', summary: 'iyi', issues: [] } }, 'Görev 1/1 — Pipeline');
    assert.deepStrictEqual([seen.length, seen[0][0], seen[0][1], seen[0][2]], [1, 'proje hafızası', 'low', 'review']);
    assert.match(seen[0][3], /Your FINAL action must be calling the StructuredOutput tool with "memory", "carryOver" and "lessons"/);
    assert.deepStrictEqual([o.job.memory, o.job.carryOver, o.job.lessons], ['## Status\nPipeline hazır', ['runner.ts transition() kullan'], ['Terminal durum ezilmez.']]);
    assert.match(docs.readMemory(o.job.projectDir), /Pipeline hazır/);
    assert.ok(o.logs.some((l) => /^review\/ok: Hafıza güncellendi/.test(l)));
    jobs.flushAll();
    jobs._setRoot(null);
  } finally {
    agents.resolveBin = savedBin;
    settings.get = savedGet;
  }

  // Faz kapısı (yönetici rolü): Gemini çağrılmaz; karar derin incelemeden ve doğrulanmış bulgulardan gelir.
  let geminiCalls = 0;
  const gate = stageHarness({
    reviews: [PASS],
    panel: { confirmed: [finding('medium', 'Sınır test edilmiyor', { file: 'src/graph.ts' })], uncertain: [], rejected: [], summaries: [] },
    settings: { geminiRole: 'manager' },
    deep: (n) => ({ verdict: 'pass', summary: `derin tur ${n}`, issues: [], requirementChecks: [], testsRun: [], qualityScore: 9 }),
  });
  try {
    const gem = gate.o.gem;
    gate.o.gem = async (a) => {
      geminiCalls++;
      return gem(a);
    };
    await gate.o.runPhaseGate('Faz 1', gate.s);
    const g = gate.o.job.gates['Faz 1'];
    assert.strictEqual(geminiCalls, 0, 'faz kapısında Gemini çağrısı yok');
    assert.deepStrictEqual([g.status, g.attempts, g.review.summary], ['passed', 1, 'derin tur 1']);
    assert.deepStrictEqual(gate.o.job.findings.map((f) => f.status), ['fixed']);
    assert.ok(gate.o.logs.some((l) => /^review\/warn: Faz kapısı \(Faz 1\): DÜZELTME GEREKLİ · kalite 8\/10/.test(l)), 'puan derin incelemeden gelir ve doğrulanmış bulguyla sınırlanır');
  } finally {
    gate.restore();
  }
});

test('Roller: TDD testlerini yönetici rolünde ajan inceler; ajan sonuç vermezse Gemini yedektir', async () => {
  const agents = require('../src/main/agents');
  const settings = require('../src/main/settings');
  const project = require('../src/main/project');
  const P = require('../src/main/prompts');
  const saved = { bin: agents.resolveBin, get: settings.get, files: project.fileContents };
  agents.resolveBin = (id) => (id === 'claude' ? '/usr/local/bin/claude' : null);
  project.fileContents = () => '### tests/cli.test.js\nTEST DOSYASI';
  const task = { id: 't2', title: 'Komut satırı', goal: 'g', details: 'd', acceptance: ['Given x'], tests: ['unit: cli'], covers: [] };
  const files = ['tests/cli.test.js'];
  const make = (agentOut) => {
    const o = orch({ tasks: [task], plan: { requirements: [], language: 'Turkish', spec: 'ŞARTNAME', verify: {} } });
    o.reviewerId = () => 'claude';
    const seen = { agent: [], gem: 0 };
    o.runAgent = async (prompt, opts) => {
      seen.agent.push({ prompt, ...opts });
      return agentOut;
    };
    o.gem = async () => {
      seen.gem++;
      return { verdict: 'ok', problems: [] };
    };
    return { o, seen };
  };
  const fix = { verdict: 'fix', problems: [{ file: 'tests/cli.test.js', problem: 'yanlış çıkış kodu bekliyor', fix: '1 bekle' }] };
  const failed = { ok: false, error: 'oturum hatası', transcript: '' };
  try {
    // Yönetici rolü: salt okunur ajan oturumu inceler; Gemini çağrılmaz.
    const a = make({ ok: true, structured: fix });
    const ra = await a.o.reviewTddTests(task, files, { geminiRole: 'manager', reviewEffort: 'medium' });
    assert.deepStrictEqual([ra.tr, ra.src, a.seen.gem, a.seen.agent.length], [fix, 'review', 0, 1]);
    assert.deepStrictEqual([a.seen.agent[0].label, a.seen.agent[0].mode, a.seen.agent[0].agentId, a.seen.agent[0].effort], ['TDD test incelemesi', 'review', 'claude', 'medium']);
    assert.strictEqual(a.seen.agent[0].schema, P.TEST_REVIEW_JSON_SCHEMA);
    assert.deepStrictEqual(P.TEST_REVIEW_JSON_SCHEMA.properties.verdict, { type: 'string', enum: ['ok', 'fix'] });
    assert.match(a.seen.agent[0].prompt, /READ-ONLY mode[\s\S]*do not run the suite[\s\S]*StructuredOutput tool with "verdict" and "problems"[\s\S]*ŞARTNAME[\s\S]*TEST DOSYASI/);
    // Ajan sonuç vermezse: anahtar varsa Gemini inceler, yoksa inceleme atlanır (iş kilitlenmez).
    settings.get = () => ({ ...saved.get(), geminiKey: 'anahtar' });
    const b = make(failed);
    const rb = await b.o.reviewTddTests(task, files, { geminiRole: 'manager' });
    assert.deepStrictEqual([rb.tr.verdict, rb.src, b.seen.gem], ['ok', 'gemini', 1]);
    settings.get = () => ({ ...saved.get(), geminiKey: '' });
    const c = make(failed);
    const rc = await c.o.reviewTddTests(task, files, { geminiRole: 'manager' });
    assert.deepStrictEqual([rc.tr, c.seen.gem], [null, 0]);
    assert.ok(c.o.logs.some((l) => /TDD test incelemesi sonuç vermedi/.test(l)));
    // "Her adımda" rolü: Gemini inceler, ajan oturumu açılmaz.
    const d = make({ ok: true, structured: fix });
    const rd = await d.o.reviewTddTests(task, files, { geminiRole: 'full' });
    assert.deepStrictEqual([rd.src, d.seen.gem, d.seen.agent.length], ['gemini', 1, 0]);
  } finally {
    agents.resolveBin = saved.bin;
    settings.get = saved.get;
    project.fileContents = saved.files;
  }
});

test('İptali geri alma: plan hazırsa onaya, sorular cevaplanmadıysa sorulara döner; plan yeniden üretilmez', () => {
  const jobs = require('../src/main/jobs');
  jobs._setRoot(tmp());
  try {
    // Plan onay beklerken "İptal": iş iptal olur; geri alınınca aynı plan ve görevlerle onaya döner.
    const task = { id: 't1', title: 'Pipeline', status: 'pending' };
    const o = orch({ phase: 'awaiting_approval', tasks: [task] });
    const plan = o.job.plan;
    o.stop();
    assert.strictEqual(o.job.phase, 'cancelled');
    assert.throws(() => o.approve({}), /Onaylanacak plan yok/);
    o.reopen();
    assert.strictEqual(o.job.phase, 'awaiting_approval');
    assert.strictEqual(o.job.plan, plan);
    assert.deepStrictEqual(o.job.tasks, [task]);
    assert.ok(o.logs.some((l) => /^system\/info: İptal geri alındı: plan onayınızı bekliyor/.test(l)));
    assert.throws(() => o.reopen(), /Geri alınacak bir iptal yok/);
    // Sorular beklerken iptal edildiyse sorulara döner.
    const q = orch({ phase: 'awaiting_answers', plan: null, discovery: { productBrief: 'x', questions: [{ question: 'Soru?', options: ['a'], default: 'a' }] } });
    q.stop();
    assert.strictEqual(q.job.phase, 'cancelled');
    q.reopen();
    assert.strictEqual(q.job.phase, 'awaiting_answers');
    // Geri getirilecek plan yoksa ya da iş iptal edilmemişse açık hata; çalışan iş geri alınamaz.
    assert.throws(() => orch({ phase: 'cancelled', plan: null }).reopen(), /geri getirilecek bir plan yok/);
    assert.throws(() => orch({ phase: 'cancelled' }).reopen(), /geri getirilecek bir plan yok/, 'görevsiz plan onaya dönmez');
    assert.throws(() => orch({ phase: 'done', tasks: [task] }).reopen(), /Geri alınacak bir iptal yok/);
    const busy = orch({ phase: 'cancelled', tasks: [task] });
    busy.running = true;
    assert.throws(() => busy.reopen(), /Geri alınacak bir iptal yok/);
  } finally {
    jobs.flushAll();
    jobs._setRoot(null);
  }
});

// ---------- iş durum makinesi: onay, sürdürme noktaları, kapanmamış bulgular ----------
const idle = async (o) => {
  for (let i = 0; i < 400 && o.running; i++) await new Promise((r) => setTimeout(r, 5));
};

test('Sürdür: onaylanmamış plan çalıştırılmaz, onaya döner; onaylanan (ya da yürütmesi başlamış eski) iş sürer', async () => {
  const jobs = require('../src/main/jobs');
  jobs._setRoot(tmp());
  try {
    const mk = (extra) => {
      const o = orch({ phase: 'failed', tasks: [{ id: 't1', title: 'a', status: 'pending' }], ...extra });
      o.calls = [];
      o.pipeline = async () => o.calls.push('pipeline');
      return o;
    };
    // Plan onay beklerken yeniden planlama başarısız olmuş: eski (reddedilen) plan çalıştırılmamalı.
    const a = mk({});
    a.resume();
    await idle(a);
    assert.deepStrictEqual([a.job.phase, a.calls], ['awaiting_approval', []]);
    const b = mk({ approvedAt: 1 });
    b.resume();
    await idle(b);
    assert.deepStrictEqual(b.calls, ['pipeline']);
    // approvedAt alanı olmayan eski iş: yürütmesi başlamışsa (startedAt) onaylanmış sayılır.
    const c = mk({ startedAt: 5 });
    c.resume();
    await idle(c);
    assert.deepStrictEqual(c.calls, ['pipeline']);
    const d = mk({ phase: 'awaiting_approval' });
    d.approve();
    await idle(d);
    assert.ok(d.job.approvedAt > 0, 'onay kaydedilir');
  } finally {
    jobs.flushAll();
    jobs._setRoot(null);
  }
});

test('Sürdür: commit\'ten önce kesilen görev yeniden yazılmaz, yalnızca hafıza ve commit tamamlanır; boşuna faz kapısı tekrarlanmaz', async () => {
  const jobs = require('../src/main/jobs');
  jobs._setRoot(tmp());
  const plan = { projectName: 'P', summary: 's', stack: [], requirements: [{ id: 'R1', text: 'a' }], assumptions: [], spec: 's', language: 'Turkish', verify: {} };
  const run = async (tasks, gates) => {
    const o = orch({ phase: 'stopped', approvedAt: 1, plan, tasks, gates, phaseStart: {} });
    const calls = [];
    o.runTask = async (t) => {
      calls.push(`run:${t.id}`);
      t.status = 'done';
      t.step = 'closed';
    };
    o.finishTask = async (t) => {
      calls.push(`finish:${t.id}`);
      t.step = 'closed';
    };
    o.runPhaseGate = async (p) => {
      calls.push(`gate:${p}`);
      o.job.gates[p] = { status: 'passed' };
    };
    o.finalStage = async () => calls.push('final');
    o.commit = async () => null;
    o.reviewerId = () => null;
    o.resume();
    await idle(o);
    assert.ok(!o.job.error, o.job.error);
    return calls;
  };
  try {
    // t1 kodlandı ve incelendi, hafıza / commit adımında kesildi: yalnızca o adım tamamlanır, sonra fazın kapısı.
    assert.deepStrictEqual(await run([{ id: 't1', phase: 'A', title: 'a', status: 'done', step: 'finishing' }, { id: 't2', phase: 'B', title: 'b', status: 'pending' }], {}), ['finish:t1', 'gate:A', 'run:t2', 'final']);
    // A'nın kapısı geçilememişti ama iş devam etmişti (katı değil); A'da hiçbir görev yeniden çalışmadı: kapı tekrarlanmaz.
    assert.deepStrictEqual(await run([{ id: 't1', phase: 'A', title: 'a', status: 'done' }, { id: 't2', phase: 'B', title: 'b', status: 'pending' }], { A: { status: 'failed' } }), ['run:t2', 'final']);
    // Katı kapı işi durdurmuştu: sürdürmede kapı yeniden çalışır.
    assert.deepStrictEqual(await run([{ id: 't1', phase: 'A', title: 'a', status: 'done' }, { id: 't2', phase: 'B', title: 'b', status: 'pending' }], { A: { status: 'failed', blocked: true } }), ['gate:A', 'run:t2', 'final']);
    // Sorunlu kalmış görev sürdürmede yeniden denenir (tasarım gereği); fazı değiştiği için kapısı da yeniden çalışır.
    assert.deepStrictEqual(await run([{ id: 't1', phase: 'A', title: 'a', status: 'failed', step: 'closed' }, { id: 't2', phase: 'B', title: 'b', status: 'pending' }], { A: { status: 'failed' } }), ['run:t1', 'gate:A', 'run:t2', 'final']);
  } finally {
    jobs.flushAll();
    jobs._setRoot(null);
  }
});

test('Faz kapısı ve son kabul: doğrulayıcı çalışamazsa açık bulgular "kapandı" sayılmaz', async () => {
  const L = require('../src/main/panel');
  const g = stageHarness({ reviews: [PASS], panel: null });
  try {
    g.o.recheckFindings = async () => null; // doğrulayıcı oturumu sonuç vermedi
    L.ledgerAdd(g.o.ledger(), [finding('medium', 'Terminal durum eziliyor', { file: 'src/store.ts' })], { at: 'task:t1', label: 'görev "Pipeline"' });
    await assert.rejects(() => g.o.runPhaseGate('Faz 1', g.s), /kalite kapısı/);
    assert.strictEqual(g.o.job.gates['Faz 1'].status, 'failed');
    assert.match(g.calls.prompts['faz düzeltme 1/2'], /Terminal durum eziliyor/);
  } finally {
    g.restore();
  }
  const f = stageHarness({ reviews: [PASS], panel: null });
  try {
    f.o.recheckFindings = async () => null;
    f.o.job.tasks[1].status = 'done';
    L.ledgerAdd(f.o.ledger(), [finding('medium', 'Bing geçici hatada RSS\'e düşmüyor', { file: 'src/bing.ts' })], { at: 'task:t1', label: 'görev "Arama"' });
    await f.o.finalStage({ ...f.s, finalFixAttempts: 1, maxFixAttempts: 1 });
    assert.strictEqual(f.o.job.phase, 'incomplete');
    assert.match(f.o.job.finalReview.issues.join('\n'), /Bing geçici hatada/);
  } finally {
    f.restore();
  }
});

test('TDD: testler zaten yazılmışsa (kesintiden sonra) QA oturumu yeniden çalışmaz', async () => {
  const o = orch();
  fs.writeFileSync(path.join(o.job.projectDir, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'vitest' } }));
  o.useGit = true;
  const labels = [];
  o.runAgent = async (p, opts = {}) => {
    labels.push(opts.label);
    return { ok: true };
  };
  const task = { id: 't2', title: 'b', tests: ['x'], acceptance: [], tddCommit: 'abc1234', tddFiles: ['a.test.ts'] };
  await o.writeTddTests(task, { tddMode: true }, 2);
  assert.deepStrictEqual(labels, []);
  assert.deepStrictEqual(task.tddFiles, ['a.test.ts']);
});

test('Bağımsız denetim: inceleyici yoksa yarım denetim çökmez; uygulama aşamasında kesildiyse aynı öneriler yeniden uygulanır', async () => {
  const L = require('../src/main/panel');
  const project = require('../src/main/project');
  const jobs = require('../src/main/jobs');
  jobs._setRoot(tmp());
  const saved = { isClean: project.isClean, headCommit: project.headCommit, fileTree: project.fileTree };
  Object.assign(project, { isClean: async () => true, headCommit: async () => 'abc1234', fileTree: () => 'src/' });
  try {
    const tasks = [{ id: 't1', title: 'a', status: 'done' }, { id: 't2', title: 'b', status: 'pending' }];
    const o = orch({ tasks, plan: { requirements: [{ id: 'R1', text: 'a' }], language: 'Turkish', verify: {}, summary: 's', stack: ['Node'] }, audits: [{ n: 1, afterTask: 't1', status: 'applying', items: [{ id: 'F1', kind: 'readiness', before: 't2' }] }] });
    const s = { reviewLevel: 'deep', independentAudit: true, auditEvery: 3, standards: '' };
    o.useGit = true;
    o.reviewerId = () => null;
    assert.strictEqual(o.auditInterrupted(tasks[0], s), false, 'inceleyici yokken yarım denetim atlanır');
    o.reviewerId = () => 'claude';
    assert.strictEqual(o.auditInterrupted(tasks[0], s), true);
    L.ledgerAdd(o.ledger(), [finding('medium', 'SDK sözleşmesi eksik', { file: 'src/sdk.ts', area: 'audit' })], { at: 'audit:1', label: 'bağımsız denetim 1' });
    const labels = [];
    o.withCleanTree = (fn) => fn();
    o.checksOnline = async () => [];
    o.remember = async () => {};
    o.commit = async () => 'c0ffee1';
    o.runAgent = async (prompt, opts = {}) => {
      labels.push(opts.label);
      if (opts.label === 'bulgu yeniden doğrulama') return { structured: { results: [{ id: 'F1', verdict: 'fixed', reason: 'ok' }] } };
      return { ok: true, text: 'uyguladım' };
    };
    const rec = await o.runAudit(0, s);
    assert.ok(!labels.includes('bağımsız denetim 1'), 'denetim baştan yapılmadı');
    assert.ok(labels.includes('denetim düzeltmeleri 1'), 'doğrulanmış öneriler uygulandı');
    assert.strictEqual(rec.status, 'done');
    assert.strictEqual(o.ledger()[0].status, 'fixed');
  } finally {
    Object.assign(project, saved);
    jobs.flushAll();
    jobs._setRoot(null);
  }
});

test('İş zinciri: hata yolundaki bir hata bile işlenmemiş Promise reddine dönüşmez', async () => {
  const jobs = require('../src/main/jobs');
  jobs._setRoot(tmp());
  const seen = [];
  const onRejection = (e) => seen.push(e);
  process.on('unhandledRejection', onRejection);
  try {
    const o = orch();
    o.fail = () => {
      throw new Error('fail patladı');
    };
    o.guarded(async () => {
      throw new Error('iş hatası');
    });
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(seen.length, 0, String(seen[0]));
    assert.strictEqual(o.running, false);
  } finally {
    process.off('unhandledRejection', onRejection);
    jobs.flushAll();
    jobs._setRoot(null);
  }
});

test('Öneriler: aynı öneri tekrar eklenmez, liste sınırlı kalır (her kapı istemine girer)', () => {
  const o = orch();
  o.addSuggestions(['a', 'b', 'a']);
  o.addSuggestions(Array.from({ length: 100 }, (_, i) => `s${i}`));
  assert.ok(o.job.suggestions.length <= 60);
  assert.strictEqual(new Set(o.job.suggestions).size, o.job.suggestions.length);
  assert.ok(o.job.suggestions.includes('s99'), 'en yeniler korunur');
});

test('Faz kapısı ekran görüntüsü etiketi faz başına sabittir (yeniden çalışan kapı başka fazın görüntülerini ezmez)', async () => {
  const h = stageHarness({ reviews: [PASS], panel: null });
  try {
    const tags = [];
    h.o.runBrowserTest = async (s, tag) => {
      tags.push(tag);
      return null;
    };
    await h.o.runPhaseGate('Faz 2', h.s);
    await h.o.runPhaseGate('Faz 1', h.s);
    await h.o.runPhaseGate('Faz 1', h.s);
    assert.deepStrictEqual(tags, ['g2-0', 'g1-0', 'g1-0']);
  } finally {
    h.restore();
  }
});
