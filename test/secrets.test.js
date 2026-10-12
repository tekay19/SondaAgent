// Gizli bilgi korumaları: maskeleme ve tarama biçimleri, commit/zip taramaları, ortam değişkenleri, anahtar deposu.
// Bu dosya kendi işleminde çalışır; Electron'un `app` ve `safeStorage` nesneleri burada taklit edilir.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sonda-gizli-'));
const userData = tmp();
let encryption = false;
require.cache[require.resolve('electron')] = {
  id: 'electron', filename: 'electron', loaded: true,
  exports: {
    app: { getPath: () => userData },
    safeStorage: {
      isEncryptionAvailable: () => encryption,
      encryptString: (s) => Buffer.from(`enc:${[...s].reverse().join('')}`),
      decryptString: (b) => [...b.toString().replace(/^enc:/, '')].reverse().join(''),
    },
  },
};

const E = require('../src/main/envfile');
const secrets = require('../src/main/secrets');
const settings = require('../src/main/settings');
const project = require('../src/main/project');
const archive = require('../src/main/archive');

const IS_WIN = process.platform === 'win32';
// Sahte gizli değerler parça parça kurulur: gerçek anahtar biçimindeki dizgeler gizli anahtar taramasına takılır.
const LIVE = ['sk', 'live', 'GERCEKdeger123'].join('_');
const repo = () => {
  const dir = tmp();
  const g = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: dir, encoding: 'utf8' });
  g('init', '-q');
  return { dir, g };
};
const shippedObjects = (gitRoot) =>
  execFileSync('git', ['--git-dir', path.join(gitRoot, '.git'), 'cat-file', '--batch-all-objects', '--batch'], { encoding: 'latin1', maxBuffer: 64 * 1024 * 1024 });

test('Gizli biçimler: commit/zip taraması maskelemeyle aynı biçimleri arar (URL kodlu, JSON kaçışlı, $ kaçışlı)', () => {
  const pass = 'p@ss$word"9xyz';
  const needles = E.needlesOf({ DB_PASSWORD: pass });
  for (const form of [pass, encodeURIComponent(pass), JSON.stringify(pass).slice(1, -1), pass.replace(/\$/g, '\\$'), pass.replace(/\$/g, '$$$$')]) {
    assert.ok(needles.includes(form), `tarama listesinde yok: ${form}`);
  }
  // .env'de $ kaçışlı yazılan değer loglarda da maskelenir.
  assert.strictEqual(E.makeRedactor({ DB_PASSWORD: pass })(`X=${pass.replace(/\$/g, '\\$')}`), 'X=‹gizli:DB_PASSWORD›');
  // Çok satırlı değerin ham hali (satır satır taranan farkta hiç eşleşmez) listeye girmez; uzun satırları girer.
  const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0B\n-----END PRIVATE KEY-----';
  const pemNeedles = E.needlesOf({ PEM_PRIVATE_KEY: pem });
  assert.ok(pemNeedles.includes('MIIEvQIBADANBgkqhkiG9w0B') && !pemNeedles.some((n) => /\n/.test(n)));
});

test('Sonda\'nın ürettiği sırlar (ADMIN_PASSWORD, SESSION_SECRET) maskelenir ve commit/zip taramasına girer', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x"}');
  fs.writeFileSync(path.join(dir, '.env.example'), 'ADMIN_PASSWORD=\nSESSION_SECRET=\nPORT=3000\n');
  const before = secrets.version();
  const r = secrets.ensureLocalEnv(dir);
  assert.deepStrictEqual(r.generated.sort(), ['ADMIN_PASSWORD', 'SESSION_SECRET']);
  assert.ok(secrets.version() > before, 'maskeleyici yeniden kurulsun diye sürüm artar');
  const env = E.parseEnv(fs.readFileSync(path.join(dir, '.env'), 'utf8'));
  const sens = secrets.sensitive(dir);
  assert.strictEqual(sens.ADMIN_PASSWORD, env.ADMIN_PASSWORD);
  assert.strictEqual(sens.SESSION_SECRET, env.SESSION_SECRET);
  assert.ok(!('PORT' in sens));
  assert.ok(secrets.needles(dir).includes(env.SESSION_SECRET));
  const red = E.makeRedactor(sens);
  assert.ok(!red(`seed: admin parolası ${env.ADMIN_PASSWORD}`).includes(env.ADMIN_PASSWORD));
  // Elle yazılmış bir geliştirme sırrı (rastgele değil) taramaya girmez: docker-compose / seed dosyaları yanlış alarmla
  // commit dışında kalmasın.
  fs.appendFileSync(path.join(dir, '.env'), 'JWT_SECRET=dev-secret-change-me\n');
  assert.ok(!('JWT_SECRET' in secrets.sensitive(dir)));
});

