// Yönetici seçimi testleri: Gemini (varsayılan) ya da Claude API. Ayar saklama, gizlilik, yönlendirme ve geçitler.
// Bu dosya kendi işleminde çalışır; Electron'un `app` ve `safeStorage` nesneleri burada taklit edilir.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sonda-yonetici-'));
const userData = tmp();
let encryption = false;
let decryptFails = false;
require.cache[require.resolve('electron')] = {
  id: 'electron', filename: 'electron', loaded: true,
  exports: {
    app: { getPath: () => userData },
    safeStorage: {
      isEncryptionAvailable: () => encryption,
      encryptString: (s) => Buffer.from(`enc:${[...s].reverse().join('')}`),
      decryptString: (b) => {
        if (decryptFails) throw new Error('çözülemedi');
        return [...b.toString().replace(/^enc:/, '')].reverse().join('');
      },
    },
  },
};

const settings = require('../src/main/settings');
const gemini = require('../src/main/gemini');
const anthropic = require('../src/main/anthropic');
const agents = require('../src/main/agents');
const jobs = require('../src/main/jobs');
const P = require('../src/main/prompts');
const { Orchestrator } = require('../src/main/orchestrator');

// Sahte anahtarlar parça parça kurulur: gerçek anahtar biçimindeki dizgeler gizli anahtar taramasına takılır.
const KEY = ['sk', 'ant', 'test', 'abcdefghijklmnop'].join('-');
const GKEY = ['AIza', 'gemini', 'test', 'abcdefghijklmnop'].join('');
const settingsFile = () => path.join(userData, 'settings.json');
const onDisk = () => fs.readFileSync(settingsFile(), 'utf8');
// Ayarlar bellekte önbelleğe alınır: sıfırlama dosyayı silmek değil, ayarların kendi API'siyle varsayılana dönmektir.
const reset = () => { settings.save({ managerBy: 'gemini', anthropicModel: 'claude-sonnet-5-5', clearAnthropicKey: true, clearGeminiKey: true }); };

test('Varsayılan yönetici Gemini ve Claude API modeli çok pahalı olmayan Sonnet 5.5; yönetici geçersiz değerle değişmez', () => {
  // Bu dosyanın ilk testi: ayarlar henüz dokunulmamış, gerçek varsayılanlar okunur.
  const s = settings.get();
  assert.deepStrictEqual([s.managerBy, s.anthropicModel, s.anthropicKey], ['gemini', 'claude-sonnet-5-5', '']);
  assert.strictEqual(settings.save({ managerBy: 'anthropic' }).managerBy, 'anthropic');
  assert.strictEqual(settings.save({ managerBy: 'openai' }).managerBy, 'anthropic', 'tanınmayan sağlayıcı yok sayılır');
  assert.strictEqual(settings.managerBy(), 'anthropic');
  settings.save({ managerBy: 'gemini' });
  assert.strictEqual(settings.managerBy(), 'gemini');
});

test('Claude API anahtarı: dosyada düz (şifreleme yoksa), arayüze yalnızca maskeli; silinir; geçersiz karakter reddedilir', () => {
  reset();
  encryption = false;
  const pub = settings.save({ anthropicKey: `  ${KEY}\n` });
  assert.deepStrictEqual([pub.hasAnthropicKey, pub.anthropicKeySource, pub.anthropicKeyInvalid], [true, 'file', false]);
  assert.strictEqual(pub.anthropicKeyMasked, `${KEY.slice(0, 4)}••••${KEY.slice(-4)}`);
  const view = JSON.stringify(settings.getPublic());
  assert.ok(!view.includes(KEY), 'arayüze giden ayarlarda anahtar yok');
  assert.ok(!/anthropicKey(Plain|Enc)/.test(view), 'saklama alanları da arayüze gitmez');
  assert.strictEqual(settings.get().anthropicKey, KEY);
  assert.throws(() => settings.save({ anthropicKey: 'kısa' }), /geçersiz karakter/);
  assert.throws(() => settings.save({ anthropicKey: 'anahtarım-ğüşiöç-1234567890' }), /geçersiz karakter/);
  assert.strictEqual(settings.get().anthropicKey, KEY, 'geçersiz giriş kayıtlı anahtarı bozmaz');
  const cleared = settings.save({ clearAnthropicKey: true });
  assert.deepStrictEqual([cleared.hasAnthropicKey, settings.get().anthropicKey], [false, '']);
  assert.ok(!onDisk().includes(KEY), 'silinen anahtar dosyada kalmaz');
});

