// Kayıt ve arayüz olayları: iş listesi önbelleği, gecikmeli kayıt hataları, log dosyasının sonundan okunması,
// iş olaylarının seyreltilmesi ve arayüzden gelen klasör yollarının denetimi.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const jobs = require('../src/main/jobs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sonda-kayit-'));
const job = (id, extra = {}) => ({ id, idea: `fikir ${id}`, phase: 'done', createdAt: Number(id.slice(-4)), projectDir: '/tmp/p', agent: 'claude', tasks: [], plan: { projectName: `Proje ${id}` }, ...extra });

test('İş listesi: dosyalar bir kez okunur; kayıt ve silme listeyi diskten okumadan günceller', () => {
  jobs._setRoot(tmp());
  try {
    for (const id of ['isxxxx-0001', 'isxxxx-0002', 'isxxxx-0003']) jobs.save(job(id), { immediate: true });
    const reads = [];
    const orig = fs.readFileSync;
    fs.readFileSync = function (file, ...rest) {
      if (String(file).endsWith('job.json')) reads.push(file);
      return orig.call(this, file, ...rest);
    };
    try {
      assert.deepStrictEqual(jobs.list().map((j) => j.id), ['isxxxx-0003', 'isxxxx-0002', 'isxxxx-0001']);
      const first = reads.length;
      jobs.save(job('isxxxx-0002', { phase: 'running' }), { immediate: true });
      jobs.save(job('isxxxx-0004'), { immediate: true });
      jobs.remove('isxxxx-0001');
      const l = jobs.list();
      assert.strictEqual(reads.length, first, 'liste ikinci kez diskten okunmadı');
      assert.deepStrictEqual(l.map((j) => [j.id, j.phase]), [['isxxxx-0004', 'done'], ['isxxxx-0003', 'done'], ['isxxxx-0002', 'running']]);
      assert.strictEqual(l[0].title, 'Proje isxxxx-0004');
    } finally {
      fs.readFileSync = orig;
    }
  } finally {
    jobs._setRoot(null);
  }
});

test('Gecikmeli kayıt yazılamazsa (disk dolu, izin) ana süreç düşmez', async () => {
  const notDir = path.join(tmp(), 'dosya');
  fs.writeFileSync(notDir, 'x'); // kök bir dosya: klasör açılamaz (ENOTDIR)
  jobs._setRoot(notDir);
  const errors = [];
  const onError = (e) => errors.push(e);
  process.on('uncaughtException', onError);
  try {
    jobs.save(job('isxxxx-0009'));
    await new Promise((r) => setTimeout(r, 600));
    assert.strictEqual(errors.length, 0, String(errors[0]));
  } finally {
    process.off('uncaughtException', onError);
    jobs._setRoot(null);
  }
});

test('Loglar: iş açılırken dosyanın yalnızca sonu okunur (dev log dosyası arayüzü dondurmaz)', () => {
  const root = tmp();
  jobs._setRoot(root);
  try {
    const id = 'isxxxx-0007';
    fs.mkdirSync(path.join(root, id), { recursive: true });
    const line = (i) => JSON.stringify({ t: i, src: 'agent', lvl: 'info', text: `satır ${i} ${'x'.repeat(150)}` });
    const total = 120000; // ~20 MB
    fs.writeFileSync(path.join(root, id, 'logs.jsonl'), Array.from({ length: total }, (_, i) => line(i)).join('\n') + '\n');
    // Dosyanın tamamı belleğe alınmaz (saatler süren bir işin logu yüzlerce MB olabilir).
    const orig = fs.readFileSync;
    fs.readFileSync = function (file, ...rest) {
      if (String(file).endsWith('logs.jsonl')) throw new Error('log dosyasının tamamı okundu');
      return orig.call(this, file, ...rest);
    };
    let logs;
    try {
      logs = jobs.readLogs(id, 100);
    } finally {
      fs.readFileSync = orig;
    }
    assert.strictEqual(logs.length, 100);
    assert.deepStrictEqual([logs[0].t, logs[99].t], [total - 100, total - 1]);
    // Kısa dosya ve bozuk satır.
    fs.writeFileSync(path.join(root, id, 'logs.jsonl'), `${line(1)}\nbozuk{\n${line(2)}\n`);
    assert.deepStrictEqual(jobs.readLogs(id, 10).map((l) => l.t), [1, 2]);
  } finally {
    jobs._setRoot(null);
  }
});

test('İş olayları seyreltilir: kısa aralıktaki güncellemelerden yalnızca sonuncusu gider; aşama değişikliği hemen gider', async () => {
  const { jobEventThrottle } = require('../src/main/ipcutil');
  const sent = [];
  const t = jobEventThrottle((e) => sent.push(`${e.job.id}:${e.job.phase}:${e.job.n}`), { delayMs: 40 });
  t.push({ type: 'job', job: { id: 'a', phase: 'running', n: 1 } }); // ilk olay: aşama değişti → hemen
  for (let n = 2; n <= 50; n++) t.push({ type: 'job', job: { id: 'a', phase: 'running', n } });
  t.push({ type: 'job', job: { id: 'b', phase: 'planning', n: 1 } });
  assert.deepStrictEqual(sent, ['a:running:1', 'b:planning:1']);
  await new Promise((r) => setTimeout(r, 80));
  assert.deepStrictEqual(sent, ['a:running:1', 'b:planning:1', 'a:running:50']);
  t.push({ type: 'job', job: { id: 'a', phase: 'running', n: 51 } });
  t.push({ type: 'job', job: { id: 'a', phase: 'done', n: 52 } }); // aşama değişti: bekleyen atılır, yenisi hemen
  assert.deepStrictEqual(sent.slice(-1), ['a:done:52']);
  await new Promise((r) => setTimeout(r, 80));
  assert.strictEqual(sent.length, 4, 'atılan ara güncelleme sonradan gönderilmez');
  t.flush();
});

test('Klasör denetimi: arayüz yalnızca kullanıcının seçtiği ya da bilinen işlerin klasörleriyle çalışabilir', () => {
  const { folderGuard } = require('../src/main/ipcutil');
  const known = ['/Users/a/proje-1'];
  const g = folderGuard({ initial: ['/Users/a/son'], known: () => known });
  // Windows'ta path.resolve köksüz yola sürücü harfi ekler; dönen değer her zaman çözümlenmiş yoldur.
  assert.strictEqual(g.check('/Users/a/son'), path.resolve('/Users/a/son'), 'açılıştaki son klasör');
  assert.strictEqual(g.check('/Users/a/proje-1/'), path.resolve('/Users/a/proje-1'), 'kayıtlı işin klasörü');
  assert.throws(() => g.check('/etc'), /seçin/);
  assert.throws(() => g.check('relative/dir'), /seçin/);
  assert.throws(() => g.check(42), /seçin/);
  g.allow('/Users/a/yeni');
  assert.strictEqual(g.check('/Users/a/yeni'), path.resolve('/Users/a/yeni'), 'bu oturumda seçilen klasör');
  assert.throws(() => g.check('/Users/a/yeni/../../b'), /seçin/);
});