test('Commit taraması: tamamlanamazsa commit atılmaz; tırnaklı dosya adındaki sızıntı da yakalanır', async () => {
  // Git deposu olmayan klasörde tarama çalışamaz: "temiz" sayılmamalı.
  const none = await project.unstageSecrets(tmp(), [LIVE]);
  assert.strictEqual(none.ok, false);

  const { dir, g } = repo();
  fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n');
  g('add', '-A');
  g('commit', '-qm', 'ilk');
  const head = g('rev-parse', 'HEAD').trim();
  fs.writeFileSync(path.join(dir, 'b.ts'), 'export const b = 2;\n');
  let failed = 0;
  // Tarama zaman aşımına uğrarsa (çok büyük fark) commit atılmaz; değişiklikler bir sonraki commit'e kalır.
  const hash = await project.commitAll(dir, 'sonda: görev', { secretNeedles: [LIVE], onScanFail: () => failed++, scanTimeoutMs: 1 });
  assert.strictEqual(hash, null);
  assert.strictEqual(failed, 1);
  assert.strictEqual(g('rev-parse', 'HEAD').trim(), head);

  if (!IS_WIN) {
    const weird = 'ayar "ğ".ts'; // git bu adı tırnak içinde ve kaçışlı yazar
    fs.writeFileSync(path.join(dir, weird), `export const k = "${LIVE}";\n`);
    let leaked = [];
    assert.ok(await project.commitAll(dir, 'sonda: görev', { secretNeedles: [LIVE], onLeak: (f) => (leaked = f) }));
    assert.deepStrictEqual(leaked, [weird]);
    assert.ok(!g('log', '-p', '--all').includes(LIVE));
    assert.ok(g('show', '--name-only', '--pretty=format:', 'HEAD').includes('b.ts'));
  }
});

