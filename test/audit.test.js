// Bağımsız denetim testleri: ne zaman çalıştığı, önerilerin doğrulayıcıdan geçmesi, yalnızca doğrulananların
// uygulanması, kontroller kırılırsa onarım, uygulamanın yeniden doğrulanması ve yarıda kalan denetimin sürdürülmesi.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sonda-denetim-'));
const task = (id, status = 'pending', extra = {}) => ({ id, title: `Görev ${id}`, goal: `amaç ${id}`, details: 'ayrıntı', acceptance: ['Given x'], tests: [], covers: [], status, ...extra });
const S = (extra = {}) => ({ independentAudit: true, auditEvery: 3, reviewLevel: 'deep', standards: '', ...extra });

function harness({ tasks, suggestions = [], verdicts = () => 'confirmed', recheck = () => 'fixed', checks = [[]], auditFails = false } = {}) {
  const jobs = require('../src/main/jobs');
  const project = require('../src/main/project');
  const verify = require('../src/main/verify');
  const agents = require('../src/main/agents');
  const { Orchestrator } = require('../src/main/orchestrator');
  jobs._setRoot(tmp());
  const saved = { runChecks: verify.runChecks, headCommit: project.headCommit, isClean: project.isClean, fileTree: project.fileTree, discardChanges: project.discardChanges, resolveBin: agents.resolveBin };
  const discarded = [];
  project.discardChanges = async (d) => discarded.push(d);
  let round = 0;
  verify.runChecks = async () => checks[Math.min(round++, checks.length - 1)];
  project.headCommit = async () => 'base123';
  project.isClean = async () => true;
  project.fileTree = () => 'src/';
  agents.resolveBin = (id) => (id === 'claude' ? '/usr/local/bin/claude' : null);
  const o = new Orchestrator({ emit: () => {} });
  o.job = { id: 'mun446n8-denetim', idea: 'x', projectDir: tmp(), agent: 'claude', tasks, userNotes: ['Türkçe arayüz'], suggestions: [], stats: { agentRuns: 0, costUsd: 0, managerTokens: 0 }, plan: { summary: 'Özet', stack: ['Python'], requirements: [], language: 'Turkish', verify: {} } };
  o.logs = [];
  o.log = (src, lvl, text) => o.logs.push(`${src}/${lvl}: ${text}`);
  o.useGit = true;
  o.commit = async () => 'c0ffee1';
  const remembered = [];
  o.remember = async (t, heading) => remembered.push({ t, heading });
  const calls = [];
  o.runAgent = async (prompt, opts = {}) => {
    const label = opts.label || '';
    calls.push({ label, prompt, opts });
    if (/^bağımsız denetim/.test(label) && opts.schema) {
      if (auditFails) throw new Error('oturum düştü');
      return { ok: true, structured: { summary: 'temel çoğunlukla sağlam', strengths: ['küçük modüller'], suggestions } };
    }
    if (label === 'bulgu doğrulama') {
      const n = (prompt.match(/## Finding #/g) || []).length;
      return { structured: { results: Array.from({ length: n }, (_, i) => ({ index: i, verdict: verdicts(i), reason: 'kodda bakıldı' })) } };
    }
    if (label === 'bulgu yeniden doğrulama') {
      const ids = [...prompt.matchAll(/^## (F\d+) —/gm)].map((m) => m[1]);
      return { structured: { results: ids.map((id) => ({ id, verdict: recheck(id), reason: 'bakıldı' })) } };
    }
    if (/^denetim (düzeltmeleri|onarımı)/.test(label)) return { ok: true, text: 'uyguladım', sessionId: 's9' };
    throw new Error(`beklenmeyen ajan çağrısı: ${label}`);
  };
  const restore = () => {
    verify.runChecks = saved.runChecks;
    project.headCommit = saved.headCommit;
    project.isClean = saved.isClean;
    project.fileTree = saved.fileTree;
    project.discardChanges = saved.discardChanges;
    agents.resolveBin = saved.resolveBin;
    jobs.flushAll();
    jobs._setRoot(null);
  };
  return { o, calls, remembered, discarded, restore };
}

const sug = (title, extra = {}) => ({ kind: 'readiness', severity: 'high', title, file: 'src/sdk.py:12', problem: 'p', scenario: 's', fix: 'f', before: 't4', ...extra });

test('Denetim zamanı: her N görevde bir, yalnızca kalan görev varken; kapalıyken, standart seviyede ve git yokken çalışmaz', () => {
  const { o, restore } = harness({ tasks: [task('t1', 'done'), task('t2', 'done'), task('t3', 'done'), task('t4'), task('t5'), task('t6'), task('t7')] });
  try {
    assert.deepStrictEqual([0, 1, 2, 3].map((i) => o.auditDue(i, S())), [false, false, true, true], 'ilk denetim 3. görevden sonra');
    o.job.audits = [{ n: 1, afterTask: 't3', status: 'done' }];
    assert.deepStrictEqual([3, 4, 5].map((i) => o.auditDue(i, S())), [false, false, true], 'sonraki denetim 3 görev sonra');
    assert.strictEqual(o.auditDue(6, S()), false, 'son görevden sonra denetim yok (son kabul denetler)');
    assert.strictEqual(o.auditDue(5, S({ independentAudit: false })), false);
    assert.strictEqual(o.auditDue(5, S({ reviewLevel: 'standard' })), false);
    assert.strictEqual(o.auditDue(5, S({ auditEvery: 1 })), true);
    o.useGit = false;
    assert.strictEqual(o.auditDue(5, S()), false);
    // Yarıda kalan denetim sürdürmede yeniden yapılır; bitmiş olan yapılmaz.
    o.useGit = true;
    o.job.audits.push({ n: 2, afterTask: 't6', status: 'running' });
    assert.deepStrictEqual([o.auditInterrupted(o.job.tasks[5], S()), o.auditInterrupted(o.job.tasks[2], S())], [true, false]);
    // Denetim artık yapılamıyorsa (git kapalı, standart seviye) yarım kalan denetim de yeniden yapılmaz.
    o.useGit = false;
    assert.strictEqual(o.auditInterrupted(o.job.tasks[5], S()), false);
    o.useGit = true;
    assert.strictEqual(o.auditInterrupted(o.job.tasks[5], S({ reviewLevel: 'standard' })), false);
  } finally {
    restore();
  }
});

test('Denetim: yalnızca doğrulanan öneriler deftere girer ve uygulanır; uygulama yeniden doğrulanır, commit atılır', async () => {
  const tasks = [task('t1', 'done'), task('t2', 'done'), task('t3', 'done'), task('t4', 'pending', { title: 'Reddit konektörü' }), task('t5')];
  const { o, calls, remembered, restore } = harness({
    tasks,
    suggestions: [sug('SDK yalnızca GET yapıyor'), sug('Yanlış alarm', { kind: 'defect', before: '' }), sug('README eksik', { severity: 'low', before: '' }), sug('Bilinmeyen görev', { severity: 'medium', before: 't99' })],
    verdicts: (i) => (i === 1 ? 'rejected' : 'confirmed'),
  });
  try {
    const rec = await o.runAudit(2, S());
    // Denetim: salt okunur, en derin model (Fable), kalan görevlerle birlikte.
    const audit = calls.find((c) => c.label === 'bağımsız denetim 1');
    assert.deepStrictEqual([audit.opts.mode, audit.opts.model, audit.opts.effort], ['review', 'claude-fable-5-1', 'high']);
    assert.match(audit.prompt, /## t4 — Reddit konektörü/);
    assert.match(audit.prompt, /Türkçe arayüz/);
    // Doğrulayıcı hazırlık bulgusunun hangi göreve dayandığını görür; düşük öncelik doğrulamaya gitmez.
    const ver = calls.find((c) => c.label === 'bulgu doğrulama');
    assert.strictEqual((ver.prompt.match(/## Finding #/g) || []).length, 3);
    assert.match(ver.prompt, /first upcoming task that depends on it: t4/);
    assert.match(ver.prompt, /A READINESS finding/);
    assert.deepStrictEqual(rec.suggestions.map((x) => [x.title, x.verdict, x.ledgerId || null, x.before]), [
      ['SDK yalnızca GET yapıyor', 'confirmed', 'F1', 't4'],
      ['Yanlış alarm', 'rejected', null, ''],
      ['Bilinmeyen görev', 'confirmed', 'F2', ''],
      ['README eksik', 'low', null, ''],
    ]);
    // Düzeltme oturumu yalnızca doğrulananları alır; bağlı görev adıyla.
    const fix = calls.find((c) => c.label === 'denetim düzeltmeleri 1');
    assert.match(fix.prompt, /F1 \[high\] SDK yalnızca GET yapıyor[\s\S]*Upcoming task that depends on it: t4 — Reddit konektörü/);
    assert.doesNotMatch(fix.prompt, /Yanlış alarm|README eksik/);
    assert.match(fix.prompt, /Do NOT implement the upcoming tasks themselves/);
    // Hafıza, commit ve yeniden doğrulama: ancak doğrulayıcı onaylarsa "düzeldi".
    assert.strictEqual(remembered[0].t.baseCommit, 'base123');
    assert.deepStrictEqual([rec.status, rec.commit, rec.fixed, rec.still, rec.checksOk], ['done', 'c0ffee1', ['F1', 'F2'], [], true]);
    assert.deepStrictEqual(o.job.findings.map((f) => [f.id, f.area, f.at, f.status]), [['F1', 'audit', 'audit:1', 'fixed'], ['F2', 'audit', 'audit:1', 'fixed']]);
    assert.strictEqual(o.job.phase, 'running');
    assert.ok(o.logs.some((l) => /Bağımsız denetim 1 tamam: 2\/2 öneri uygulandı ve doğrulandı/.test(l)));
  } finally {
    restore();
  }
});

test('Denetim: kontroller kırılırsa aynı oturumda onarım; kapanmayan öneri defterde açık kalır (kapıyı tutar)', async () => {
  const fail = [{ name: 'Testler', cmd: 'npm test', ok: false, code: 1, output: 'AssertionError' }];
  const { o, calls, restore } = harness({ tasks: [task('t1', 'done'), task('t2')], suggestions: [sug('Test yolu toplanmıyor', { kind: 'test-gap', before: 't2' })], checks: [[], fail, []], recheck: () => 'still_present' });
  try {
    const rec = await o.runAudit(0, S({ auditEvery: 1 }));
    const repair = calls.find((c) => c.label === 'denetim onarımı 1');
    assert.ok(repair, 'onarım turu');
    assert.strictEqual(repair.opts.resumeId, 's9', 'aynı oturum sürdürülür');
    assert.match(repair.prompt, /checks fail after your audit fixes[\s\S]*AssertionError/);
    assert.deepStrictEqual([rec.checksOk, rec.fixed, rec.still], [true, [], ['F1']]);
    assert.strictEqual(o.job.findings[0].status, 'open');
    assert.ok(o.logs.some((l) => /1 öneri açık kaldı/.test(l)));
  } finally {
    restore();
  }
});

test('Denetim: öneri yoksa ya da oturum düşerse kod değişmez, yapım sürer; zaten izlenen kusur yinelenmez', async () => {
  let h = harness({ tasks: [task('t1', 'done'), task('t2')], suggestions: [] });
  try {
    const rec = await h.o.runAudit(0, S());
    assert.deepStrictEqual([rec.status, rec.suggestions.length], ['done', 0]);
    assert.deepStrictEqual(h.calls.map((c) => c.label), ['bağımsız denetim 1'], 'doğrulama ya da düzeltme oturumu açılmaz');
    assert.ok(h.o.logs.some((l) => /temeller sağlam, öneri yok/.test(l)));
  } finally {
    h.restore();
  }
  h = harness({ tasks: [task('t1', 'done'), task('t2')], auditFails: true });
  try {
    const rec = await h.o.runAudit(0, S());
    assert.deepStrictEqual([rec.status, rec.error], ['done', 'sonuç alınamadı']);
    assert.strictEqual(h.o.job.phase, 'running');
  } finally {
    h.restore();
  }
  h = harness({ tasks: [task('t1', 'done'), task('t2')], suggestions: [sug('Aynı kusur', { file: 'src/a.py', line: 3 })] });
  try {
    h.o.job.findings = [{ id: 'F1', status: 'open', severity: 'high', area: 'logic', title: 'Aynı kusur', file: 'src/a.py', line: 3, problem: 'p', scenario: 's', fix: 'f', at: 'task:t1' }];
    const rec = await h.o.runAudit(0, S());
    assert.strictEqual(rec.suggestions[0].known, true);
    assert.strictEqual(h.o.job.findings.length, 1);
    assert.ok(!h.calls.some((c) => /^denetim düzeltmeleri/.test(c.label)), 'zaten defterde olan kusur için ayrı düzeltme açılmaz');
  } finally {
    h.restore();
  }
});

test('Denetim: yarıda kalan denetim aynı numarayla yeniden yapılır; eski işlerde (denetim kaydı yok) geriye dönük çalışmaz', async () => {
  const { o, restore } = harness({ tasks: [task('t1', 'done'), task('t2', 'done'), task('t3')], suggestions: [] });
  try {
    o.job.audits = [{ n: 1, afterTask: 't1', status: 'running', suggestions: [] }];
    const rec = await o.runAudit(0, S());
    assert.deepStrictEqual([o.job.audits.length, rec.n, rec.status], [1, 1, 'done']);
    // Yeni sürüme geçen eski bir iş: denetim kaydı yok, görevler bitmiş. Döngü bitmiş görevlerde denetim açmaz
    // (pipeline yalnızca bu çalıştırmada biten görevden sonra auditDue'ya bakar).
    o.job.audits = undefined;
    assert.strictEqual(o.auditInterrupted(o.job.tasks[0], S()), false);
  } finally {
    restore();
  }
});

test('Denetim akışı bozmaz: düzeltme bir kontrolü bozar ve onarılamazsa tamamen geri alınır; önceden kırık kontrol denetimin suçu sayılmaz', async () => {
  const fail = [{ name: 'Testler', cmd: 'npm test', ok: false, code: 1, output: 'AssertionError' }];
  const lint = [{ name: 'Lint', cmd: 'npm run lint', ok: false, code: 1, output: 'no-unused-vars' }];
  // Önce temiz → düzeltme testi bozar → onarım da bozuk bırakır: geri alınır, commit ve hafıza yok, öneri açık kalır.
  let h = harness({ tasks: [task('t1', 'done'), task('t2')], suggestions: [sug('SDK yalnızca GET')], checks: [[], fail, fail] });
  try {
    const rec = await h.o.runAudit(0, S());
    assert.deepStrictEqual([rec.reverted, rec.checksOk, rec.commit, rec.still], [true, false, undefined, ['F1']]);
    assert.strictEqual(h.discarded.length, 1, 'değişiklikler geri alındı');
    assert.strictEqual(h.remembered.length, 0, 'geri alınan iş hafızaya yazılmaz');
    assert.ok(!h.calls.some((c) => c.label === 'bulgu yeniden doğrulama'));
    assert.strictEqual(h.o.job.findings[0].status, 'open');
    assert.strictEqual(h.o.job.phase, 'running');
    assert.ok(h.o.logs.some((l) => /değişiklikler geri alındı, proje denetimden önceki haline döndü/.test(l)));
  } finally {
    h.restore();
  }
  // Lint denetimden önce de kırıktı: düzeltmeden sonra yine kırık olması onarım ya da geri alma tetiklemez.
  h = harness({ tasks: [task('t1', 'done'), task('t2')], suggestions: [sug('SDK yalnızca GET')], checks: [lint, lint] });
  try {
    const rec = await h.o.runAudit(0, S());
    assert.deepStrictEqual([rec.reverted, rec.checksOk, rec.commit, rec.fixed], [undefined, true, 'c0ffee1', ['F1']]);
    assert.ok(!h.calls.some((c) => /^denetim onarımı/.test(c.label)));
    assert.strictEqual(h.discarded.length, 0);
  } finally {
    h.restore();
  }
  // Ağaç temiz değilse (geri alınacak sağlam bir nokta yok) hiçbir şey silinmez.
  const project = require('../src/main/project');
  h = harness({ tasks: [task('t1', 'done'), task('t2')], suggestions: [sug('SDK yalnızca GET')], checks: [fail, fail] });
  project.isClean = async () => false;
  try {
    const rec = await h.o.runAudit(0, S());
    assert.strictEqual(h.discarded.length, 0, 'kirli ağaçta geri alma yapılmaz');
    assert.strictEqual(rec.checksOk, false);
  } finally {
    h.restore();
  }
});
