// Süreç yönetimi: zaman aşımı / iptal / kapanışta süreç gruplarının sonlandırılması, satır bölücü, dev sunucusu adresi,
// Windows'ta sahipsiz süreç eşleşmesi, sürüm sorgusunun önbelleği.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const runner = require('../src/main/runner');

const IS_WIN = process.platform === 'win32';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sonda-surec-'));
const alive = (marker) => {
  try {
    return execFileSync('pgrep', ['-f', marker], { encoding: 'utf8' }).trim() !== '';
  } catch {
    return false;
  }
};
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

test('Zaman aşımı: ana süreç çıkmış olsa da arka planda kalan torun öldürülür, bekleme takılmaz', { skip: IS_WIN }, async () => {
  const marker = 'sleep 31.31';
  const t0 = Date.now();
  const r = await runner.run({ shellCommand: `${marker} & exit 0`, timeoutMs: 500 });
  assert.ok(Date.now() - t0 < 4000, `bekleme takıldı: ${Date.now() - t0} ms`);
  assert.strictEqual(r.timedOut, true);
  await settle(200);
  assert.ok(!alive(marker), 'torun süreç hâlâ çalışıyor');
});

test('Ana süreç bittikten sonra çıktıyı tutan arka plan süreci beklemeyi sonsuza uzatmaz', { skip: IS_WIN }, async () => {
  const marker = 'sleep 32.32';
  const t0 = Date.now();
  const r = await runner.run({ shellCommand: `${marker} & echo bitti`, exitGraceMs: 300 });
  assert.ok(Date.now() - t0 < 4000, `bekleme takıldı: ${Date.now() - t0} ms`);
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /bitti/);
  await settle(200);
  assert.ok(!alive(marker), 'arka plan süreci hâlâ çalışıyor');
});

test('Önceden iptal edilmiş işte komut çalıştırılmaz', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const t0 = Date.now();
  const r = await runner.run({ command: process.execPath, args: ['-e', 'setTimeout(() => {}, 5000)'], signal: ctrl.signal });
  assert.ok(Date.now() - t0 < 3000, `iptal edilmiş iş ${Date.now() - t0} ms sürdü`);
  assert.strictEqual(r.killed, true);
});

test('Kapanış: SIGTERM\'i yok sayan süreç bekleme süresinden sonra SIGKILL ile kapatılır', { skip: IS_WIN }, async () => {
  const marker = 'sleep 33.33';
  const p = runner.start({ shellCommand: `trap '' TERM; ${marker}; ${marker}` });
  await settle(300);
  const t0 = Date.now();
  await runner.terminateAll(400);
  assert.ok(Date.now() - t0 < 3000);
  const r = await Promise.race([p.done, settle(3000).then(() => null)]);
  assert.ok(r, 'süreç kapanmadı');
  assert.ok(!alive(marker));
});

test('Satır bölücü: parçalara bölünmüş ve \\r\\n biten satırlar; dev satır yavaşlatmaz ve sınırda kesilir', () => {
  const lines = [];
  const s = runner.lineSplitter((l) => lines.push(l));
  s.push('bir\r\niki');
  s.push(' parça\nüç');
  s.flush();
  assert.deepStrictEqual(lines, ['bir', 'iki parça', 'üç']);
  // 8 MB'lık tek satır 64 KB'lık parçalarla: her parçada baştan arama yapılırsa saniyeler sürer.
  const big = [];
  const b = runner.lineSplitter((l) => big.push(l.length));
  const piece = 'x'.repeat(64 * 1024);
  const t0 = Date.now();
  for (let i = 0; i < 128; i++) b.push(piece);
  b.push('\nson\n');
  assert.ok(Date.now() - t0 < 1500, `dev satır ${Date.now() - t0} ms sürdü`);
  assert.deepStrictEqual(big, [8 * 1024 * 1024, 3]);
  // Sınırı aşan satır kesilir, kalan kısmı ayrı bir satır gibi görünmez.
  const capped = [];
  const c = runner.lineSplitter((l) => capped.push(l), 10);
  c.push('0123456789abcdef');
  c.push('ghij\nsonraki\n');
  assert.deepStrictEqual(capped, ['0123456789', 'sonraki']);
});

test('Windows sahipsiz süreç araması: klasör sınırı ve büyük/küçük harf', () => {
  const { commandLineInside } = require('../src/main/procs');
  const root = 'C:\\Users\\Ali\\proj';
  assert.ok(commandLineInside('node C:\\Users\\Ali\\proj\\server.js', root));
  assert.ok(commandLineInside('"c:\\users\\ali\\PROJ\\node_modules\\.bin\\next" dev', root), 'büyük/küçük harf');
  assert.ok(commandLineInside('node C:/Users/Ali/proj/server.js', root), 'eğik çizgi');
  assert.ok(commandLineInside('cmd /c cd /d "C:\\Users\\Ali\\proj"', root), 'tırnakla biten');
  assert.ok(!commandLineInside('node C:\\Users\\Ali\\proj-old\\server.js', root), 'benzer adlı başka klasör');
  assert.ok(!commandLineInside('node C:\\Users\\Ali\\projects\\x.js', root));
  assert.ok(!commandLineInside('', root));
});

test('Dev sunucusu: port verildiyse adres yazdırmayan sunucu da hemen bulunur; başka porttaki adres seçilmez', async () => {
  const { startDevServer, detectUrl } = require('../src/main/verify/browser');
  assert.strictEqual(detectUrl('API proxy → http://localhost:8080/api', 4123), null, 'başka porttaki adres');
  assert.strictEqual(detectUrl('  ➜  Local:   http://localhost:4123/', 4123), 'http://localhost:4123');
  assert.strictEqual(detectUrl('ready on http://0.0.0.0:5173', null), 'http://localhost:5173');
  assert.strictEqual(detectUrl('db at postgres://localhost:5432/app', null), null);

  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { dev: 'node server.js' } }));
  fs.writeFileSync(path.join(dir, 'server.js'), [
    "const http = require('http');",
    "console.log('API proxy → http://localhost:8080');",
    "http.createServer((q, s) => s.end('ok')).listen(process.env.PORT, () => console.log('listening on ' + process.env.PORT));",
  ].join('\n'));
  const t0 = Date.now();
  const r = await startDevServer({ dir });
  try {
    assert.ok(r.ok, r.error);
    assert.ok(Date.now() - t0 < 15000, `sunucu ${Date.now() - t0} ms beklendi`);
    assert.doesNotMatch(r.url, /:8080/);
  } finally {
    r.proc?.kill();
    await r.proc?.done;
  }
});

test('Sürüm sorgusu: başarısız sonuç da önbelleğe alınır (her ajan başlatışında yeniden çalışmaz)', { skip: IS_WIN }, () => {
  const { versionOf } = require('../src/main/agents/install');
  const dir = tmp();
  const count = path.join(dir, 'sayac');
  const bin = path.join(dir, 'sahte-ajan');
  fs.writeFileSync(bin, `#!/bin/sh\necho x >> "${count}"\nexit 1\n`, { mode: 0o755 });
  assert.strictEqual(versionOf(bin), null);
  assert.strictEqual(versionOf(bin), null);
  assert.strictEqual(fs.readFileSync(count, 'utf8').trim().split('\n').length, 1);
});
