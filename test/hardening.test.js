// Sağlamlık testleri: .env yazımı (gerçek dotenv ile), gizlilik kuralları, kayıt güvenliği,
// inceleme kapıları, paralel adımlar, bağlantı ve model varsayılanı.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sonda-hard-'));
const optional = (name) => {
  try {
    return require(name);
  } catch {
    return null;
  }
};

// ---------- .env ----------
const NASTY = {
  PLAIN: 'plain_value-1',
  SPACE: 'two words',
  HASH: 'a#b',
  DQ: 'pa"ss',
  SQ: "it's",
  BOTH: `mix'"x`,
  WINPATH: 'C:\\path\\new\\table',
  JSONCRED: '{"type":"service_account","private_key":"-----BEGIN PRIVATE KEY-----\\nMIIEvQ\\n-----END PRIVATE KEY-----\\n","x":"a b"}',
  PEM: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nAbCdEf123456\n-----END PRIVATE KEY-----',
  ML_DQ: 'line1\nhas "quote" here\nline3',
  EMPTY: '',
  LEAD: '  padded  ',
  DOLLAR: 'sk_live_a$b',
  DOLLAR2: 'p$$w0rd${x}',
  BSDOLLAR: 'C:\\new$dir',
  EQ: 'a=b=c',
  TR: 'şifre çok gizli ğüı',
};

test('.env: her değer gerçek dotenv / dotenv-expand ile okunduğunda birebir geri gelir', { skip: !optional('dotenv') }, () => {
  const E = require('../src/main/envfile');
  const dotenv = require('dotenv');
  const expander = optional('dotenv-expand');
  for (const escapeDollar of expander ? [false, true] : [false]) {
    const opts = { escapeDollar, dialect: 'dotenv' };
    const text = E.upsertEnv('# yorum\nPORT=3000\n', NASTY, opts);
    let parsed = dotenv.parse(text);
    if (escapeDollar) parsed = expander.expand({ parsed: { ...parsed }, processEnv: {} }).parsed;
    for (const [k, v] of Object.entries(NASTY)) assert.strictEqual(parsed[k], v, `${k} (expand=${escapeDollar})`);
    // Sonda'nın kendi okuyucusu dotenv ile aynı sonucu verir.
    assert.deepStrictEqual(E.parseEnv(text), dotenv.parse(text));
    // İkinci yazım dosyayı değiştirmez; silince yalnızca özgün satırlar kalır.
    assert.strictEqual(E.upsertEnv(text, NASTY, opts), text);
    assert.strictEqual(E.removeFromEnv(text, Object.keys(NASTY)), '# yorum\nPORT=3000\n');
  }
});

test('.env: yinelenen anahtarların hepsi güncellenir, export ve satır sonu yorumu korunur, yazılamayan değer bildirilir', () => {
  const E = require('../src/main/envfile');
  const out = E.upsertEnv('export API_KEY=old # üretim\nOTHER=1\nAPI_KEY=older\n', { API_KEY: 'new value' }, {});
  assert.strictEqual(out, 'export API_KEY="new value" # üretim\nOTHER=1\nAPI_KEY="new value"\n');
  // Çok satırlı tırnaklı değer tek bir atama sayılır: güncelleme artık satır bırakmaz.
  const ml = E.upsertEnv("KEEP=1\nPEM='a\nb\nc'\nLAST=2\n", { PEM: 'x\ny' }, {});
  assert.strictEqual(ml, 'KEEP=1\nPEM="x\\ny"\nLAST=2\n');
  assert.deepStrictEqual(E.parseEnv("A='l1\nl2'\nB=\"x\\ny\" # c\nC=plain # yorum\n"), { A: 'l1\nl2', B: 'x\ny', C: 'plain' });
  // Sonda bölümü boşalınca başlığı da kalkar.
  const withHeader = E.upsertEnv('PORT=1\n', { NEW_ONE: 'v' }, {});
  assert.ok(withHeader.includes(E.HEADER));
  assert.strictEqual(E.removeFromEnv(withHeader, ['NEW_ONE']), 'PORT=1\n');
  // dotenv'de hiçbir biçimde yazılamayan değer: sessizce bozulmaz, bildirilir.
  assert.strictEqual(E.representable('pa"ss', { dialect: 'dotenv' }), true);
  assert.strictEqual(E.representable('a\'b"c`d #e', { dialect: 'dotenv' }), false);
  assert.strictEqual(E.representable('a\'b"c`d #e', { dialect: 'escaped' }), true);
  // Node dışı projelerde kaçışlı çift tırnak (python-dotenv, docker compose).
  assert.strictEqual(E.serializeValue('pa"ss\\x', { dialect: 'escaped' }), '"pa\\"ss\\\\x"');
});

test('.env: Sonda\'dan silinen anahtar proje dosyalarından da kalkar', () => {
  const E = require('../src/main/envfile');
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  fs.writeFileSync(path.join(dir, '.env.local'), 'OLD_KEY=abc\nKEEP=1\n');
  E.writeEnvFiles([dir], { OLD_KEY: 'secret-value-1', OTHER_KEY: 'secret-value-2' });
  const changed = E.removeFromEnvFiles([dir], ['OLD_KEY']);
  assert.deepStrictEqual(changed.map((f) => path.basename(f)).sort(), ['.env', '.env.local']);
  assert.ok(!/OLD_KEY/.test(fs.readFileSync(path.join(dir, '.env'), 'utf8')));
  assert.strictEqual(fs.readFileSync(path.join(dir, '.env.local'), 'utf8'), 'KEEP=1\n\n' + E.HEADER + '\nOTHER_KEY=secret-value-2\n');
});

test('.env tamamlama: varsayılanlar ve uygulamanın kendi sırları yazılır; üçüncü taraf anahtarlarına ve var olan satırlara dokunulmaz', () => {
  const envfile = require('../src/main/envfile');
  const dir = tmp();
  const example = ['# --- Uygulama ---', 'APP_ENV=development', 'APP_BASE_URL=http://localhost:3000', 'ADMIN_PASSWORD=', 'SESSION_SECRET=', '# --- Veritabanı ---', 'POSTGRES_USER=trendo', 'POSTGRES_PASSWORD=change-me', '# --- Üçüncü taraf ---', 'OPENAI_API_KEY=', 'REDDIT_CLIENT_SECRET=', '# OPTIONAL_FLAG=1', ''].join('\n');
  fs.writeFileSync(path.join(dir, '.env.example'), example);
  const rnd = (n) => (n === 'ADMIN_PASSWORD' ? 'a'.repeat(32) : 'b'.repeat(64));
  const env = () => fs.readFileSync(path.join(dir, '.env'), 'utf8');

  // Hangi adlar "uygulamanın kendi sırrı" sayılır (üretilir), hangileri sayılmaz (boş kalır).
  for (const n of ['ADMIN_PASSWORD', 'SESSION_SECRET', 'COOKIE_SECRET', 'JWT_SECRET', 'NEXTAUTH_SECRET', 'AUTH_SECRET', 'APP_SESSION_SECRET', 'SECRET_KEY', 'SECRET_KEY_BASE']) assert.ok(envfile.OWN_SECRET.test(n), n);
  for (const n of ['OPENAI_API_KEY', 'REDDIT_CLIENT_SECRET', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'POSTGRES_PASSWORD', 'DATABASE_PASSWORD', 'APP_KEY', 'ENCRYPTION_KEY', 'OAUTH_SECRET', 'GITHUB_CLIENT_SECRET']) assert.ok(!envfile.OWN_SECRET.test(n), n);

  // .env yok: örnek kopyalanır (yorumlar ve varsayılanlar korunur), kendi sırlar üretilir, kullanıcının değeri eklenir.
  const r = envfile.fillLocalEnv([dir], { EXTRA_USER: 'x y' }, rnd);
  assert.deepStrictEqual([r.created, r.generated.sort(), r.added.sort()], [true, ['ADMIN_PASSWORD', 'SESSION_SECRET'], ['ADMIN_PASSWORD', 'EXTRA_USER', 'SESSION_SECRET']]);
  assert.ok(!JSON.stringify(r).includes('aaaa') && !JSON.stringify(r).includes('bbbb'), 'dönen özette değer yok');
  const v = envfile.parseEnv(env());
  assert.deepStrictEqual([v.APP_ENV, v.APP_BASE_URL, v.POSTGRES_USER, v.POSTGRES_PASSWORD, v.ADMIN_PASSWORD.length, v.SESSION_SECRET.length, v.OPENAI_API_KEY, v.REDDIT_CLIENT_SECRET, v.EXTRA_USER], ['development', 'http://localhost:3000', 'trendo', 'change-me', 32, 64, '', '', 'x y']);
  assert.match(env(), /# --- Veritabanı ---/);
  assert.ok(!/^OPTIONAL_FLAG=/m.test(env()), 'isteğe bağlı (yorumlu) değişken açılmaz');
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(path.join(dir, '.env')).mode & 0o077, 0, 'yalnızca sahibi okur');
  // İkinci çağrı hiçbir şeyi değiştirmez.
  const before = env();
  assert.deepStrictEqual(envfile.fillLocalEnv([dir], {}, () => 'zzz'), { file: path.join(dir, '.env'), created: false, generated: [], added: [] });
  assert.strictEqual(env(), before);

  // Kısmi .env: yalnızca EKSİK satırlar eklenir; var olan (boş olanlar dahil) satırlar ve yer tutucu parolalar değişmez.
  fs.writeFileSync(path.join(dir, '.env'), 'APP_ENV=production\nADMIN_PASSWORD=\n');
  const p = envfile.fillLocalEnv([dir], { SESSION_SECRET: 'benim-sirrim' }, rnd);
  assert.deepStrictEqual([p.created, p.generated, p.added.sort()], [false, [], ['APP_BASE_URL', 'POSTGRES_USER', 'SESSION_SECRET']]);
  const q = envfile.parseEnv(env());
  assert.deepStrictEqual([q.APP_ENV, q.ADMIN_PASSWORD, q.SESSION_SECRET, q.APP_BASE_URL, q.POSTGRES_USER, 'POSTGRES_PASSWORD' in q, 'OPENAI_API_KEY' in q], ['production', '', 'benim-sirrim', 'http://localhost:3000', 'trendo', false, false]);
  // Örnek dosya yoksa hiçbir şey yapılmaz.
  assert.strictEqual(envfile.fillLocalEnv([tmp()], {}), null);
});