test('Claude API anahtarı: şifreleme varsa yalnızca şifreli saklanır; şifresi çözülemeyen kayıt kullanılmaz', () => {
  reset();
  encryption = true;
  try {
    const pub = settings.save({ anthropicKey: KEY });
    assert.deepStrictEqual([pub.hasAnthropicKey, pub.anthropicKeySource], [true, 'keychain']);
    assert.ok(!onDisk().includes(KEY), 'düz anahtar dosyada yok');
    assert.match(onDisk(), /anthropicKeyEnc/);
    assert.strictEqual(settings.get().anthropicKey, KEY, 'şifre çözülür');
    // Anahtar zinciri çözemezse (ör. uygulama kimliği değişti) kayıt kullanılmaz; arayüz "kayıtlı değil" der.
    decryptFails = true;
    assert.deepStrictEqual([settings.get().anthropicKey, settings.getPublic().hasAnthropicKey], ['', false]);
  } finally {
    encryption = false;
    decryptFails = false;
  }
});

test('ANTHROPIC_API_KEY ortam değişkeni Sonda\'ya anahtar olmaz ve ajanların ortamından ayıklanır (abonelikle çalışmaya devam)', () => {
  reset();
  const saved = { a: process.env.ANTHROPIC_API_KEY, t: process.env.ANTHROPIC_AUTH_TOKEN };
  process.env.ANTHROPIC_API_KEY = ['sk', 'ant', 'env', 'zzzzzzzzzzzzzzzz'].join('-');
  process.env.ANTHROPIC_AUTH_TOKEN = 'token-zzzzzzzzzzzz';
  try {
    assert.strictEqual(settings.get().anthropicKey, '', 'ortam değişkeni yönetici anahtarı sayılmaz');
    assert.strictEqual(settings.getPublic().hasAnthropicKey, false);
    settings.save({ anthropicKey: KEY });
    for (const mode of ['code', 'review']) {
      const env = agents.agentRunEnv('claude', settings.get(), mode);
      assert.ok(!('ANTHROPIC_API_KEY' in env) && !('ANTHROPIC_AUTH_TOKEN' in env), `${mode}: faturalayan değişkenler ajana geçmez`);
      assert.ok(!Object.values(env).includes(KEY), `${mode}: kayıtlı yönetici anahtarı ajanın ortamında yok`);
    }
  } finally {
    for (const [k, v] of [['ANTHROPIC_API_KEY', saved.a], ['ANTHROPIC_AUTH_TOKEN', saved.t]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('Yönetici hazır mı: yalnızca SEÇİLİ sağlayıcının anahtarına bakılır; eksik iletisi doğru sağlayıcıyı söyler', () => {
  const ready = (s) => settings.managerReady(s);
  assert.deepStrictEqual([ready({ managerBy: 'gemini', geminiKey: GKEY }), ready({ managerBy: 'gemini', geminiKey: '', anthropicKey: KEY })], [true, false]);
  assert.deepStrictEqual([ready({ managerBy: 'anthropic', anthropicKey: KEY }), ready({ managerBy: 'anthropic', anthropicKey: '', geminiKey: GKEY })], [true, false]);
  assert.match(settings.managerMissingMessage({ managerBy: 'gemini' }), /Gemini API anahtarı yok/);
  assert.match(settings.managerMissingMessage({ managerBy: 'anthropic' }), /Anthropic API anahtarı yok/);
});

function orch() {
  jobs._setRoot(tmp());
  const events = [];
  const o = new Orchestrator({ emit: (e) => events.push(e) });
  o.job = { id: 'mun446n8-yonetici', idea: 'x', projectDir: tmp(), agent: 'claude', tasks: [], userNotes: [], suggestions: [], stats: { agentRuns: 0, costUsd: 0, geminiTokens: 0 }, plan: { requirements: [], language: 'Turkish', verify: {} } };
  return { o, events };
}

test('gem(): Claude API seçiliyse çağrı Claude\'a gider (şema standart JSON Schema, görüntü bozulmadan), Gemini\'ye gitmez; sayaç ayrı tutulur', async () => {
  reset();
  settings.save({ managerBy: 'anthropic', anthropicKey: KEY, anthropicModel: 'claude-sonnet-5-5', geminiKey: GKEY });
  const { o } = orch();
  const saved = { a: anthropic.generate, g: gemini.generate };
  let got = null;
  anthropic.generate = async (args) => { got = args; args.onUsage({ totalTokenCount: 1500 }); return { ok: true }; };
  gemini.generate = async () => { throw new Error('Gemini çağrılmamalıydı'); };
  try {
    const image = { inlineData: { mimeType: 'image/jpeg', data: 'QUJD' } };
    const out = await o.gem({ system: 'Sistem', parts: [{ text: 'Merhaba' }, image], schema: { type: 'OBJECT', propertyOrdering: ['a'], properties: { a: { type: 'ARRAY', items: { type: 'STRING' } } } }, temperature: 0.2, maxOutputTokens: 1000 });
    assert.deepStrictEqual(out, { ok: true });
    assert.deepStrictEqual([got.apiKey, got.model, got.temperature, got.maxOutputTokens, got.system], [KEY, 'claude-sonnet-5-5', 0.2, 1000, 'Sistem']);
    assert.deepStrictEqual(got.schema, { type: 'object', properties: { a: { type: 'array', items: { type: 'string' } } } }, 'büyük harfli Gemini şeması standart şemaya çevrilir');
    assert.deepStrictEqual(got.parts[1], image);
    assert.deepStrictEqual([o.job.stats.managerTokens, o.job.stats.geminiTokens], [1500, 0]);
  } finally {
    Object.assign(anthropic, { generate: saved.a });
    Object.assign(gemini, { generate: saved.g });
  }
});

test('gem(): varsayılan (Gemini) davranış değişmedi — Gemini anahtarı, Gemini modeli, şema olduğu gibi; Claude\'a gitmez', async () => {
  reset();
  settings.save({ anthropicKey: KEY });
  const { o } = orch();
  const saved = { a: anthropic.generate, g: gemini.generate };
  let got = null;
  gemini.generate = async (args) => { got = args; args.onUsage({ totalTokenCount: 700 }); return 'metin'; };
  anthropic.generate = async () => { throw new Error('Claude çağrılmamalıydı'); };
  try {
    const schema = { type: 'OBJECT', properties: { a: { type: 'STRING' } } };
    assert.strictEqual(await o.gem({ system: 'S', parts: [{ text: 'm' }], schema, temperature: 0.4 }), 'metin');
    assert.deepStrictEqual([got.apiKey, got.model, got.schema], [settings.get().geminiKey, settings.get().geminiModel, schema]);
    assert.deepStrictEqual([o.job.stats.geminiTokens, o.job.stats.managerTokens], [700, undefined]);
  } finally {
    Object.assign(anthropic, { generate: saved.a });
    Object.assign(gemini, { generate: saved.g });
  }
});

test('gem(): Claude API bağlantı kesintisinde bağlantıyı bekler (api.anthropic.com) ve yeniden dener', async () => {
  reset();
  settings.save({ managerBy: 'anthropic', anthropicKey: KEY });
  const { o } = orch();
  const saved = anthropic.generate;
  let calls = 0;
  const waited = [];
  anthropic.generate = async () => {
    if (++calls === 1) throw Object.assign(new TypeError('bağlantı yok'), { network: true });
    return 'geldi';
  };
  o.awaitNetwork = async (who, host) => { waited.push([who, host]); };
  try {
    assert.strictEqual(await o.gem({ parts: [{ text: 'x' }] }), 'geldi');
    assert.deepStrictEqual(waited, [['Claude API', 'api.anthropic.com']]);
  } finally {
    anthropic.generate = saved;
  }
});

test('Günlük: yönetici Claude API iken hiçbir satırda Gemini adı geçmez; Modeller satırı Claude modelini gösterir; Gemini yöneticisinde metin aynı', () => {
  reset();
  const { o, events } = orch();
  const text = (src, line) => { events.length = 0; o.log(src, 'info', line); return events.find((e) => e.type === 'log').entry.text; };
  settings.save({ managerBy: 'anthropic' });
  assert.strictEqual(text('gemini', 'Gemini tüm projeyi inceliyor…'), 'Claude API tüm projeyi inceliyor…');
  assert.strictEqual(text('system', "1 doküman Gemini'ye gönderiliyor: a.pdf"), "1 doküman Claude API'ye gönderiliyor: a.pdf", 'Sonda satırları da aynı rolden söz eder');
  assert.strictEqual(text('review', 'Plan eleştirisi yapılamadı. Gemini denetimiyle devam ediliyor.'), 'Plan eleştirisi yapılamadı. Claude API denetimiyle devam ediliyor.');
  assert.strictEqual(o.managerNote({ managerBy: 'anthropic', anthropicModel: 'claude-sonnet-5-5', geminiModel: 'g' }), 'Claude API: claude-sonnet-5-5');
  settings.save({ managerBy: 'gemini' });
  assert.strictEqual(text('gemini', 'Gemini tüm projeyi inceliyor…'), 'Gemini tüm projeyi inceliyor…');
  assert.strictEqual(text('system', "1 doküman Gemini'ye gönderiliyor: a.pdf"), "1 doküman Gemini'ye gönderiliyor: a.pdf");
  assert.strictEqual(o.managerNote({ managerBy: 'gemini', geminiModel: 'gemini-pro-latest' }), 'Gemini: gemini-pro-latest', 'varsayılanda Modeller satırı eskisiyle aynı');
});

test('Planlama geçidi: seçili yöneticinin anahtarı yoksa iş başlamaz ve ileti doğru sağlayıcıyı söyler (diğerinin anahtarı yerine geçmez)', () => {
  reset();
  const { o } = orch();
  const envKeys = ['GEMINI_API_KEY', 'GOOGLE_API_KEY'];
  const saved = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  for (const k of envKeys) delete process.env[k]; // Gemini anahtarı ortam değişkeninden de gelebilir; bu makinede olsa da test sabit kalsın
  try {
    const start = () => o.startPlanning({ idea: 'bir şey yap', projectDir: tmp(), agent: 'claude', attachments: [] });
    settings.save({ managerBy: 'anthropic', geminiKey: GKEY });
    assert.throws(start, /Anthropic API anahtarı yok/);
    settings.save({ managerBy: 'gemini', clearGeminiKey: true, anthropicKey: KEY });
    assert.throws(start, /Gemini API anahtarı yok/);
    const kind = () => o.startMaintenance({ kind: 'bugfix', projectDir: process.cwd(), agent: 'claude', items: ['x'] });
    assert.throws(kind, /Gemini API anahtarı yok/);
  } finally {
    for (const k of envKeys) if (saved[k] !== undefined) process.env[k] = saved[k];
  }
});

test('Yönetici işlerinin şemaları Claude için geçerli: üst düzey nesne ve çevrilince büyük harfli tür kalmaz', () => {
  const upper = (n) => JSON.stringify(n).match(/"type":"[A-Z]+"/g) || [];
  for (const name of ['REVIEW_SCHEMA', 'DISCOVERY_SCHEMA', 'REQUIREMENTS_SCHEMA', 'TASKS_SCHEMA', 'MANAGER_REVIEW_SCHEMA', 'MEMORY_SCHEMA', 'SECURITY_SCHEMA', 'TEST_REVIEW_SCHEMA', 'PLAN_CRITIQUE_SCHEMA']) {
    assert.ok(P[name], `${name} var`);
    const c = P.toJsonSchema(P[name]);
    assert.strictEqual(c.type, 'object', `${name}: üst düzey nesne`);
    assert.deepStrictEqual(upper(c), [], `${name}: büyük harfli tür kalmadı`);
    assert.ok(!JSON.stringify(c).includes('propertyOrdering'), `${name}: Gemini'ye özgü alan çıkarıldı`);
  }
});