test('Zip: geçmiş kopyalanamaz ya da taranamazsa git geçmişi pakete girmez', async () => {
  const { dir, g } = repo();
  fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = "içerik";\n');
  g('add', '-A');
  g('commit', '-qm', 'ilk');
  const blob = g('rev-parse', 'HEAD:a.ts').trim();
  fs.rmSync(path.join(dir, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
  const r = await archive.collect(dir, { needles: [LIVE] });
  assert.ok(!r.gitIncluded, 'bozuk geçmiş "temiz" sayılmamalı');
  assert.match(r.gitExcluded, /taranamadı|kopyalanamadı/);
  assert.ok(!r.files.some((f) => f.startsWith('.git/')));
  // Hiç commit'i olmayan depo: sahnelenmiş nesneler pakete girmesin.
  const empty = repo();
  fs.writeFileSync(path.join(empty.dir, 'x.ts'), `const k = "${LIVE}";\n`);
  empty.g('add', '-A');
  const r2 = await archive.collect(empty.dir, {});
  assert.ok(!r2.gitIncluded && !r2.files.some((f) => f.startsWith('.git/')));
});

test('Zip: değiştirilmiş (amend) commit\'teki ve sahnelenip geri alınmış gizli değer pakete giden geçmişte yoktur', async () => {
  const { dir, g } = repo();
  const second = ['tok', 'LIVE', 'zyxwvu987654'].join('_');
  fs.writeFileSync(path.join(dir, 'config.ts'), `export const k = "${LIVE}";\n`);
  g('add', '-A');
  g('commit', '-qm', 'sızıntı');
  fs.writeFileSync(path.join(dir, 'config.ts'), 'export const k = process.env.K;\n');
  g('add', '-A');
  g('commit', '-q', '--amend', '-m', 'temiz'); // eski commit yalnızca reflog'da ve nesne deposunda
  fs.writeFileSync(path.join(dir, 'other.ts'), `export const t = "${second}";\n`);
  g('add', 'other.ts');
  g('reset', '-q', 'other.ts'); // Sonda'nın commit taramasının yaptığı gibi: sahnelenen nesne depoda sahipsiz kalır
  fs.rmSync(path.join(dir, 'other.ts'));
  g('remote', 'add', 'origin', 'https://user:ghp_x@github.com/x/y.git');
  const r = await archive.collect(dir, { needles: [LIVE, second] });
  assert.ok(r.gitIncluded, r.gitExcluded);
  assert.ok(r.files.includes('.git/HEAD'));
  const objects = shippedObjects(r.gitRoot);
  assert.ok(objects.includes('process.env.K'), 'güncel geçmiş pakette');
  assert.ok(!objects.includes(LIVE) && !objects.includes(second), 'eski / sahipsiz nesneler pakete girmez');
  // Uzak depo adresi (kimlik bilgisiyle birlikte) ve yerel klasör yolu pakete girmez.
  const cfg = fs.readFileSync(path.join(r.gitRoot, '.git', 'config'), 'utf8');
  assert.ok(!cfg.includes('ghp_x') && !cfg.includes(dir) && !/\[remote/.test(cfg));
  assert.match(cfg, /bare = false/);

  if (!IS_WIN) {
    const out = await archive.zipProject(dir, { outDir: tmp(), name: 'Gecmis', needles: [LIVE, second] });
    assert.ok(out.gitIncluded);
    const into = tmp();
    execFileSync('unzip', ['-q', out.file, '-d', into]);
    const g2 = (...a) => execFileSync('git', a, { cwd: into, encoding: 'utf8' });
    assert.strictEqual(g2('status', '--porcelain').trim(), '', 'açılan klasör temiz bir çalışma deposu');
    assert.strictEqual(g2('log', '--format=%s').trim(), 'temiz');
  }
});

test('Zip: büyük dosyadaki, parça sınırına denk gelen ve kodlanmış biçimdeki gizli değer bulunur', async () => {
  const dir = tmp(); // git deposu değil: klasör taranır
  const pass = 'p@ss$wörd99';
  const needles = E.needlesOf({ STRIPE_SECRET_KEY: LIVE, DB_PASSWORD: pass });
  fs.writeFileSync(path.join(dir, 'big.bin'), Buffer.concat([Buffer.alloc(6 * 1024 * 1024, 'a'), Buffer.from(LIVE)]));
  fs.writeFileSync(path.join(dir, 'edge.txt'), Buffer.concat([Buffer.alloc(1024 * 1024 - 5, 'b'), Buffer.from(LIVE)]));
  fs.writeFileSync(path.join(dir, 'enc.yml'), `url: postgres://u:${encodeURIComponent(pass)}@db/app\n`);
  fs.writeFileSync(path.join(dir, 'ok.ts'), 'export const ok = true;\n');
  const r = await archive.collect(dir, { needles });
  assert.deepStrictEqual(r.leaked.sort(), ['big.bin', 'edge.txt', 'enc.yml']);
  assert.deepStrictEqual(r.files, ['ok.ts']);
});

test('Zip: AWS / git kimlik dosyaları ve yerel veritabanları pakete girmez', async () => {
  const dir = tmp();
  for (const f of ['credentials', '.git-credentials', 'AuthKey_ABC.p8', 'app-firebase-adminsdk-x1.json', 'dev.db', 'data.sqlite', 'a.ts']) fs.writeFileSync(path.join(dir, f), 'x');
  const r = await archive.collect(dir, {});
  assert.deepStrictEqual(r.files, ['a.ts']);
});

test('Ortam: ajanlara ve proje komutlarına bilgisayardaki API anahtarları aktarılmaz', () => {
  const { agentEnv, verifyEnv } = require('../src/main/env');
  const { agentRunEnv } = require('../src/main/agents/run');
  const vars = {
    GEMINI_API_KEY: 'g-1234567890', GOOGLE_API_KEY: 'g-0987654321', OPENAI_API_KEY: 'o-1234567890', GITHUB_TOKEN: 'ghp_1234567890',
    AWS_SECRET_ACCESS_KEY: 'aws-1234567890', MY_SERVICE_PASSWORD: 'pw-1234567890', NPM_TOKEN: 'npm-1234567890',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth-1234567890', SSH_AUTH_SOCK: '/tmp/ssh.sock', CLAUDE_CODE_USE_BEDROCK: undefined,
  };
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    const hasPath = (env) => Object.keys(env).some((k) => k.toUpperCase() === 'PATH');
    const stripped = ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'MY_SERVICE_PASSWORD'];
    const a = agentEnv({ GIT_TERMINAL_PROMPT: '0' });
    for (const k of stripped) assert.ok(!(k in a), `ajan ortamında olmamalı: ${k}`);
    for (const k of ['NPM_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'SSH_AUTH_SOCK', 'GIT_TERMINAL_PROMPT']) assert.ok(k in a, `ajan ortamında olmalı: ${k}`);
    assert.ok(hasPath(a));
    // Proje komutları (test, build, dev sunucusu): ajanın oturum jetonu da gitmez; paket kurulumu için kayıt jetonu kalır.
    const v = verifyEnv({ PORT: '4000' });
    for (const k of [...stripped, 'CLAUDE_CODE_OAUTH_TOKEN']) assert.ok(!(k in v), `doğrulama ortamında olmamalı: ${k}`);
    assert.deepStrictEqual([v.PORT, v.CI, v.NPM_TOKEN], ['4000', 'true', vars.NPM_TOKEN]);
    assert.ok(hasPath(v));
    // Codex API anahtarıyla giriş yapmış olabilir: OpenAI anahtarı yalnızca Codex oturumuna gider.
    assert.strictEqual(agentRunEnv('codex').OPENAI_API_KEY, vars.OPENAI_API_KEY);
    assert.ok(!('OPENAI_API_KEY' in agentRunEnv('claude')));
    // Claude Bedrock üzerinden çalışıyorsa AWS kimliği ajana gider, proje komutlarına gitmez.
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    assert.strictEqual(agentEnv().AWS_SECRET_ACCESS_KEY, vars.AWS_SECRET_ACCESS_KEY);
    assert.ok(!('AWS_SECRET_ACCESS_KEY' in verifyEnv()));
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test('İnceleyici: .env kabuk komutlarıyla da okunamaz', () => {
  const { REVIEW_ALLOWED, ENV_DENY } = require('../src/main/agents');
  for (const c of ['cat', 'head', 'tail', 'grep', 'rg']) assert.ok(!REVIEW_ALLOWED.includes(`Bash(${c}:*)`), `inceleyiciye serbest olmamalı: ${c}`);
  for (const rule of ['Read(.env)', 'Read(**/.env.local)', 'Bash(cat .env:*)', 'Bash(cat ./.env:*)', 'Bash(head .env:*)']) {
    assert.ok(ENV_DENY.includes(rule), `kural yok: ${rule}`);
  }
});

test('Anahtar deposu: bozuk dosya kenara alınır, üzerine yazılıp diğer projelerin değerleri silinmez', () => {
  const store = path.join(userData, 'secrets.json');
  fs.writeFileSync(store, '{"/baska/proje": {"plain": {"A_TOKEN": "değer-1234567890"}}'); // kapanış parantezi eksik
  const dir = tmp();
  secrets.update(dir, { set: { STRIPE_SECRET_KEY: LIVE } });
  const backups = fs.readdirSync(userData).filter((f) => f.startsWith('secrets.json.bozuk-'));
  assert.strictEqual(backups.length, 1, 'bozuk dosya kenara alınır');
  assert.match(fs.readFileSync(path.join(userData, backups[0]), 'utf8'), /baska\/proje/);
  assert.strictEqual(secrets.get(dir).STRIPE_SECRET_KEY, LIVE);
});

test('Ayarlar: bozuk settings.json kenara alınır', () => {
  const file = path.join(userData, 'settings.json');
  fs.writeFileSync(file, '{"managerBy": "anthropic",');
  settings.save({ managerBy: 'gemini' });
  assert.ok(fs.readdirSync(userData).some((f) => f.startsWith('settings.json.bozuk-')));
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).managerBy, 'gemini');
});

test('Şifreleme sonradan kullanılabilir olursa düz saklanan anahtarlar şifrelenir', () => {
  const GKEY = ['AIza', 'gemini', 'test', 'abcdefghijklmnop'].join('');
  const dir = tmp();
  encryption = false;
  try {
    settings.save({ geminiKey: GKEY });
    secrets.update(dir, { set: { STRIPE_SECRET_KEY: LIVE } });
    assert.ok(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8').includes(GKEY));
    assert.ok(fs.readFileSync(path.join(userData, 'secrets.json'), 'utf8').includes(LIVE));
    encryption = true;
    settings.migratePlain();
    secrets.migratePlain();
    assert.ok(!fs.readFileSync(path.join(userData, 'settings.json'), 'utf8').includes(GKEY));
    assert.ok(!fs.readFileSync(path.join(userData, 'secrets.json'), 'utf8').includes(LIVE));
    assert.strictEqual(settings.get().geminiKey, GKEY);
    assert.strictEqual(secrets.get(dir).STRIPE_SECRET_KEY, LIVE);
  } finally {
    encryption = false;
  }
});