test('Doğrulama: docker compose "eksik değişken" hatası ortam sorunudur, kod hatası değil', () => {
  const { envMissingNames } = require('../src/main/verify/checks');
  const out = 'error while interpolating x-backend.environment.DATABASE_URL: required variable POSTGRES_USER is missing a value: POSTGRES_USER .env içinde tanımlı olmalı\nrequired variable POSTGRES_USER is missing a value: x\nrequired variable S3_SECRET_KEY is missing a value: y';
  assert.deepStrictEqual(envMissingNames(out), ['POSTGRES_USER', 'S3_SECRET_KEY']);
  assert.deepStrictEqual(envMissingNames('Error: Cannot find module x'), []);
  assert.deepStrictEqual(envMissingNames(''), []);
});

test('Gizlilik kuralları: ad parçalarına bakılır; yapılandırma değerleri gizli sayılmaz', () => {
  const E = require('../src/main/envfile');
  const not = [
    ['NEXTAUTH_URL', 'http://localhost:3000'],
    ['DATABASE_URL', 'file:./dev.db'],
    ['SESSION_TTL', '3600000'],
    ['COOKIE_NAME', 'sonda_session'],
    ['CACHE_KEY_PREFIX', 'myapp_cache'],
    ['PASSWORD_RESET_URL', 'https://app.example.com/reset'],
    ['APP_URL', 'https://my-very-long-project-name-2024.vercel.app'],
    ['PORT', '3000'],
    ['NODE_ENV', 'production'],
  ];
  const yes = [
    ['NEXTAUTH_SECRET', 'abcdef'],
    ['STRIPE_API_KEY', 'sk_live_x'],
    ['DATABASE_URL', 'postgresql://u:p4ss@db/app'],
    // Sahte değerler parça parça yazılır: gerçek anahtar biçimindeki dizgeler GitHub'ın gizli anahtar taramasına takılır.
    ['SLACK_WEBHOOK_URL', ['https://hooks.slack.com/services', 'T01ABCDE2', 'B03FGHIJ4', 'aBcD1234eFgH5678iJkL9012'].join('/')],
    ['TWILIO_ACCOUNT_SID', ['AC', 'a1b2c3d4e5f6a7b8', 'c9d0e1f2a3b4c5d6'].join('')],
    ['AGENT_PHONE', '+905551112233'],
    ['ADMIN_EMAIL', 'kisi@ornek.com.tr'],
  ];
  for (const [k, v] of not) assert.strictEqual(E.isSensitive(k, v), false, `${k} gizli sayılmamalı`);
  for (const [k, v] of yes) assert.strictEqual(E.isSensitive(k, v), true, `${k} gizli sayılmalı`);
  // Commit / zip taraması: kısa değerler, PEM başlık satırları ve çok satırlı ham hal iğne olmaz.
  const needles = E.needlesOf({ A_KEY: 'short12', B_TOKEN: 'longenough1', PEM_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0B\nkısa\n-----END PRIVATE KEY-----' });
  assert.ok(needles.includes('longenough1') && needles.includes('MIIEvQIBADANBgkqhkiG9w0B'));
  assert.ok(!needles.includes('short12') && !needles.some((n) => /^-----(BEGIN|END) [A-Z ]+-----$/.test(n) || /\n/.test(n) || n === 'kısa'));
});

test('Maskeleme: çok satırlı değerin satırları, .env / JSON kaçışlı ve URL kodlu biçimler de yakalanır', () => {
  const E = require('../src/main/envfile');
  const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0B\n-----END PRIVATE KEY-----';
  const pass = 'p@ss w0rd"x';
  const red = E.makeRedactor({ PEM_PRIVATE_KEY: pem, DB_PASSWORD: pass, PORT: '3000' });
  const out = red(`log: MIIEvQIBADANBgkqhkiG9w0B | env: "${pem.replace(/\n/g, '\\n')}" | url: ${encodeURIComponent(pass)} | json: ${JSON.stringify(pass)} | port 3000 | -----BEGIN PRIVATE KEY-----`);
  assert.strictEqual(out, 'log: ‹gizli:PEM_PRIVATE_KEY› | env: "‹gizli:PEM_PRIVATE_KEY›" | url: ‹gizli:DB_PASSWORD› | json: "‹gizli:DB_PASSWORD›" | port 3000 | -----BEGIN PRIVATE KEY-----');
});

// ---------- git ----------
test('Git: izlenen .env bile commit\'e girmez; ajanın yazdığı .gitignore tamamlanır', async () => {
  const project = require('../src/main/project');
  const dir = tmp();
  const g = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: dir, encoding: 'utf8' });
  g('init', '-q');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x"}');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'dist/\n'); // .env ve node_modules yok
  fs.writeFileSync(path.join(dir, '.env'), 'PORT=3000\n');
  fs.mkdirSync(path.join(dir, 'apps', 'web'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'apps', 'web', '.env.local'), 'A=1\n');
  g('add', '-A', '-f');
  g('commit', '-qm', 'ilk');
  fs.writeFileSync(path.join(dir, '.env'), 'PORT=3000\nSTRIPE_SECRET_KEY=sk_live_REAL123456\n');
  fs.writeFileSync(path.join(dir, 'apps', 'web', '.env.local'), 'A=1\nTOKEN=abcDEF123456789012345\n');
  fs.mkdirSync(path.join(dir, 'node_modules', 'foo'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'foo', 'index.js'), '1');
  fs.writeFileSync(path.join(dir, 'src.js'), 'console.log(process.env.STRIPE_SECRET_KEY)\n');
  assert.ok(await project.commitAll(dir, 'sonda: görev'));
  assert.deepStrictEqual(g('show', '--name-only', '--pretty=format:', 'HEAD').trim().split('\n').sort(), ['.gitignore', 'src.js']);
  assert.ok(!/sk_live_REAL|abcDEF123456789012345/.test(g('log', '-p', '--all')));
  const gi = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
  assert.match(gi, /^\.env$/m);
  assert.match(gi, /^\.env\*\.local$/m);
  assert.match(gi, /^node_modules\/$/m);
  // İkinci çağrı aynı kuralları yeniden eklemez.
  project.ensureGitignore(dir);
  assert.strictEqual(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), gi);
});

// ---------- kayıtlar ----------
test('İş kayıtları: geçersiz kimlik hiçbir şeyi silmez; kayıt atomiktir; silinen iş geri gelmez', async () => {
  const jobs = require('../src/main/jobs');
  const root = tmp();
  jobs._setRoot(root);
  try {
    const job = { id: 'mun446n8-df5a49', idea: 'x', phase: 'planning', createdAt: 1, projectDir: '/p', tasks: [], shots: [] };
    jobs.save(job, { immediate: true });
    assert.deepStrictEqual(jobs.list().map((j) => j.id), [job.id]);
    // "" / ".." / yol içeren kimlikler: kök klasör asla hedef olmaz.
    for (const bad of ['', '..', '../x', 'a/b', null, undefined, 'kısa']) {
      assert.throws(() => jobs.remove(bad), /Geçersiz iş kimliği/);
      assert.throws(() => jobs.load(bad), /Geçersiz iş kimliği/);
    }
    assert.ok(fs.existsSync(path.join(root, job.id, 'job.json')), 'kayıt yerinde olmalı');
    // Atomik yazım: geçici dosya kalmaz, içerik tamdır.
    jobs.save({ ...job, phase: 'running' }, { immediate: true });
    assert.deepStrictEqual(fs.readdirSync(path.join(root, job.id)), ['job.json']);
    assert.strictEqual(jobs.read(job.id).phase, 'running');
    // Henüz diske yazılmamış log satırları da okunur.
    jobs.appendLog(job.id, { t: 1, src: 'system', lvl: 'info', text: 'ilk satır' });
    assert.deepStrictEqual(jobs.readLogs(job.id).map((e) => e.text), ['ilk satır']);
    jobs.flushAll();
    assert.match(fs.readFileSync(path.join(root, job.id, 'logs.jsonl'), 'utf8'), /ilk satır/);
    // Gecikmeli kayıt bekleyen iş silinince geri gelmez.
    jobs.save({ ...job, phase: 'done' });
    jobs.appendLog(job.id, { t: 2, src: 'system', lvl: 'info', text: 'son' });
    jobs.remove(job.id);
    await new Promise((r) => setTimeout(r, 600));
    assert.ok(!fs.existsSync(path.join(root, job.id)), 'silinen iş yeniden oluşmamalı');
  } finally {
    jobs._setRoot(null);
  }
});

test('Atomik yazım: hedef dosya ya eski ya yeni içeriktedir, geçici dosya kalmaz', () => {
  const { writeFileAtomic, readJson, isInside } = require('../src/main/fsx');
  const dir = tmp();
  const file = path.join(dir, 'a.json');
  writeFileAtomic(file, '{"a":1}');
  writeFileAtomic(file, '{"a":2}', { mode: 0o600 });
  assert.deepStrictEqual(readJson(file), { a: 2 });
  assert.deepStrictEqual(fs.readdirSync(dir), ['a.json']);
  assert.strictEqual(readJson(path.join(dir, 'yok.json'), 'x'), 'x');
  assert.ok(isInside(path.join(dir, 'a', 'b'), dir) && !isInside(path.join(dir, '..', 'x'), dir) && !isInside(`${dir}-2`, dir));
});

// ---------- ekler ----------
test('Ekler: ad ve tür dosyanın kendisinden okunur; proje dışına yazılamaz; aynı adlar çakışmaz', () => {
  const docs = require('../src/main/docs');
  const a = tmp();
  const b = tmp();
  fs.writeFileSync(path.join(a, 'not.md'), 'A');
  fs.writeFileSync(path.join(b, 'not.md'), 'B');
  fs.writeFileSync(path.join(a, 'gizli'), 'uzantısız');
  const clean = docs.sanitizeAttachments([
    { path: path.join(a, 'not.md'), name: '../../kacak.md', kind: 'image', size: 1 },
    { path: path.join(b, 'not.md'), name: 'not.md' },
    { path: path.join(a, 'gizli'), name: 'x.md', kind: 'text' },
    { path: 'goreli/yol.md' },
    { path: path.join(a, 'yok.md') },
    null,
  ]);
  assert.deepStrictEqual(clean.map((x) => [x.name, x.kind]), [['not.md', 'text'], ['not.md', 'text']]);
  const proj = tmp();
  const { refs } = docs.writeToProject(proj, [...clean, { path: path.join(a, 'not.md'), name: '../../../kacak.md' }], null);
  assert.deepStrictEqual(refs, ['docs/sonda/references/not.md', 'docs/sonda/references/not-2.md', 'docs/sonda/references/kacak.md']);
  assert.deepStrictEqual(fs.readdirSync(path.join(proj, 'docs', 'sonda', 'references')).sort(), ['kacak.md', 'not-2.md', 'not.md']);
  assert.strictEqual(fs.readFileSync(path.join(proj, 'docs', 'sonda', 'references', 'not-2.md'), 'utf8'), 'B');
  // Standart metnindeki "$&" gibi diziler yer tutucu sanılmaz.
  docs.writeAgentGuides(proj, 'Fiyat $& ve $1 aynen kalmalı');
  docs.writeAgentGuides(proj, 'Fiyat $& ve $1 aynen kalmalı');
  assert.match(fs.readFileSync(path.join(proj, 'CLAUDE.md'), 'utf8'), /Fiyat \$& ve \$1 aynen kalmalı/);
});

// ---------- model ve ajan ----------
test('Claude modeli: seçilmediyse Opus 5.5; boşluk ve geçersiz değer varsayılana düşer', () => {
  const M = require('../src/main/models');
  const { ADAPTERS } = require('../src/main/agents');
  assert.strictEqual(M.DEFAULT_CLAUDE_MODEL, 'claude-opus-5-5');
  assert.strictEqual(M.claudeModelOf({}), 'claude-opus-5-5');
  assert.strictEqual(M.claudeModelOf({ claudeModel: '   ' }), 'claude-opus-5-5');
  assert.strictEqual(M.claudeModelOf({ claudeModel: ' claude-sonnet-5-5 ' }), 'claude-sonnet-5-5');
  assert.strictEqual(M.claudeModelLabel('claude-opus-5-5'), 'Opus 5.5');
  assert.strictEqual(M.claudeModelLabel('ozel-model'), 'ozel-model');
  assert.strictEqual(M.CLAUDE_MODELS[0].id, M.DEFAULT_CLAUDE_MODEL, 'varsayılan, listenin ilk seçeneği olmalı');
  for (const mode of ['code', 'review']) {
    const args = ADAPTERS.claude.buildArgs({ settings: {}, mode });
    assert.strictEqual(args[args.indexOf('--model') + 1], 'claude-opus-5-5', `${mode} modu`);
  }
  const custom = ADAPTERS.claude.buildArgs({ settings: { claudeModel: 'claude-fable-5-1' } });
  assert.strictEqual(custom[custom.indexOf('--model') + 1], 'claude-fable-5-1');
});

test('Ajan: .env koruması, abonelik ortamı ve metinden okunan sonucun doğrulanması', () => {
  const { ADAPTERS, ENV_DENY, conforms } = require('../src/main/agents');
  const { agentEnv } = require('../src/main/env');
  const P = require('../src/main/prompts');
  // Kullanıcı anahtar girdiyse kodlayan ajan da .env okuyamaz; girmediyse kısıt yok.
  const plain = ADAPTERS.claude.buildArgs({ settings: {} });
  const guarded = ADAPTERS.claude.buildArgs({ settings: {}, protectEnv: true });
  assert.ok(!plain.includes('--disallowedTools'));
  assert.deepStrictEqual(guarded.slice(guarded.indexOf('--disallowedTools') + 1), ENV_DENY);
  assert.ok(guarded.includes('--dangerously-skip-permissions'));
  // API anahtarı ajanlara aktarılmaz: Claude abonelik girişiyle çalışır.
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  process.env.ANTHROPIC_AUTH_TOKEN = 'tok';
  try {
    const env = agentEnv();
    assert.ok(!('ANTHROPIC_API_KEY' in env) && !('ANTHROPIC_AUTH_TOKEN' in env));
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  }
  // İnceleyicinin alıntıladığı rastgele bir JSON "sonuç" sayılmaz.
  assert.strictEqual(conforms({ name: 'x', version: '1.0.0' }, P.DEEP_REVIEW_SCHEMA), false);
  assert.strictEqual(conforms({ verdict: 'pass', summary: 's', issues: [], requirementChecks: [], testsRun: [] }, P.DEEP_REVIEW_SCHEMA), true);
  assert.strictEqual(conforms({ summary: 's', findings: 'yok' }, P.SPECIALIST_SCHEMA), false);
  assert.strictEqual(conforms([1], P.SPECIALIST_SCHEMA), false);
  assert.strictEqual(conforms({ results: [] }, P.PANEL_VERIFY_SCHEMA), true);
});

// ---------- orkestratör ----------
function orch(job = {}) {
  const { Orchestrator } = require('../src/main/orchestrator');
  const events = [];
  const o = new Orchestrator({ emit: (e) => events.push(e) });
  o.job = { id: 'mun446n8-aaaaaa', idea: 'Bir görev uygulaması yap', projectDir: tmp(), agent: 'claude', tasks: [], userNotes: [], stats: { agentRuns: 0, costUsd: 0, geminiTokens: 0 }, plan: { requirements: [{ id: 'R1', text: 'a' }, { id: 'R2', text: 'b' }], language: 'English' }, ...job };
  o.log = () => {};
  return { o, events };
}

test('İnceleme kapıları: eksik gereksinim ve inceleyicinin başarısız testi onayı düşürür; puan 1–10 aralığında kalır', () => {
  const { o } = orch();
  const pass = { verdict: 'pass', summary: 'iyi', issues: [], acceptanceChecks: [], requirementChecks: [], qualityScore: 9, fixInstructions: '' };
  assert.strictEqual(o.normalizeReview(pass, []).verdict, 'pass');
  // Gemini "onay" dese de kapsamındaki gereksinim eksikse düzeltme açılır.
  const r1 = o.normalizeReview({ ...pass, requirementChecks: [{ id: 'R2', status: 'missing', evidence: 'rota yok' }] }, []);
  assert.strictEqual(r1.verdict, 'fix');
  assert.match(r1.issues[0], /Gereksinim karşılanmadı: R2 — rota yok/);
  assert.ok(r1.fixInstructions);
  assert.strictEqual(o.normalizeReview({ ...pass, requirementChecks: [{ id: 'R2', status: 'partial', evidence: 'x' }] }, []).verdict, 'pass');
  // Puan: 85, 0, "9/10" gibi değerler düzeltilir.
  assert.strictEqual(o.normalizeReview({ ...pass, qualityScore: 85 }, []).qualityScore, 10);
  assert.strictEqual(o.normalizeReview({ ...pass, qualityScore: 0 }, []).qualityScore, null);
  assert.strictEqual(o.normalizeReview({ ...pass, qualityScore: '9/10' }, []).qualityScore, 9);
  // Claude derin inceleme: genel kararı "pass" olsa bile eksik gereksinim ve kendi çalıştırdığı başarısız komut engelleyicidir.
  const deep = { verdict: 'pass', summary: 'tamam', issues: [], requirementChecks: [{ id: 'R1', status: 'missing', evidence: 'uygulanmamış' }], testsRun: [{ command: 'npm test', result: 'fail', note: '2 test kırık' }, { command: 'npx playwright test', result: 'skipped', note: 'izin yok' }] };
  const merged = o.mergeDeep(o.normalizeReview(pass, []), deep);
  assert.strictEqual(merged.verdict, 'fix');
  assert.strictEqual(merged.deep.verdict, 'fix');
  assert.strictEqual(merged.issues.length, 2, 'atlanan (skipped) komut sorun sayılmaz');
  assert.match(merged.fixInstructions, /Requirement R1 is not implemented/);
  assert.match(merged.fixInstructions, /`npm test` and it failed/);
  assert.deepStrictEqual(o.deepBlocking(deep).map((i) => i.title), ['Requirement R1 not implemented', 'Command failed: npm test']);
  // Temiz derin inceleme onayı bozmaz.
  assert.strictEqual(o.mergeDeep(o.normalizeReview(pass, []), { verdict: 'pass', summary: 's', issues: [], requirementChecks: [{ id: 'R1', status: 'met', evidence: 'e' }], testsRun: [{ command: 'npm test', result: 'pass' }] }).verdict, 'pass');
});

test('Paralel adımlar: biri hata verince diğerleri durdurulur ve iş gerçek hatayla biter', async () => {
  const jobs = require('../src/main/jobs');
  jobs._setRoot(tmp());
  try {
    const { o, events } = orch({ tasks: [{ id: 't1', status: 'reviewing' }] });
    let siblingAborted = false;
    await new Promise((resolve) => {
      const origEmit = o.emit;
      o.emit = (e) => {
        origEmit(e);
        if (e.type === 'busy' && e.busy === false) resolve();
      };
      o.guarded(async () => {
        await o.together([
          new Promise((_, reject) => setTimeout(() => reject(new Error('Gemini 503: geçici hata')), 20)),
          new Promise((_, reject) => o.signal.addEventListener('abort', () => {
            siblingAborted = true;
            reject(new Error('Durduruldu'));
          })),
        ]);
      });
    });
    assert.ok(siblingAborted, 'kardeş adım durdurulmalı');
    assert.strictEqual(o.job.phase, 'failed', 'kullanıcı durdurmadı: "durduruldu" değil "hata"');
    assert.strictEqual(o.job.error, 'Gemini 503: geçici hata');
    assert.strictEqual(o.job.tasks[0].status, 'failed');
    assert.strictEqual(o.running, false);
    assert.ok(events.some((e) => e.type === 'busy' && e.busy === true));

    // Kullanıcının durdurması: "durduruldu" ve görev yeniden sıraya girer.
    const b = orch({ tasks: [{ id: 't1', status: 'running' }] });
    await new Promise((resolve) => {
      const origEmit = b.o.emit;
      b.o.emit = (e) => {
        origEmit(e);
        if (e.type === 'busy' && e.busy === false) resolve();
      };
      b.o.guarded(() => b.o.sleep(60000));
      setTimeout(() => b.o.stop(), 20);
    });
    assert.strictEqual(b.o.job.phase, 'stopped');
    assert.strictEqual(b.o.job.tasks[0].status, 'pending');
    // İptal edilmiş bir çalışmada bekleme hemen döner.
    b.o.ctrl = new AbortController();
    b.o.ctrl.abort();
    await assert.rejects(() => b.o.sleep(60000), /Durduruldu/);
    // Oturum hatası arayüze "giriş gerekli" olarak işaretlenir.
    const c = orch();
    c.o.ctrl = new AbortController();
    c.o.fail(new Error('Failed to authenticate: OAuth session expired'));
    assert.strictEqual(c.o.job.errorKind, 'auth');
  } finally {
    jobs.flushAll();
    jobs._setRoot(null);
  }
});

test('Bağlantı kesintisi: adım başarısız sayılmaz, bağlantı gelince aynı oturumdan sürer; gelmezse iş açık hatayla durur', async () => {
  const agents = require('../src/main/agents');
  const gemini = require('../src/main/gemini');
  const net = require('../src/main/net');
  const jobs = require('../src/main/jobs');
  // Başarısız oturumun türü: giriş sorunu > kullanım limiti > bağlantı > sıradan hata.
  const kind = agents.failureKind;
  assert.strictEqual(kind("API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)"), 'offline');
  assert.strictEqual(kind('API Error: Connection error.'), 'offline');
  assert.strictEqual(kind('API Error: 503 {"type":"error","error":{"type":"api_error","message":"Service Unavailable"}}'), 'offline');
  assert.strictEqual(kind('stream disconnected before completion: error sending request for url (https://api.openai.com/v1/responses)'), 'offline');
  assert.strictEqual(kind('getaddrinfo EAI_AGAIN api.anthropic.com'), 'offline');
  assert.strictEqual(kind('Claude AI usage limit reached|1790000000'), 'limited');
  assert.strictEqual(kind('API Error: 529 Overloaded'), 'limited');
  assert.strictEqual(kind('Failed to authenticate: OAuth session expired (connection error)'), 'auth');
  assert.strictEqual(kind('error_max_turns'), 'error');
  assert.strictEqual(kind('Tests failed: 3 of 20'), 'error');
  // Gemini: bağlantı ve ağ geçidi hataları bağlantı sorunudur; kota ve model hataları değildir.
  assert.ok(gemini.isNetworkError(Object.assign(new TypeError('Gemini bağlantı hatası: getaddrinfo ENOTFOUND'), { network: true })));
  assert.ok(gemini.isNetworkError({ status: 503 }));
  assert.ok(!gemini.isNetworkError({ status: 429 }) && !gemini.isNetworkError(new TypeError('x is not a function')) && !gemini.isNetworkError(new SyntaxError('JSON')));

  jobs._setRoot(tmp());
  const saved = { run: agents.runAgent, wait: net.waitOnline, gen: gemini.generate };
  const OFFLINE = { ok: false, offline: true, error: "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)", sessionId: 'sess-1', costUsd: 1 };
  const make = (results) => {
    const { o } = orch();
    o.ctrl = new AbortController();
    o.logs = [];
    o.log = (src, lvl, text) => o.logs.push(`${src}/${lvl}: ${text}`);
    o.sleeps = [];
    o.sleep = async (ms) => o.sleeps.push(ms);
    o.cleanupOrphans = async () => {};
    const calls = [];
    agents.runAgent = async (a) => {
      calls.push({ prompt: a.prompt, resumeId: a.resumeId, mode: a.mode, schema: a.schema });
      return results[Math.min(calls.length - 1, results.length - 1)];
    };
    return { o, calls };
  };
  try {
    const probed = [];
    net.waitOnline = async (host) => {
      probed.push(host);
      return true;
    };
    // Plan oturumu (salt okunur, şemalı) kesintide düştü: bağlantı beklenir, AYNI oturumdan devam edilir.
    const schema = { type: 'object', properties: { spec: { type: 'string' } } };
    const a = make([OFFLINE, OFFLINE, { ok: true, structured: { spec: 'x' }, sessionId: 'sess-1', costUsd: 2 }]);
    const res = await a.o.runAgent('PLAN İSTEMİ', { mode: 'review', schema, agentId: 'claude', label: 'plan yazımı', src: 'review' });
    assert.deepStrictEqual([res.ok, res.structured], [true, { spec: 'x' }]);
    assert.deepStrictEqual(a.calls.map((c) => c.resumeId || null), [null, 'sess-1', 'sess-1']);
    assert.strictEqual(a.calls[0].prompt, 'PLAN İSTEMİ');
    assert.match(a.calls[1].prompt, /interrupted by a network outage[\s\S]*final output must still have the form/);
    assert.ok(a.calls.every((c) => c.schema === schema && c.mode === 'review'), 'şema ve salt okunur mod korunur');
    assert.deepStrictEqual(probed, ['api.anthropic.com', 'api.anthropic.com']);
    assert.deepStrictEqual(a.o.sleeps, [15000, 30000], 'denemeler arasında artan bekleme');
    assert.strictEqual(a.o.logs.filter((l) => /^system\/warn: Claude Code sunucusuna ulaşılamadı .*adım başarısız sayılmadı/.test(l)).length, 2);
    assert.ok(!a.o.logs.some((l) => /\/error:/.test(l)), 'kesinti hata olarak günlüğe düşmez');
    assert.deepStrictEqual([a.o.job.waitUntil, a.o.job.waitKind, a.o.job.stats.costUsd], [null, null, 4]);
    // Kodlama oturumu: görev kaldığı yerden tamamlanır.
    const b = make([OFFLINE, { ok: true, text: 'bitti', sessionId: 'sess-1' }]);
    await b.o.runAgent('GÖREV', { label: 'görev 1' });
    assert.match(b.calls[1].prompt, /network outage[\s\S]*finish the task completely/);
    assert.strictEqual(b.calls[1].resumeId, 'sess-1');
    // Kesinti sürerken hata tekrarlanırsa deneme sayısı sınırlıdır; sonunda gerçek hata yukarı taşınır.
    const c = make([OFFLINE]);
    await assert.rejects(() => c.o.runAgent('GÖREV', {}), /Can't reach the API server/);
    assert.strictEqual(c.calls.length, 7, '6 yeniden deneme');
    assert.strictEqual(c.o.sleeps[5], 300000, 'bekleme 5 dakikayı aşmaz');
    // Bağlantı saatlerce gelmezse iş durur (yedek yollar hatayı yutamaz) ve nedeni açıkça yazılır.
    net.waitOnline = async () => false;
    const d = make([OFFLINE]);
    await assert.rejects(() => d.o.runAgent('GÖREV', {}), /İnternet bağlantısı .* yok; iş durduruldu[\s\S]*Sürdür/);
    assert.ok(d.o.signal.aborted && /İnternet bağlantısı/.test(d.o.crash.message));
    assert.throws(() => d.o.checkAbort(), /Durduruldu/);
    assert.deepStrictEqual([d.o.job.waitUntil, d.o.job.waitKind], [null, null]);

    // Gemini: istemcinin kendi denemeleri yetmediyse bağlantı beklenir ve çağrı yinelenir.
    net.waitOnline = async (host) => {
      probed.push(host);
      return true;
    };
    const g = make([]);
    let n = 0;
    gemini.generate = async () => {
      if (n++ === 0) throw Object.assign(new TypeError('Gemini bağlantı hatası: getaddrinfo ENOTFOUND generativelanguage.googleapis.com'), { network: true });
      return { verdict: 'approve' };
    };
    assert.deepStrictEqual(await g.o.gem({ system: 's', parts: [{ text: 'p' }] }), { verdict: 'approve' });
    assert.strictEqual(probed[probed.length - 1], 'generativelanguage.googleapis.com');
    assert.ok(g.o.logs.some((l) => /^system\/warn: Gemini sunucusuna ulaşılamadı/.test(l)) && g.o.logs.some((l) => /Bağlantı var; devam ediliyor/.test(l)));
    // Kota hatası bağlantı sorunu değildir: beklenmez, olduğu gibi yukarı taşınır.
    gemini.generate = async () => {
      throw Object.assign(new Error('Gemini 429: quota'), { status: 429 });
    };
    const before = probed.length;
    await assert.rejects(() => g.o.gem({ system: 's', parts: [] }), /429/);
    assert.strictEqual(probed.length, before);
    // Planlama: bağlantı ya da limit sorunu Gemini planlayıcıya düşürmez; iş o hatayla durur ("Sürdür" ile sürer).
    const pl = make([]);
    pl.o.reviewerId = () => 'claude';
    const planArgs = { baseV: 'b', head: { projectName: 'p', summary: 's', stack: [], language: 'Turkish', assumptions: [], threatModel: [], requirements: [] }, uncoveredOf: () => [], thinOf: () => [], cleanMd: (t) => t };
    for (const msg of ["API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)", 'Claude AI usage limit reached|1790000000', 'Failed to authenticate: OAuth session expired']) {
      pl.o.runAgent = async () => {
        throw new Error(msg);
      };
      await assert.rejects(() => pl.o.claudePlan(planArgs), new RegExp(msg.slice(0, 24).replace(/[|]/g, '.')));
    }
    // Kullanılabilir plan gelmediyse (oturum çöktü, biçimsiz yanıt) Gemini planlayıcı yedektir.
    pl.o.runAgent = async () => {
      throw new Error('Claude Code başlatılamadı: spawn EACCES');
    };
    assert.strictEqual(await pl.o.claudePlan(planArgs), null);
    pl.o.runAgent = async () => ({ ok: true, structured: { spec: 'kısa', tasks: [] } });
    assert.strictEqual(await pl.o.claudePlan(planArgs), null);
    // Paralel oturumlar aynı kesintiyi birlikte bekler (tek uyarı, tek yoklama).
    const p = make([]);
    const waits = [];
    net.waitOnline = async (host) => {
      waits.push(host);
      return true;
    };
    await Promise.all([p.o.awaitNetwork('Claude Code', 'api.anthropic.com', 'ENOTFOUND', 1), p.o.awaitNetwork('Claude Code', 'api.anthropic.com', 'ENOTFOUND', 1), p.o.awaitNetwork('Gemini', 'generativelanguage.googleapis.com', 'ENOTFOUND', 1)]);
    assert.deepStrictEqual([waits.length, p.o.logs.filter((l) => /ulaşılamadı/.test(l)).length, p.o.netWait], [1, 1, null]);
  } finally {
    agents.runAgent = saved.run;
    net.waitOnline = saved.wait;
    gemini.generate = saved.gen;
    jobs.flushAll();
    jobs._setRoot(null);
  }
  // Doğrulama komutları: internet yokken başarısız olan kurulum kod hatası sayılmaz; bağlantı gelince yeniden çalışır.
  {
    jobs._setRoot(tmp());
    const savedNet = { wait: net.waitOnline, reach: net.reachable };
    try {
      const { o } = orch();
      o.ctrl = new AbortController();
      o.logs = [];
      o.log = (src, lvl, text) => o.logs.push(`${src}/${lvl}: ${text}`);
      o.sleep = async () => {};
      const offlineRun = [{ name: 'Bağımlılıklar', cmd: 'npm install', ok: false, code: 1, output: 'npm error code ENOTFOUND\nnpm error network request to https://registry.npmjs.org/zod failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org' }];
      const okRun = [{ name: 'Bağımlılıklar', cmd: 'npm install', ok: true, code: 0, output: '' }, { name: 'Testler', cmd: 'npm test', ok: true, code: 0, output: '' }];
      let runs = 0;
      const hosts = [];
      net.reachable = async (host) => {
        hosts.push(host);
        return false;
      };
      net.waitOnline = async () => true;
      assert.strictEqual(await o.checksOnline(async () => (runs++ === 0 ? offlineRun : okRun)), okRun);
      assert.deepStrictEqual([runs, hosts], [2, ['registry.npmjs.org']]);
      assert.ok(o.logs.some((l) => /^system\/warn: Paket deposu sunucusuna ulaşılamadı/.test(l)) && o.logs.some((l) => /yeniden çalıştırılıyor/.test(l)));
      // Depoya ulaşılabiliyorsa hata komutundur: beklenmez, sonuç olduğu gibi döner.
      net.reachable = async () => true;
      runs = 0;
      assert.strictEqual(await o.checksOnline(async () => (runs++, offlineRun)), offlineRun);
      assert.strictEqual(runs, 1);
      // Yerel servis kapalıysa (ECONNREFUSED) ya da test başarısızsa internet beklenmez; tek sonuç ve null da geçer.
      const dbDown = [{ name: 'Testler', cmd: 'npm test', ok: false, code: 1, output: 'connect ECONNREFUSED 127.0.0.1:5432' }];
      net.reachable = async () => {
        throw new Error('yoklanmamalı');
      };
      assert.strictEqual(await o.checksOnline(async () => dbDown), dbDown);
      const single = { name: 'Temiz kurulum (yeni klon)', cmd: 'yeni klon: npm ci', ok: true, fresh: true, output: '' };
      assert.strictEqual(await o.checksOnline(async () => single), single);
      assert.strictEqual(await o.checksOnline(async () => null), null);
      // Python projesinde PyPI yoklanır.
      net.reachable = async (host) => {
        hosts.push(host);
        return true;
      };
      await o.checksOnline(async () => [{ name: 'Bağımlılıklar', cmd: 'pip install -r requirements.txt', ok: false, code: 1, output: 'Temporary failure in name resolution' }]);
      assert.strictEqual(hosts[hosts.length - 1], 'pypi.org');
    } finally {
      net.waitOnline = savedNet.wait;
      net.reachable = savedNet.reach;
      jobs.flushAll();
      jobs._setRoot(null);
    }
  }
  // Yoklama: bağlantı gelene kadar aralıklarla dener; süre dolarsa false; iptal edilirse reddeder.
  let tries = 0;
  assert.strictEqual(await net.waitOnline('h', { everyMs: 1, probe: async () => ++tries >= 3 }), true);
  assert.strictEqual(tries, 3);
  assert.strictEqual(await net.waitOnline('h', { everyMs: 1, maxMs: 5, probe: async () => false }), false);
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(() => net.waitOnline('h', { signal: ctrl.signal, probe: async () => false }), /Durduruldu/);
});

test('Eylem korumaları ve yedek rapor', () => {
  const { o } = orch({ phase: 'done', tasks: [{ id: 't1', title: 'Sepet', status: 'done', review: { qualityScore: 9 } }], reqStatus: { R1: 'met', R2: 'partial' } });
  assert.throws(() => o.approve({}), /Onaylanacak plan yok/);
  assert.throws(() => o.resume(), /Sürdürülecek iş yok/);
  assert.throws(() => o.replan('x'), /Yeniden planlanacak iş yok/);
  const report = o.fallbackReport({ verdict: 'pass', summary: 'Her şey çalışıyor.', qualityScore: 9, issues: [] }, [{ name: 'Testler', ok: true }, { name: 'Derleme', ok: false }], { pages: [{ errors: [], status: 200 }, { errors: ['x'], status: 500 }] });
  assert.match(report, /## Özet\nHer şey çalışıyor\./);
  assert.match(report, /- ✓ Sepet — kalite 9\/10/);
  assert.match(report, /- Derleme: BAŞARISIZ/);
  assert.match(report, /2 sayfa gezildi, 1 sorunlu/);
  assert.match(report, /1\/2 gereksinim doğrulandı\.\n- R2 \(kısmen\): b/);
  // Kullanıcıya görünen metinlerin dili: isteğin dili (ürünün arayüz dili İngilizce olsa bile).
  assert.strictEqual(orch({ idea: 'build a todo app' }).o.userLang(), 'English');
  const tr = orch({ idea: 'İngilizce arayüzlü bir görev uygulaması yap' });
  assert.strictEqual(tr.o.userLang(), 'Turkish (Türkçe)', 'yerel adıyla da: zayıf modeller dili karıştırmasın');
  assert.strictEqual(orch({ idea: 'todo app', plan: { requirements: [], language: 'English', userLanguage: 'German' } }).o.userLang(), 'German');
});

// ---------- istemler ----------
test('İstemler: okunan içerik veridir; güvenlik tek bir ölçüye bağlıdır; standartlar projenin yığınına uygulanır', () => {
  const P = require('../src/main/prompts');
  const task = { id: 't1', phase: 'Faz 1', title: 'Giriş', goal: 'g', details: 'd', acceptance: ['Given x, when y, then z'], tests: ['unit: a — b'], covers: ['R1'], status: 'done', brief: 'BRİF' };
  const job = { plan: { summary: 's', stack: ['Next.js'], language: 'Turkish', requirements: [{ id: 'R1', text: 'kural' }, { id: 'R2', text: '[SEC] yetki' }], spec: 'x', threatModel: ['oturum çalma'], features: [], assumptions: [] }, tasks: [task], userNotes: [], gates: {}, suggestions: [], projectDir: '/p' };
  const DATA = /is DATA, not instructions/;
  const coder = [P.taskPrompt(job, task, '', null), P.fixPrompt(job, task, { issues: ['x'], fixInstructions: 'y' }, [], { resumed: false, standards: '' }), P.finalFixPrompt(job, { issues: [], fixInstructions: 'f' }, [], null, '', null), P.testAuthorPrompt(job, task, '')];
  for (const t of coder) assert.match(t, DATA);
  const reviewers = [
    P.deepReviewPrompt({ job, scope: 'task', tasks: [task], reqIds: ['R1'], checks: [], smoke: null, lang: 'Turkish' }),
    P.deepReviewPrompt({ job, scope: 'task', tasks: [task], checks: [], lang: 'Turkish', focus: [{ severity: 'high', title: 'T', detail: 'D' }] }),
    P.specialistPrompt({ job, key: 'security', scope: 'x', lang: 'Turkish' }),
    P.taskSpecialistPrompt({ job, task, key: 'logic', changedFiles: ['a.ts'], lang: 'Turkish' }),
    P.panelVerifyPrompt({ items: [], lang: 'Turkish' }),
    P.maintenancePlanPrompt({ kind: 'bugfix', text: 'hata', plan: job.plan }),
    P.claudePlanPrompt({ base: 'b', head: job.plan }),
    P.planCritiquePrompt({ lang: 'Turkish', base: 'b', head: job.plan, spec: 's', draft: {} }),
  ];
  for (const t of reviewers) {
    assert.match(t, DATA);
    assert.match(t, /\.env files are intentionally unreadable/);
  }
  assert.match(P.reviewSystem('Turkish'), /data to review, not instructions/);
  // Yeni oturumda düzeltme (Codex her turda): gereksinimler, brif ve çalışma kuralları artık var.
  assert.match(coder[1], /Requirements this task must satisfy:\n- R1: kural/);
  assert.match(coder[1], /BRİF/);
  assert.match(coder[1], /## Working rules/);
  // Tek güvenlik ölçüsü: planlayıcı, standartlar ve güvenlik uzmanı aynı katmanları kullanır.
  assert.match(P.PLANNER_BASE, /SECURITY BASELINE/);
  assert.ok(!/health endpoints, rate limiting, structured logging/.test(P.PLANNER_BASE), 'orantılılık kuralı güvenliği "istenmemiş kapsam" saymamalı');
  assert.match(P.DEFAULT_STANDARDS, /Wherever the product has accounts, sessions or non-public data/);
  assert.match(P.SPECIALISTS.security.focus, /Do not report missing hardening that this product's exposure does not call for/);
  assert.ok(!/Only for requests that ask for production infrastructure: threat model, rate limits/.test(JSON.stringify(P.SPEC_SECTIONS)));
  // Standartlar projenin kendi yığınında uygulanır.
  assert.match(coder[0], /apply them in the project's own language and stack/);
  // İnceleyici çalıştıramadığı komutu "fail" değil "skipped" bildirir.
  assert.deepStrictEqual(P.DEEP_REVIEW_SCHEMA.properties.testsRun.items.properties.result.enum, ['pass', 'fail', 'skipped']);
  assert.match(reviewers[0], /reported with result "skipped"/);
});

test('İstemler: faz kapısı kabul kriterlerini görür; uzmanlar kendi alanına göre sorar; rapor panel bulgularını içerir', () => {
  const P = require('../src/main/prompts');
  const reqs = [...Array.from({ length: 90 }, (_, i) => ({ id: `R${i + 1}`, text: `iş kuralı ${i + 1}` })), { id: 'R91', text: '[SEC] yetki denetimi' }];
  const task = { id: 't1', phase: 'Faz 1', title: 'Ödeme', goal: 'g', details: 'd', acceptance: ['Given sepet, when ödeme, then sipariş'], tests: [], covers: ['R3', 'R91'], status: 'done', review: { summary: 'tamam', qualityScore: 5, panel: { confirmed: [{ severity: 'high', area: 'security', title: 'IDOR', file: 'a.ts' }] } } };
  const job = { plan: { summary: 's', stack: ['Next.js'], language: 'Turkish', requirements: reqs, spec: 'x', threatModel: ['sipariş numarası tahmini'], features: ['f'], assumptions: [] }, tasks: [task], userNotes: [], gates: { 'Faz 1': { status: 'passed', review: { qualityScore: 8, panel: { confirmed: [{ severity: 'medium', area: 'logic', title: 'Yarış', file: 'b.ts' }] } } } }, suggestions: [], projectDir: '/p', idea: 'i' };
  // Faz kapısı: görevlerin kabul kriterleri ve kapsadığı gereksinimler incelemeciye verilir.
  const gate = P.finalReviewParts({ job, checks: [{ name: 'Testler', cmd: 'npm test', ok: false, timedOut: true, output: 'x' }], smoke: null, diff: null, phase: 'Faz 1' })[0].text;
  assert.match(gate, /Covers: R3, R91\n  Acceptance criteria:\n    - Given sepet, when ödeme, then sipariş/);
  assert.match(gate, /→ TIMEOUT/);
  assert.ok(!/Acceptance criteria:/.test(P.finalReviewParts({ job, checks: [], smoke: null, diff: null })[0].text), 'son kabulde görev başlıkları yeter');
  // Güvenlik uzmanı [SEC] gereksinimlerini (listenin sonunda olsalar da) ve tehdit modelini görür.
  const sec = P.specialistPrompt({ job, key: 'security', scope: 'x', lang: 'Turkish' });
  assert.ok(sec.indexOf('R91: [SEC] yetki denetimi') < sec.indexOf('R1: iş kuralı 1'));
  assert.match(sec, /# Threat model of this product\n- sipariş numarası tahmini/);
  assert.match(P.specialistPrompt({ job, key: 'logic', scope: 'x', lang: 'Turkish' }), /R90: iş kuralı 90/);
  // Görev sonu: her uzman kendi yöntemiyle; iş kuralları uzmanı görevin gereksinimlerini görür.
  const tLogic = P.taskSpecialistPrompt({ job, task, key: 'logic', changedFiles: ['a.ts'], lang: 'Turkish' });
  assert.match(tLogic, /# Requirements this task must satisfy\n- R3: iş kuralı 3\n- R91: \[SEC\] yetki denetimi/);
  assert.match(tLogic, /prove from the changed code that each ALWAYS holds/);
  assert.ok(!/who can reach it, what it trusts/.test(tLogic));
  const tSec = P.taskSpecialistPrompt({ job, task, key: 'security', changedFiles: ['a.ts'], lang: 'Turkish' });
  assert.match(tSec, /R91 \[claimed by this task\]/);
  assert.match(P.taskSpecialistPrompt({ job, task, key: 'quality', changedFiles: [], lang: 'Turkish' }), /test realism for the changed code/);
  // Rapor: panel açıkken güvenlik bölümü "yok" demez; doğrulanmış bulgular listelenir.
  const rep = P.reportUserText({ job, checks: [], smoke: { pages: [{ route: '/', viewport: 'masaüstü', status: null, errors: [] }] }, finalReview: { verdict: 'pass', summary: 's', issues: [], panel: { confirmed: [{ severity: 'medium', area: 'quality', title: 'Test zayıf', file: 'c.ts' }] } } });
  assert.match(rep, /task "Ödeme": \[high\/security\] IDOR \(a\.ts\)/);
  assert.match(rep, /phase gate "Faz 1": \[medium\/logic\] Yarış/);
  assert.match(rep, /final acceptance: \[medium\/quality\] Test zayıf/);
  assert.match(rep, /HTTP \?/);
  assert.match(rep, /quality -\/10/);
  // .env: kullanıcı anahtar girdiyse dosyanın okunamadığı ve nasıl ayar ekleneceği söylenir.
  const env = P.envBlock({ names: ['STRIPE_SECRET_KEY'], missing: [], present: ['DATABASE_URL', 'STRIPE_SECRET_KEY'] });
  assert.match(env, /cannot be read or edited with your tools/);
  assert.match(env, /It currently also defines: DATABASE_URL\./);
});

// ---------- doğrulama komutları ----------
test('Doğrulama: "! komut" hata vermeli; başarılı biterse, zaman aşımına uğrarsa ya da bulunamazsa geçmez', async () => {
  const { planChecks, runChecks } = require('../src/main/verify');
  const P = require('../src/main/prompts');
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"cli"}');
  fs.mkdirSync(path.join(dir, 'node_modules'));
  const node = JSON.stringify(process.execPath);
  const cmds = [`${node} -e "process.exit(0)"`, `! ${node} -e "process.exit(1)"`, `!${node} -e "process.exit(0)"`, '! sonda-olmayan-komut-xyz', `${node} -e "process.exit(0)"`];
  const { checks } = planChecks(dir, { extraCommands: cmds, full: true });
  assert.deepStrictEqual(checks.map((c) => !!c.expectFail), [false, true, true, true], 'yinelenen komut bir kez çalışır');
  assert.match(checks[1].name, /\(hata vermeli\)$/);
  assert.ok(!checks[1].cmd.startsWith('!'));
  const results = await runChecks({ dir, extraCommands: cmds, full: true, log: () => {} });
  assert.deepStrictEqual(results.map((r) => r.ok), [true, true, false, false]);
  // İstemlerde beklenen hata açıkça görünür; ajana doğru davranışı bozmaması söylenir.
  const task = { id: 't', title: 'T', goal: 'g', details: 'd', acceptance: ['a'] };
  const job = { plan: { summary: 's', stack: [], language: 'Turkish', requirements: [], spec: 'x' }, tasks: [task], userNotes: [] };
  const fix = P.finalFixPrompt(job, { issues: ['x'], fixInstructions: 'y' }, results, null, '', null);
  assert.match(fix, /\(must exit non-zero\) → exited 0 but must fail/);
  assert.match(fix, /Never change correct behavior just to make a check pass/);
  // Planlayıcı ve yönetici kuralı biliyor.
  assert.match(P.claudePlanPrompt({ base: 'b', head: { ...job.plan, assumptions: [], stack: [] } }), /each must exit 0 when the product works/);
  assert.match(P.STEP_TASKS, /prefix the command with "! "/);
  assert.match(P.managerReviewSystem('Turkish'), /every verify command exits 0 on a working product/);
});

// ---------- tasarım dosyaları ----------
test('Tasarım ekleri: klasör ve HTML/CSS tasarım sayılır, projeye docs/sonda/design altına kopyalanır, Gemini kaynakları metin olarak görür', async () => {
  const docs = require('../src/main/docs');
  const P = require('../src/main/prompts');
  const src = tmp();
  fs.mkdirSync(path.join(src, 'site', 'css'), { recursive: true });
  fs.mkdirSync(path.join(src, 'site', 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(src, 'site', 'index.html'), '<!doctype html><link rel="stylesheet" href="css/style.css"><h1>Kervan</h1>');
  fs.writeFileSync(path.join(src, 'site', 'hakkinda.html'), '<h1>Hakkında</h1>');
  fs.writeFileSync(path.join(src, 'site', 'css', 'style.css'), 'h1{color:#c0392f}');
  fs.writeFileSync(path.join(src, 'site', 'node_modules', 'x', 'index.js'), 'x');
  fs.writeFileSync(path.join(src, 'landing.html'), '<h1>Landing</h1>');
  fs.writeFileSync(path.join(src, 'tema.css'), 'body{margin:0}');
  fs.writeFileSync(path.join(src, 'font.woff2'), Buffer.alloc(10));
  fs.writeFileSync(path.join(src, 'sartname.txt'), 'Arka uç: /api/kayit');
  // inspect: klasör hep tasarım; css/woff2 yalnızca tasarım rolünde desteklenir; metin dosyası rolüne göre.
  const folder = docs.inspect(path.join(src, 'site'));
  assert.deepStrictEqual([folder.kind, folder.role, folder.files, folder.html, folder.supported], ['folder', 'design', 3, 2, true]);
  assert.strictEqual(docs.inspect(path.join(src, 'tema.css')).supported, false, 'css doküman olarak desteklenmez');
  assert.deepStrictEqual([docs.inspect(path.join(src, 'tema.css'), 'design').kind, docs.inspect(path.join(src, 'font.woff2'), 'design').kind], ['asset', 'asset']);
  assert.strictEqual(docs.inspect(path.join(src, 'sartname.txt')).role, 'doc');
  assert.ok(docs.isDesignFile('a.scss') && !docs.isDesignFile('a.docx'));
  const clean = docs.sanitizeAttachments([
    { path: path.join(src, 'site'), name: '../../site', role: 'doc' },
    { path: path.join(src, 'landing.html'), name: 'landing.html', role: 'design' },
    { path: path.join(src, 'tema.css'), name: 'tema.css', role: 'design' },
    { path: path.join(src, 'sartname.txt'), name: 'sartname.txt' },
  ]);
  assert.deepStrictEqual(clean.map((a) => [a.name, a.kind, a.role, docs.isDesign(a)]), [['site', 'folder', 'design', true], ['landing.html', 'text', 'design', true], ['tema.css', 'asset', 'design', true], ['sartname.txt', 'text', 'doc', false]]);
  assert.strictEqual(clean[0].files, 3);
  // Projeye yazma: doküman references'a, tasarım design'a; sayfalar index önce; node_modules kopyalanmaz.
  const proj = tmp();
  const w = docs.writeToProject(proj, clean, '# spec');
  assert.deepStrictEqual(w.refs, ['docs/sonda/references/sartname.txt']);
  assert.deepStrictEqual(w.designRefs, ['docs/sonda/design/site/css/style.css', 'docs/sonda/design/site/hakkinda.html', 'docs/sonda/design/site/index.html', 'docs/sonda/design/landing.html', 'docs/sonda/design/tema.css']);
  assert.deepStrictEqual(w.designPages, ['docs/sonda/design/site/index.html', 'docs/sonda/design/landing.html', 'docs/sonda/design/site/hakkinda.html']);
  assert.ok(!fs.existsSync(path.join(proj, 'docs', 'sonda', 'design', 'site', 'node_modules')));
  assert.ok(fs.existsSync(path.join(proj, 'docs', 'sonda', 'design', 'site', 'css', 'style.css')));
  // İkinci yazma aynı sonucu verir (üst üste kopya yok), "_onizleme" adı tasarım dosyasına verilmez.
  assert.deepStrictEqual(docs.writeDesign(proj, clean).refs, w.designRefs);
  assert.deepStrictEqual(docs.writeDesign(proj, [{ path: path.join(src, 'landing.html'), name: '_onizleme', kind: 'text', role: 'design' }]).refs, ['docs/sonda/design/_onizleme-2']);
  // Gemini parçaları: klasör kaynakları metin (sayfalar önce), etiketler tasarım/doküman ayrımını taşır.
  const parts = await docs.toGeminiParts(clean);
  const texts = parts.filter((p) => p.text).map((p) => p.text);
  const idxIndex = texts.findIndex((t) => t.startsWith('\n===== DESIGN FILE: site/index.html'));
  const idxCss = texts.findIndex((t) => t.startsWith('\n===== DESIGN FILE: site/css/style.css'));
  assert.ok(idxIndex >= 0 && idxCss > idxIndex, 'sayfalar stillerden önce');
  assert.match(texts.find((t) => t.includes('DESIGN FOLDER: site')), /3 files/);
  assert.ok(texts.some((t) => t.startsWith('\n===== DESIGN FILE: landing.html =====\n<h1>Landing')));
  assert.ok(texts.some((t) => t.startsWith('\n===== DESIGN FILE: tema.css =====\nbody')));
  assert.ok(texts.some((t) => t === '\n===== ATTACHED DOCUMENT: sartname.txt ====='));
  assert.ok(!parts.some((p) => p.inlineData), 'görsel yok');
  // REQUEST.md tasarım dosyalarını ayrı listeler.
  docs.writeRequest(proj, { id: 'j1', idea: 'landing', attachments: clean });
  assert.match(fs.readFileSync(path.join(proj, 'docs', 'sonda', 'REQUEST.md'), 'utf8'), /Ekli tasarım dosyaları \(arayüzün görünümünü belirler\): docs\/sonda\/design\/site\/, docs\/sonda\/design\/landing\.html/);

  // İstemler: planlayıcı, kodlayan ajan ve inceleyiciler tasarımı bağlayıcı görür; önizlemeler Gemini'ye satır içi gider.
  fs.mkdirSync(path.join(proj, 'docs', 'sonda', 'design', '_onizleme'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'docs', 'sonda', 'design', '_onizleme', 'site-index-masaustu.jpg'), Buffer.from([0xff, 0xd8, 0xff]));
  const task = { id: 't1', phase: 'Faz 1', title: 'Landing', goal: 'g', details: 'd', acceptance: [], tests: [], covers: ['R1'], status: 'pending' };
  const job = { plan: { summary: 's', stack: ['Next.js'], language: 'Turkish', requirements: [{ id: 'R1', text: '[UI] landing tasarıma uyar' }], spec: 'x', threatModel: [], features: [], assumptions: [] }, tasks: [task], userNotes: [], gates: {}, suggestions: [], projectDir: proj, designRefs: w.designRefs, designPages: w.designPages, designPreviews: ['docs/sonda/design/_onizleme/site-index-masaustu.jpg', 'docs/sonda/design/_onizleme/yok.jpg'] };
  assert.match(P.planUserText({ idea: 'x', designNames: ['site/ (3 files)'], attachmentNames: ['sartname.txt'] }), /# Design files \(binding for the UI\)\n- site\/ \(3 files\)/);
  assert.match(P.PLANNER_BASE, /Attached DESIGN files .* define the visual design/);
  assert.match(P.claudePlanPrompt({ base: 'b', head: job.plan, job }), /docs\/sonda\/design\/site\/index\.html[\s\S]*Rendered previews[\s\S]*Inspect the design files now/);
  assert.ok(!/Design files/.test(P.claudePlanPrompt({ base: 'b', head: job.plan })), 'tasarım yoksa bölüm yok');
  const coder = P.taskPrompt(job, task, '', null);
  assert.match(coder, /## Design \(binding — the user supplied the visual design\)/);
  assert.match(coder, /docs\/sonda\/design\/_onizleme\/site-index-masaustu\.jpg/);
  assert.match(coder, /the design wins; on behavior and data, the specification wins/);
  // Tasarım yalnızca bazı ekranları kapsıyorsa (ör. sadece landing): kalan ekranlar aynı görsel dilde yapılır, hata sayılmaz.
  assert.match(coder, /Screens this design does not cover .* are built with the same design tokens and components/);
  assert.match(P.PLANNER_BASE, /A screen without a design is never an error, a blocker or a question back to the user/);
  assert.match(P.planUserText({ idea: 'x', designNames: ['landing.html'] }), /Screens they do not cover get the same visual language/);
  assert.match(P.claudePlanPrompt({ base: 'b', head: job.plan, job }), /a missing design for a screen is never an error/);
  assert.ok(!/## Design \(binding/.test(P.taskPrompt({ ...job, designRefs: [] }, task, '', null)));
  const deep = P.deepReviewPrompt({ job, scope: 'task', tasks: [task], reqIds: ['R1'], checks: [], smoke: null, lang: 'Turkish' });
  assert.match(deep, /# Design fidelity/);
  assert.match(deep, /the absence of a design for such a screen is not an issue/);
  assert.match(P.taskSpecialistPrompt({ job, task, key: 'quality', changedFiles: [], lang: 'Turkish' }), /# Design fidelity/);
  assert.ok(!/# Design fidelity/.test(P.taskSpecialistPrompt({ job, task, key: 'security', changedFiles: [], lang: 'Turkish' })), 'güvenlik uzmanı tasarımla ilgilenmez');
  const previews = P.designPreviewParts(job);
  assert.strictEqual(previews.filter((p) => p.inlineData).length, 1, 'var olmayan önizleme atlanır');
  assert.strictEqual(previews[0].text, '\n===== DESIGN PREVIEW (how the supplied design renders): docs/sonda/design/_onizleme/site-index-masaustu.jpg =====');
  const finalParts = P.finalReviewParts({ job, checks: [], smoke: null, diff: null });
  assert.ok(finalParts.some((p) => p.inlineData), 'son kabulde önizleme satır içi verilir');
  assert.match(finalParts[0].text, /# Design fidelity/);
});

test('Tasarım verilmediğinde: Gemini tasarım yönü yazar, ajan ona göre kurar, klişe "AI şablonu" yasak, inceleyiciler ölçüt olarak kullanır', () => {
  const P = require('../src/main/prompts');
  const { Orchestrator } = require('../src/main/orchestrator');
  assert.ok(P.REQUIREMENTS_SCHEMA.required.includes('designDirection'));
  assert.match(P.STEP_REQUIREMENTS, /never Inter\/Roboto\/Arial\/system-ui as the display face/);
  assert.match(P.PLANNER_BASE, /not a generic "AI template"/);
  const direction = '## Konsept\nSıcak fırın, el yapımı his.\n- Başlık: Fraunces · Gövde: Source Sans 3\n- Palet: #F6EEDD zemin, #7A3E1D birincil';
  const task = { id: 't1', phase: 'Faz 1', title: 'Ana sayfa', goal: 'g', details: 'd', acceptance: [], tests: [], covers: ['R1'], status: 'pending' };
  const mk = (extra) => ({ plan: { summary: 's', stack: ['Next.js'], language: 'Turkish', requirements: [{ id: 'R1', text: 'x' }], spec: 'x', threatModel: [], features: [], assumptions: [], verify: { routes: ['/'] }, ...extra }, tasks: [task], userNotes: [], gates: {}, suggestions: [], projectDir: '/p' });
  // Kodlayan ajan: yön varsa bağlayıcı; yön yoksa ama web arayüzü varsa önce DESIGN.md ile yön belirler; CLI'da hiçbir şey yok.
  const withDir = P.taskPrompt(mk({ designDirection: direction }), task, '', null);
  assert.match(withDir, /## Design direction \(binding — no design files were supplied, so this IS the design\)\n## Konsept/);
  assert.match(withDir, /Forbidden clichés: violet\/purple-to-blue gradients/);
  assert.match(P.taskPrompt(mk({}), task, '', null), /define a design direction for this product .* in docs\/sonda\/DESIGN\.md/);
  assert.ok(!/Design direction|Visual design/.test(P.taskPrompt(mk({ verify: { routes: [] } }), task, '', null)), 'arayüzsüz projede tasarım bölümü yok');
  // Tasarım dosyası + yön: türetilen sistem, kapsanmayan ekranlar için verilir.
  assert.match(P.taskPrompt({ ...mk({ designDirection: direction }), designRefs: ['docs/sonda/design/index.html'] }, task, '', null), /Design system derived from it \(from the plan[\s\S]*Fraunces/);
  // Planlayıcılar: şartname adımı ve Claude planı yönü görür; yönetici incelemesi doğaçlama tasarımı bulgu sayar.
  const head = { projectName: 'firin', summary: 's', stack: ['Next.js'], assumptions: [], threatModel: [], requirements: [{ id: 'R1', text: 'x' }], designDirection: direction, language: 'Turkish' };
  assert.match(P.claudePlanPrompt({ base: 'b', head }), /# Design direction \(binding for every UI task\)\n## Konsept/);
  assert.match(P.specUserText('b', head), /# Design direction \(binding for every screen\)/);
  assert.ok(!/Design direction/.test(P.specUserText('b', { ...head, designDirection: '' })));
  assert.match(P.managerReviewSystem('Turkish'), /leaves the visual design to improvisation/);
  // İnceleyiciler: yön ya da web arayüzü varsa "Visual design craft"; tasarım dosyası varsa sadakat + ustalık birlikte.
  const job = mk({ designDirection: direction });
  const deep = P.deepReviewPrompt({ job, scope: 'task', tasks: [task], reqIds: ['R1'], checks: [], smoke: null, lang: 'Turkish' });
  assert.match(deep, /# Visual design craft\nThe plan's design direction \(binding for every screen\):\n## Konsept/);
  assert.match(P.taskSpecialistPrompt({ job, task, key: 'quality', changedFiles: [], lang: 'Turkish' }), /# Visual design craft/);
  assert.match(P.deepReviewPrompt({ job: mk({}), scope: 'task', tasks: [task], reqIds: [], checks: [], smoke: null, lang: 'Turkish' }), /# Visual design craft/);
  assert.ok(!/Visual design craft/.test(P.deepReviewPrompt({ job: mk({ verify: { routes: [] } }), scope: 'task', tasks: [task], reqIds: [], checks: [], smoke: null, lang: 'Turkish' })));
  assert.match(P.designReviewText({ ...job, designRefs: ['docs/sonda/design/a.html'] }), /# Design fidelity/);
  // Şartname dosyası (SPEC.md) tasarım yönünü taşır.
  const spec = Orchestrator.prototype.specMarkdown.call({ job: { plan: { ...head, spec: 'BODY' } } });
  assert.match(spec, /## Design direction \(binding for every screen\)\n## Konsept[\s\S]*BODY/);
});
