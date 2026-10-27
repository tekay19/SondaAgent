// Yönetici seçimi testleri: Claude CLI (varsayılan), Claude API ya da yerel model. Ayar saklama, gizlilik, yönlendirme ve geçitler.
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
const localllm = require('../src/main/localllm');
const claudecli = require('../src/main/claudecli');
const anthropic = require('../src/main/anthropic');
const agents = require('../src/main/agents');
const jobs = require('../src/main/jobs');
const P = require('../src/main/prompts');
const { Orchestrator } = require('../src/main/orchestrator');

// Sahte anahtarlar parça parça kurulur: gerçek anahtar biçimindeki dizgeler gizli anahtar taramasına takılır.
const KEY = ['sk', 'ant', 'test', 'abcdefghijklmnop'].join('-');
const settingsFile = () => path.join(userData, 'settings.json');
const onDisk = () => fs.readFileSync(settingsFile(), 'utf8');
// Ayarlar bellekte önbelleğe alınır: sıfırlama dosyayı silmek değil, ayarların kendi API'siyle varsayılana dönmektir.
const reset = () => { settings.save({ managerBy: 'claudecli', anthropicModel: 'claude-sonnet-5-5', clearAnthropicKey: true, clearLocalKey: true, clearNimKey: true, localModel: '', nimModel: '', claudePath: '' }); };

test('Varsayılan yönetici Claude CLI (abonelik, anahtarsız); Claude API modeli çok pahalı olmayan Sonnet 5.5; yönetici geçersiz değerle değişmez', () => {
  // Bu dosyanın ilk testi: ayarlar henüz dokunulmamış, gerçek varsayılanlar okunur.
  const s = settings.get();
  assert.deepStrictEqual([s.managerBy, s.managerClaudeModel, s.anthropicModel, s.anthropicKey], ['claudecli', '', 'claude-sonnet-5-5', '']);
  assert.strictEqual(settings.managerClaudeModelOf(s), 'claude-opus-5-5', 'yönetici modeli boşsa Ajanlar\'daki Claude modeli');
  assert.strictEqual(settings.managerClaudeModelOf({ ...s, managerClaudeModel: ' claude-sonnet-5-5 ' }), 'claude-sonnet-5-5');
  assert.strictEqual(settings.save({ managerBy: 'anthropic' }).managerBy, 'anthropic');
  assert.strictEqual(settings.save({ managerBy: 'openai' }).managerBy, 'anthropic', 'tanınmayan sağlayıcı yok sayılır');
  assert.strictEqual(settings.managerBy(), 'anthropic');
  settings.save({ managerBy: 'local' });
  assert.strictEqual(settings.managerBy(), 'local');
  settings.save({ managerBy: 'claudecli' });
  assert.strictEqual(settings.managerBy(), 'claudecli');
  assert.strictEqual(settings.managerBy({ managerBy: 'bilinmeyen' }), 'claudecli', 'tanınmayan değer varsayılana düşer');
  const pub = settings.getPublic();
  assert.deepStrictEqual([pub.managerClaudeModelEffective, pub.managerClaudeModelLabel], ['claude-opus-5-5', 'Opus 5.5']);
});

// Sahte Claude CLI: argümanlarını bir dosyaya yazar, stdin'deki isteme göre stream-json olayları basar.
function fakeClaude() {
  const dir = tmp();
  const js = path.join(dir, 'fake-claude.js');
  const argsFile = path.join(dir, 'args.json');
  fs.writeFileSync(js, `
    const fs = require('fs');
    const args = process.argv.slice(2);
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (input += d));
    process.stdin.on('end', () => {
      fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify({ args, input, cwd: process.cwd(), env: { mcp: process.env.ENABLE_CLAUDEAI_MCP_SERVERS || '' } }));
      const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
      say({ type: 'system', subtype: 'init', session_id: 's1', model: 'm' });
      if (args[1] === '--version') return;
      if (/LIMIT/.test(input)) { say({ type: 'result', subtype: 'error_during_execution', is_error: true, result: "You've hit your usage limit · resets 3pm", usage: { input_tokens: 5, output_tokens: 1 } }); return; }
      if (/OFFLINE/.test(input)) { say({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'fetch failed: getaddrinfo ENOTFOUND api.anthropic.com' }); return; }
      if (/AUTH/.test(input)) { say({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Not logged in. Please run /login' }); return; }
      const i = args.indexOf('--json-schema');
      if (i >= 0) {
        say({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'StructuredOutput', input: { ok: true, n: 1 } }] } });
        say({ type: 'result', subtype: 'success', is_error: false, result: '', structured_output: { ok: true, n: 2 }, usage: { input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 20 }, total_cost_usd: 0.01 });
      } else {
        say({ type: 'assistant', message: { content: [{ type: 'text', text: 'Merhaba ' }] } });
        say({ type: 'assistant', message: { content: [{ type: 'text', text: 'dünya' }] } });
        say({ type: 'result', subtype: 'success', is_error: false, result: 'Merhaba dünya', usage: { input_tokens: 10, output_tokens: 3 } });
      }
    });
  `);
  let bin;
  if (process.platform === 'win32') {
    bin = path.join(dir, 'claude.cmd');
    fs.writeFileSync(bin, `@echo off\r\n"${process.execPath}" "${js}" %*\r\n`);
  } else {
    bin = path.join(dir, 'claude');
    fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`, { mode: 0o755 });
  }
  return { bin, last: () => JSON.parse(fs.readFileSync(argsFile, 'utf8')) };
}

test('Claude CLI yöneticisi: araçsız, geçici klasörde, sistem istemi dosyadan, şema --json-schema ile; metin ve yapılandırılmış sonuç; sayaç', async () => {
  const fake = fakeClaude();
  const s = { ...settings.get(), claudePath: fake.bin, claudeModel: '' };
  const usage = [];
  const text = await claudecli.generate({ settings: s, model: 'claude-opus-5-5', system: 'Sen yöneticisin', parts: [{ text: 'Selam' }, { text: 'dünya' }], onUsage: (u) => usage.push(u) });
  assert.strictEqual(text, 'Merhaba dünya');
  let a = fake.last();
  assert.deepStrictEqual(usage, [{ totalTokenCount: 13, inputTokens: 10, outputTokens: 3, costUsd: 0 }]);
  assert.ok(a.args.includes('--no-session-persistence') && a.args.includes('--strict-mcp-config') && a.args.includes('--disable-slash-commands'), 'kalıcı değil, MCP yok, komut yok');
  assert.strictEqual(a.args[a.args.indexOf('--tools') + 1], '', 'araçsız oturum');
  assert.strictEqual(a.args[a.args.indexOf('--model') + 1], 'claude-opus-5-5');
  assert.strictEqual(a.args[a.args.indexOf('--effort') + 1], 'medium');
  assert.ok(a.args.includes('--system-prompt-file'), 'sistem istemi dosyadan (Windows komut satırı sınırı)');
  assert.ok(!a.args.includes('--json-schema') && !a.args.includes('--dangerously-skip-permissions'));
  assert.strictEqual(a.input, 'Selam\ndünya');
  assert.strictEqual(a.env.mcp, 'false', 'hesap bağlayıcıları kapalı');
  assert.ok(/sonda-yonetici-/.test(a.cwd), 'proje klasöründe değil, geçici klasörde (CLAUDE.md yüklenmez)');
  assert.ok(!fs.existsSync(a.cwd), 'geçici klasör silinir');
  // Şema: CLI'nin yapılandırılmış sonucu (araç çağrısındaki değil) döner; önbellek tokenları sayılır.
  const schema = { type: 'object', properties: { ok: { type: 'boolean' }, n: { type: 'number' } }, required: ['ok'] };
  const obj = await claudecli.generate({ settings: s, parts: [{ text: 'x' }], schema, onUsage: (u) => usage.push(u) });
  assert.deepStrictEqual(obj, { ok: true, n: 2 });
  a = fake.last();
  assert.deepStrictEqual(JSON.parse(a.args[a.args.indexOf('--json-schema') + 1]), schema);
  assert.strictEqual(a.args[a.args.indexOf('--model') + 1], 'claude-opus-5-5', 'model verilmezse Ajanlar\'daki Claude modeli');
  assert.deepStrictEqual(usage[1], { totalTokenCount: 170, inputTokens: 150, outputTokens: 20, costUsd: 0.01 });
  // Ekler: dosyaya yazılır, yalnızca Read açılır, istemde yeri belirtilir.
  await claudecli.generate({ settings: s, parts: [{ text: 'bak' }, { inlineData: { mimeType: 'image/jpeg', data: 'QUJD' } }, { inlineData: { mimeType: 'text/csv', data: 'QUJD' } }] });
  a = fake.last();
  assert.deepStrictEqual([a.args[a.args.indexOf('--tools') + 1], a.args[a.args.indexOf('--allowedTools') + 1]], ['Read', 'Read']);
  assert.match(a.input, /\[Attachment 1: .*ek-1\.jpg\]/);
  assert.match(a.input, /type text\/csv was omitted/);
  assert.match(a.input, /Read each attachment/);
  // Hatalar işaretli: limit (sıfırlanma saatiyle), bağlantı, oturum; CLI yoksa açık ileti.
  const lim = await claudecli.generate({ settings: s, parts: [{ text: 'LIMIT' }] }).catch((e) => e);
  assert.ok(lim.limited && lim.resetAt > Date.now(), 'limit işaretli ve sıfırlanma zamanı var');
  const off = await claudecli.generate({ settings: s, parts: [{ text: 'OFFLINE' }] }).catch((e) => e);
  assert.ok(off.network && claudecli.isNetworkError(off));
  const auth = await claudecli.generate({ settings: s, parts: [{ text: 'AUTH' }] }).catch((e) => e);
  assert.ok(auth.auth && /giriş yapın/.test(auth.message));
  await assert.rejects(claudecli.generate({ settings: { ...s, claudePath: path.join(fake.bin, '..', 'yok') }, parts: [{ text: 'x' }] }), /Claude Code bulunamadı/);
});

test('gem(): Claude CLI seçiliyse çağrı CLI istemcisine gider (anahtar yok, yönetici modeli, standart şema); limitte bekler ve yineler; günlük kaynağı yönetici', async () => {
  reset();
  const fake = fakeClaude();
  settings.save({ managerBy: 'claudecli', managerClaudeModel: 'claude-sonnet-5-5', claudePath: fake.bin });
  const { o, events } = orch();
  const saved = { c: claudecli.generate, g: localllm.generate, a: anthropic.generate };
  let got = null;
  let calls = 0;
  claudecli.generate = async (args) => {
    got = args;
    if (++calls === 1) throw Object.assign(new Error('Claude kullanım limiti'), { limited: true, resetAt: Date.now() + 1000 });
    args.onUsage({ totalTokenCount: 900 });
    return { ok: true };
  };
  localllm.generate = anthropic.generate = async () => { throw new Error('başka sağlayıcı çağrılmamalıydı'); };
  const slept = [];
  o.sleep = async (ms) => { slept.push(ms); };
  try {
    const out = await o.gem({ system: 'S', parts: [{ text: 'm' }], schema: { type: 'OBJECT', properties: { a: { type: 'STRING' } } } });
    assert.deepStrictEqual(out, { ok: true });
    assert.deepStrictEqual([got.apiKey, got.model, got.system, got.settings.claudePath], [undefined, 'claude-sonnet-5-5', 'S', fake.bin]);
    assert.deepStrictEqual(got.schema, { type: 'object', properties: { a: { type: 'string' } } });
    assert.strictEqual(o.job.stats.managerTokens, 900);
    assert.strictEqual(slept.length, 1, 'limitte bir kez beklendi');
    assert.ok(slept[0] >= 60000, 'en az sıfırlanma + 1 dk');
    assert.ok(events.some((e) => e.type === 'log' && /Claude CLI kullanım limitine takıldı/.test(e.entry.text)));
    const text = (src, line) => { events.length = 0; o.log(src, 'info', line); return events.find((e) => e.type === 'log').entry.text; };
    assert.strictEqual(text('manager', 'Yönetici tüm projeyi inceliyor…'), 'Yönetici tüm projeyi inceliyor…');
    assert.strictEqual(o.managerNote(settings.get()), 'Claude CLI (abonelik): Sonnet 5.5');
    // Hazırlık geçidi: anahtar değil Claude Code aranır.
    assert.strictEqual(settings.managerReady(settings.get()), true);
    settings.save({ claudePath: path.join(fake.bin, '..', 'yok') });
    assert.strictEqual(settings.managerReady(settings.get()), false);
    assert.match(settings.managerMissingMessage(settings.get()), /Claude Code bulunamadı/);
    assert.throws(() => o.startPlanning({ idea: 'bir şey yap', projectDir: tmp(), agent: 'claude', attachments: [] }), /Claude Code bulunamadı/);
  } finally {
    Object.assign(claudecli, { generate: saved.c });
    Object.assign(localllm, { generate: saved.g });
    Object.assign(anthropic, { generate: saved.a });
    settings.save({ claudePath: '' });
  }
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
  assert.deepStrictEqual([ready({ managerBy: 'local', localModel: 'qwen3' }), ready({ managerBy: 'local', localModel: ' ', anthropicKey: KEY })], [true, false]);
  assert.deepStrictEqual([ready({ managerBy: 'anthropic', anthropicKey: KEY }), ready({ managerBy: 'anthropic', anthropicKey: '', localModel: 'qwen3' })], [true, false]);
  assert.match(settings.managerMissingMessage({ managerBy: 'local' }), /Yerel model seçilmemiş/);
  assert.match(settings.managerMissingMessage({ managerBy: 'claudecli' }), /Claude Code bulunamadı/);
  assert.match(settings.managerMissingMessage({ managerBy: 'anthropic' }), /Anthropic API anahtarı yok/);
});

function orch() {
  jobs._setRoot(tmp());
  const events = [];
  const o = new Orchestrator({ emit: (e) => events.push(e) });
  o.job = { id: 'mun446n8-yonetici', idea: 'x', projectDir: tmp(), agent: 'claude', tasks: [], userNotes: [], suggestions: [], stats: { agentRuns: 0, costUsd: 0, managerTokens: 0 }, plan: { requirements: [], language: 'Turkish', verify: {} } };
  return { o, events };
}

test('gem(): Claude API seçiliyse çağrı Claude\'a gider (şema standart JSON Schema, görüntü bozulmadan), başka sağlayıcıya gitmez; sayaç tutulur', async () => {
  reset();
  settings.save({ managerBy: 'anthropic', anthropicKey: KEY, anthropicModel: 'claude-sonnet-5-5' });
  const { o } = orch();
  const saved = { a: anthropic.generate, g: localllm.generate, c: claudecli.generate };
  let got = null;
  anthropic.generate = async (args) => { got = args; args.onUsage({ totalTokenCount: 1500 }); return { ok: true }; };
  localllm.generate = claudecli.generate = async () => { throw new Error('başka sağlayıcı çağrılmamalıydı'); };
  try {
    const image = { inlineData: { mimeType: 'image/jpeg', data: 'QUJD' } };
    const out = await o.gem({ system: 'Sistem', parts: [{ text: 'Merhaba' }, image], schema: { type: 'OBJECT', propertyOrdering: ['a'], properties: { a: { type: 'ARRAY', items: { type: 'STRING' } } } }, temperature: 0.2, maxOutputTokens: 1000 });
    assert.deepStrictEqual(out, { ok: true });
    assert.deepStrictEqual([got.apiKey, got.model, got.temperature, got.maxOutputTokens, got.system], [KEY, 'claude-sonnet-5-5', 0.2, 1000, 'Sistem']);
    assert.deepStrictEqual(got.schema, { type: 'object', properties: { a: { type: 'array', items: { type: 'string' } } } }, 'büyük harfli eski şema standart şemaya çevrilir');
    assert.deepStrictEqual(got.parts[1], image);
    assert.strictEqual(o.job.stats.managerTokens, 1500);
  } finally {
    Object.assign(anthropic, { generate: saved.a });
    Object.assign(localllm, { generate: saved.g });
    Object.assign(claudecli, { generate: saved.c });
  }
});

test('gem(): yerel model seçiliyse çağrı yerel istemciye gider (adres, model, isteğe bağlı anahtar, standart şema); bağlantı hatası internet beklemeden olduğu gibi döner', async () => {
  reset();
  settings.save({ managerBy: 'local', localModel: 'qwen3:30b', localBaseUrl: 'http://localhost:1234/v1', localApiKey: KEY });
  const { o } = orch();
  const saved = { a: anthropic.generate, g: localllm.generate, c: claudecli.generate };
  let got = null;
  localllm.generate = async (args) => { got = args; args.onUsage({ totalTokenCount: 700 }); return 'metin'; };
  anthropic.generate = claudecli.generate = async () => { throw new Error('başka sağlayıcı çağrılmamalıydı'); };
  const waited = [];
  o.awaitNetwork = async (who, host) => { waited.push([who, host]); };
  try {
    const schema = { type: 'OBJECT', properties: { a: { type: 'STRING' } } };
    assert.strictEqual(await o.gem({ system: 'S', parts: [{ text: 'm' }], schema, temperature: 0.4 }), 'metin');
    assert.deepStrictEqual([got.baseUrl, got.model, got.apiKey, got.schema, got.temperature], ['http://localhost:1234/v1', 'qwen3:30b', KEY, { type: 'object', properties: { a: { type: 'string' } } }, 0.4]);
    assert.strictEqual(o.job.stats.managerTokens, 700);
    assert.strictEqual(settings.managerLabel(settings.get()), 'Yerel model');
    localllm.generate = async () => { throw Object.assign(new Error('Yerel model bağlantı hatası: ECONNREFUSED'), { network: true }); };
    await assert.rejects(() => o.gem({ parts: [{ text: 'x' }] }), /ECONNREFUSED/);
    assert.deepStrictEqual(waited, [], 'yerel sunucu için internet beklenmez');
  } finally {
    Object.assign(anthropic, { generate: saved.a });
    Object.assign(localllm, { generate: saved.g });
    Object.assign(claudecli, { generate: saved.c });
  }
});

test('gem(): NVIDIA NIM seçiliyse çağrı OpenAI uyumlu istemciye NIM adresi ve anahtarıyla gider; kesintide NIM sunucusu beklenir; hazırlık anahtar + model ister', async () => {
  reset();
  settings.save({ managerBy: 'nim', nimModel: 'deepseek-ai/deepseek-v3.1', nimApiKey: KEY });
  const { o } = orch();
  const saved = { a: anthropic.generate, g: localllm.generate, c: claudecli.generate };
  let got = null;
  let calls = 0;
  localllm.generate = async (args) => {
    got = args;
    if (++calls === 1) throw Object.assign(new Error('NIM bağlantı hatası: ENOTFOUND'), { network: true });
    args.onUsage({ totalTokenCount: 300 });
    return 'metin';
  };
  anthropic.generate = claudecli.generate = async () => { throw new Error('başka sağlayıcı çağrılmamalıydı'); };
  const waited = [];
  o.awaitNetwork = async (who, host) => { waited.push([who, host]); };
  try {
    assert.strictEqual(await o.gem({ parts: [{ text: 'm' }] }), 'metin');
    assert.deepStrictEqual([got.baseUrl, got.model, got.apiKey], ['https://integrate.api.nvidia.com/v1', 'deepseek-ai/deepseek-v3.1', KEY]);
    assert.deepStrictEqual(waited, [['NVIDIA NIM', 'integrate.api.nvidia.com']]);
    assert.strictEqual(o.job.stats.managerTokens, 300);
    assert.strictEqual(o.managerNote(settings.get()), 'NVIDIA NIM: deepseek-ai/deepseek-v3.1');
    assert.strictEqual(settings.managerReady(settings.get()), true);
    assert.deepStrictEqual([settings.managerReady({ managerBy: 'nim', nimApiKey: '', nimModel: 'x' }), settings.managerReady({ managerBy: 'nim', nimApiKey: KEY, nimModel: '' })], [false, false]);
    assert.match(settings.managerMissingMessage({ managerBy: 'nim', nimApiKey: '' }), /NVIDIA NIM API anahtarı yok/);
    assert.match(settings.managerMissingMessage({ managerBy: 'nim', nimApiKey: KEY }), /modeli seçilmemiş/);
    const pub = settings.getPublic();
    assert.deepStrictEqual([pub.hasNimKey, pub.nimKeyMasked, 'nimKeyPlain' in pub, 'nimKeyEnc' in pub], [true, `${KEY.slice(0, 4)}••••${KEY.slice(-4)}`, false, false]);
  } finally {
    Object.assign(anthropic, { generate: saved.a });
    Object.assign(localllm, { generate: saved.g });
    Object.assign(claudecli, { generate: saved.c });
    settings.save({ clearNimKey: true, nimModel: '' });
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

test('Günlük ve Modeller satırı: kaynak her yöneticide "manager"dır; managerNote seçili yöneticiyi ve modelini yazar', () => {
  reset();
  const { o, events } = orch();
  const text = (src, line) => { events.length = 0; o.log(src, 'info', line); return events.find((e) => e.type === 'log').entry; };
  const e = text('manager', 'Yönetici tüm projeyi inceliyor…');
  assert.deepStrictEqual([e.src, e.text], ['manager', 'Yönetici tüm projeyi inceliyor…']);
  assert.strictEqual(o.managerNote({ managerBy: 'anthropic', anthropicModel: 'claude-sonnet-5-5' }), 'Claude API: claude-sonnet-5-5');
  assert.strictEqual(o.managerNote({ managerBy: 'claudecli', managerClaudeModel: '' }), 'Claude CLI (abonelik): Opus 5.5');
  assert.strictEqual(o.managerNote({ managerBy: 'local', localModel: 'qwen3', localBaseUrl: 'http://localhost:11434/v1' }), 'Yerel model: qwen3 @ http://localhost:11434/v1');
  assert.strictEqual(o.managerNote({}), 'Claude CLI (abonelik): Opus 5.5', 'bilinmeyen / boş seçim varsayılana düşer');
});

test('Planlama geçidi: seçili yönetici hazır değilse iş başlamaz ve ileti doğru sağlayıcıyı söyler (diğerinin anahtarı yerine geçmez)', () => {
  reset();
  const { o } = orch();
  const start = () => o.startPlanning({ idea: 'bir şey yap', projectDir: tmp(), agent: 'claude', attachments: [] });
  settings.save({ managerBy: 'anthropic', clearAnthropicKey: true, localModel: 'qwen3' });
  assert.throws(start, /Anthropic API anahtarı yok/);
  settings.save({ managerBy: 'local', localModel: '', anthropicKey: KEY });
  assert.throws(start, /Yerel model seçilmemiş/);
  const kind = () => o.startMaintenance({ kind: 'bugfix', projectDir: process.cwd(), agent: 'claude', items: ['x'] });
  assert.throws(kind, /Yerel model seçilmemiş/);
  settings.save({ managerBy: 'claudecli', claudePath: path.join(tmp(), 'yok') });
  assert.throws(start, /Claude Code bulunamadı/);
  settings.save({ claudePath: '' });
});

test('Yönetici işlerinin şemaları Claude için geçerli: üst düzey nesne ve çevrilince büyük harfli tür kalmaz', () => {
  const upper = (n) => JSON.stringify(n).match(/"type":"[A-Z]+"/g) || [];
  for (const name of ['REVIEW_SCHEMA', 'DISCOVERY_SCHEMA', 'REQUIREMENTS_SCHEMA', 'TASKS_SCHEMA', 'MANAGER_REVIEW_SCHEMA', 'MEMORY_SCHEMA', 'SECURITY_SCHEMA', 'TEST_REVIEW_SCHEMA', 'PLAN_CRITIQUE_SCHEMA']) {
    assert.ok(P[name], `${name} var`);
    const c = P.toJsonSchema(P[name]);
    assert.strictEqual(c.type, 'object', `${name}: üst düzey nesne`);
    assert.deepStrictEqual(upper(c), [], `${name}: büyük harfli tür kalmadı`);
    assert.ok(!JSON.stringify(c).includes('propertyOrdering'), `${name}: eski biçime özgü alan çıkarıldı`);
  }
});

// Bu dosyanın son testi: ayar modülü taze yüklenir (önbellek sıfırlanır), eski testlerin modül başvurusu artık kullanılmaz.
test('Eski (Gemini\'li) ayar dosyası açılışta dönüştürülür: geminiRole → managerRole, gemini seçimleri bugünkü karşılığına, Gemini alanları atılır', () => {
  fs.writeFileSync(settingsFile(), JSON.stringify({ managerBy: 'gemini', geminiRole: 'full', planner: 'gemini', briefBy: 'gemini', geminiModel: 'gemini-pro-latest', geminiKeyPlain: 'AIzaEski', anthropicModel: 'claude-sonnet-5-5' }));
  delete require.cache[require.resolve('../src/main/settings')];
  const fresh = require('../src/main/settings');
  const s = fresh.get();
  assert.deepStrictEqual([s.managerBy, s.managerRole, s.planner, s.briefBy, 'geminiModel' in s, 'geminiKeyPlain' in s, 'geminiRole' in s], ['claudecli', 'full', 'manager', 'fable', false, false, false]);
  fresh.save({});
  const disk = onDisk();
  assert.ok(!/gemini/i.test(disk), 'kaydedilen dosyada Gemini alanı kalmaz');
});

test('Rol başına model: planlayıcı / kodlayıcı / inceleyici / brif ayrı seçilebilir; boş rol genel modeli izler; açık `model` her zaman kazanır', async () => {
  const models = require('../src/main/models');
  assert.deepStrictEqual(models.ROLES, ['planner', 'coder', 'reviewer', 'brief']);
  const s = { claudeModel: 'claude-opus-5-5', plannerModel: 'claude-fable-5-1', coderModel: ' ', reviewerModel: 'claude-sonnet-5-5', briefModel: '', briefBy: 'fable' };
  assert.deepStrictEqual(['planner', 'coder', 'reviewer', 'brief'].map((r) => models.roleModelOf(s, r)), ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1']);
  assert.strictEqual(models.roleModelOf({ ...s, briefModel: 'claude-opus-5-5' }, 'brief'), 'claude-opus-5-5', 'brif modeli ayarı briefBy seçimini ezer');
  assert.strictEqual(models.roleModelOf(s, 'bilinmeyen'), 'claude-opus-5-5');
  // Ayarlar: açık rol seçimi genel modelle aynı olsa da korunur (genel model sonradan değişince rol onu izlemez);
  // arayüze rollerin etkin modeli etiketiyle gider.
  const pub = settings.save({ claudeModel: '', plannerModel: 'claude-opus-5-5', reviewerModel: 'claude-sonnet-5-5', coderModel: '' });
  assert.deepStrictEqual([pub.plannerModel, pub.reviewerModel, pub.roleModels.reviewer, pub.roleModels.planner.label], ['claude-opus-5-5', 'claude-sonnet-5-5', { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }, 'Opus 5.5']);
  assert.strictEqual(settings.save({ claudeModel: 'claude-sonnet-5-5' }).roleModels.planner.id, 'claude-opus-5-5', 'genel model değişince açık planlayıcı seçimi kalır');
  settings.save({ claudeModel: '' });
  // Codex modeli: NIM'de rol başına NIM modeli → yöneticinin NIM modeli; OpenAI / yerel alanındaki ad NIM'e hiç gitmez.
  const nimS = { codexProvider: 'nim', codexModel: 'gpt-5-codex', nimModel: 'base/m', nimReviewerModel: 'r/m' };
  assert.deepStrictEqual(['coder', 'reviewer', 'brief', 'planner'].map((r) => models.codexModelFor(nimS, r)), ['base/m', 'r/m', 'r/m', 'base/m']);
  assert.strictEqual(models.codexModelFor({ ...nimS, codexProvider: 'openai' }, 'coder'), 'gpt-5-codex');
  // Claude API yöneticisinin modeli boş bırakılırsa varsayılana döner (boş model isteği 400 ile düşerdi).
  assert.strictEqual(settings.save({ anthropicModel: '  ' }).anthropicModel, 'claude-sonnet-5-5');
  // Orkestratör: oturumun rolüne göre model; salt okunur oturum inceleyici, yazma yetkili oturum kodlayıcı sayılır.
  const { o } = orch();
  const agents = require('../src/main/agents');
  const savedRun = agents.runAgent;
  const seen = [];
  agents.runAgent = async ({ settings: st }) => { seen.push(st.claudeModel); return { ok: true, text: 'x', costUsd: 0 }; };
  o.cleanupOrphans = async () => {};
  o.syncEnv = () => {};
  try {
    settings.save({ plannerModel: 'claude-fable-5-1', coderModel: '', reviewerModel: 'claude-sonnet-5-5' });
    await o.runAgent('p', { mode: 'review', role: 'planner', label: 'plan' });
    await o.runAgent('p', { mode: 'code', label: 'görev' });
    await o.runAgent('p', { mode: 'review', label: 'inceleme' });
    await o.runAgent('p', { mode: 'review', model: 'claude-opus-5-5', label: 'brif' });
    assert.deepStrictEqual(seen, ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']);
    assert.match(o.modelNote(settings.get()), /Claude modeli: Opus 5\.5 \(claude-opus-5-5\) · planlayıcı: Fable 5\.1 · inceleyici: Sonnet 5\.5/);
  } finally {
    agents.runAgent = savedRun;
    settings.save({ plannerModel: '', coderModel: '', reviewerModel: '' });
  }
});

test('Claude\'suz çalışma: salt okunur oturumlar kodlayan ajana verilir; Codex NIM ile rol başına model; brifi kodlayan ajan yazar', async () => {
  reset();
  const agents = require('../src/main/agents');
  const savedBin = agents.resolveBin;
  const savedRun = agents.runAgent;
  const { o } = orch();
  o.job.agent = 'codex';
  o.cleanupOrphans = async () => {};
  o.syncEnv = () => {};
  try {
    agents.resolveBin = (id) => (id === 'claude' ? '/bin/claude' : id === 'codex' ? '/bin/codex' : null);
    assert.strictEqual(o.reviewerId(), 'claude', 'varsayılan: Claude kuruluysa inceleyici Claude');
    settings.save({ reviewerBy: 'agent' });
    assert.strictEqual(o.reviewerId(), 'codex', 'kodlayan ajan seçildiyse Claude kurulu olsa da Codex');
    agents.resolveBin = (id) => (id === 'codex' ? '/bin/codex' : null);
    settings.save({ reviewerBy: 'auto' });
    assert.strictEqual(o.reviewerId(), 'codex', 'Claude yoksa otomatik olarak kodlayan ajan');
    // Rol başına NIM modeli: planlayıcı / inceleyici ayrı, kodlayıcı boş → yöneticinin NIM modeli; brif inceleyici modelini alır.
    settings.save({ reviewerBy: 'agent', codexProvider: 'nim', nimModel: 'base/model', nimPlannerModel: 'p/model', nimReviewerModel: 'r/model', nimCoderModel: '', codexModel: '' });
    const seen = [];
    agents.runAgent = async ({ agentId, settings: st }) => { seen.push([agentId, st.codexModel]); return { ok: true, text: 'x'.repeat(500), costUsd: 0 }; };
    await o.runAgent('p', { mode: 'review', role: 'planner', label: 'plan' });
    await o.runAgent('p', { mode: 'code', label: 'görev' });
    await o.runAgent('p', { mode: 'review', label: 'inceleme' });
    await o.runAgent('p', { mode: 'review', role: 'brief', label: 'brif' });
    assert.deepStrictEqual(seen, [['codex', 'p/model'], ['codex', 'base/model'], ['codex', 'r/model'], ['codex', 'r/model']]);
    assert.match(o.modelNote(settings.get()), /Codex\/NIM: planlayıcı p\/model · kodlayıcı base\/model · inceleyici r\/model/);
    // NIM dışı sağlayıcıda Codex model alanı olduğu gibi kullanılır.
    settings.save({ codexProvider: 'local', codexModel: 'qwen3-coder:30b' });
    seen.length = 0;
    await o.runAgent('p', { mode: 'review', role: 'planner', label: 'plan' });
    assert.deepStrictEqual(seen, [['codex', 'qwen3-coder:30b']]);
    // Brif: Claude yokken kodlayan ajan (salt okunur) yazar; Claude modeli verilmez.
    settings.save({ codexProvider: 'nim', codexModel: '', taskBriefing: true });
    const briefCalls = [];
    agents.runAgent = async ({ agentId, settings: st, mode }) => { briefCalls.push([agentId, st.codexModel, st.claudeModel, mode]); return { ok: true, text: '## Brief\n' + 'b'.repeat(500), costUsd: 0 }; };
    const task = { id: 't', title: 'T', goal: 'g', details: 'd', acceptance: [], tests: [], covers: [] };
    const brief = await o.writeBrief(task, 'src/', settings.get());
    assert.match(brief, /^## Brief/);
    assert.deepStrictEqual([briefCalls.length, briefCalls[0][0], briefCalls[0][1], briefCalls[0][3]], [1, 'codex', 'r/model', 'review']);
    assert.match(task.briefBy, /^OpenAI Codex/);
  } finally {
    agents.resolveBin = savedBin;
    agents.runAgent = savedRun;
    settings.save({ reviewerBy: 'auto', codexProvider: 'openai', codexModel: '', nimModel: '', nimPlannerModel: '', nimReviewerModel: '', nimCoderModel: '' });
  }
});

test('OpenCode kodlayıcı: rol modeli (kodlayıcı / salt okunur), Modeller satırı ve brif etiketi', async () => {
  reset();
  const agents = require('../src/main/agents');
  const { o } = orch();
  o.job.agent = 'opencode';
  const s = { ...settings.get(), opencodeModel: 'nvidia/deepseek-ai/deepseek-v4-pro', opencodeReviewModel: 'opencode/big-pickle' };
  assert.deepStrictEqual(['coder', 'reviewer', 'brief', 'planner'].map((r) => o.agentModelFor(s, 'opencode', r)), ['nvidia/deepseek-ai/deepseek-v4-pro', 'opencode/big-pickle', 'opencode/big-pickle', 'opencode/big-pickle']);
  assert.strictEqual(o.agentModelFor({ ...s, opencodeReviewModel: '' }, 'opencode', 'reviewer'), 'nvidia/deepseek-ai/deepseek-v4-pro', 'inceleyici boşsa kodlayıcı modeli');
  const savedBin = agents.resolveBin;
  agents.resolveBin = (id) => (id === 'opencode' ? '/bin/opencode' : null);
  try {
    assert.strictEqual(o.reviewerId(), 'opencode', 'Claude yoksa OpenCode inceler');
    assert.match(o.modelNote(s), /OpenCode: kodlayıcı nvidia\/deepseek-ai\/deepseek-v4-pro · inceleyici opencode\/big-pickle/);
  } finally {
    agents.resolveBin = savedBin;
  }
});

// Sahte OpenCode CLI: argümanlarını bir dosyaya yazar, stdin'deki isteme göre `--format json` olayları basar.
function fakeOpencode() {
  const dir = tmp();
  const js = path.join(dir, 'fake-opencode.js');
  const argsFile = path.join(dir, 'args.json');
  fs.writeFileSync(js, `
    const fs = require('fs');
    const args = process.argv.slice(2);
    if (args[0] === '--version') { process.stdout.write('1.19.4\\n'); return; }
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (input += d));
    process.stdin.on('end', () => {
      fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify({ args, input, cwd: process.cwd(), env: { xdg: process.env.XDG_DATA_HOME || '', key: process.env.ANTHROPIC_API_KEY || '' } }));
      const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
      say({ type: 'step_start', sessionID: 'oc1', part: {} });
      if (/LIMIT/.test(input)) { say({ type: 'error', error: { data: { message: 'rate limit exceeded; resets in 2 hours' } } }); return; }
      if (/OFFLINE/.test(input)) { say({ type: 'error', error: { data: { message: 'fetch failed: ENOTFOUND integrate.api.nvidia.com' } } }); return; }
      if (/AUTH/.test(input)) { say({ type: 'error', error: { data: { message: 'Unauthorized: invalid api key' } } }); return; }
      if (/JSON schema/.test(input)) {
        say({ type: 'text', sessionID: 'oc1', part: { text: 'Düşünüyorum…' } });
        say({ type: 'text', sessionID: 'oc1', part: { text: 'Sonuç:\\n\`\`\`json\\n{"ok": true, "n": 2}\\n\`\`\`' } });
      } else {
        say({ type: 'text', sessionID: 'oc1', part: { text: 'Merhaba ' } });
        say({ type: 'text', sessionID: 'oc1', part: { text: 'dünya' } });
      }
      say({ type: 'step_finish', sessionID: 'oc1', part: { reason: 'stop', tokens: { total: 42 }, cost: 0.002 } });
    });
  `);
  let bin;
  if (process.platform === 'win32') {
    bin = path.join(dir, 'opencode.cmd');
    fs.writeFileSync(bin, `@echo off\r\n"${process.execPath}" "${js}" %*\r\n`);
  } else {
    bin = path.join(dir, 'opencode');
    fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`, { mode: 0o755 });
  }
  return { bin, last: () => JSON.parse(fs.readFileSync(argsFile, 'utf8')) };
}

test('OpenCode yöneticisi: plan ajanı, geçici klasör, sistem istemi başa, şema istemle istenip denetlenir, ekler --file ile; hatalar işaretli; gem() ve hazırlık geçidi', async () => {
  reset();
  const opencodecli = require('../src/main/opencodecli');
  const fake = fakeOpencode();
  const dataRoot = tmp();
  const savedEnv = process.env.SONDA_OPENCODE_DATA;
  process.env.SONDA_OPENCODE_DATA = dataRoot;
  const s = { ...settings.get(), opencodePath: fake.bin, opencodeModel: 'nvidia/coder', opencodeManagerModel: '' };
  const saved = { c: claudecli.generate, g: localllm.generate, a: anthropic.generate };
  try {
    const usage = [];
    const text = await opencodecli.generate({ settings: s, system: 'Sen yöneticisin', parts: [{ text: 'Selam' }, { text: 'dünya' }], onUsage: (u) => usage.push(u) });
    assert.strictEqual(text, 'Merhaba \n\ndünya');
    let a = fake.last();
    assert.deepStrictEqual(usage, [{ totalTokenCount: 42, costUsd: 0.002 }]);
    assert.deepStrictEqual(a.args.slice(0, 5), ['run', '--format', 'json', '--agent', 'plan'], 'salt okunur plan ajanı, JSON olaylar');
    assert.strictEqual(a.args[a.args.indexOf('-m') + 1], 'nvidia/coder', 'yönetici modeli boşsa kodlayıcı OpenCode modeli');
    assert.ok(!a.args.includes('--auto') && !a.args.includes('--file'));
    assert.strictEqual(a.input, 'Sen yöneticisin\n\n---\n\nSelam\ndünya', 'sistem istemi başa eklenir');
    assert.strictEqual(a.env.xdg, dataRoot, 'Sonda\'nın OpenCode veri klasörü');
    assert.strictEqual(a.env.key, '', 'API anahtarları ortama geçmez');
    assert.ok(/sonda-yonetici-/.test(a.cwd) && !fs.existsSync(a.cwd), 'geçici klasörde çalışır ve klasör silinir');
    // Şema: istem sonunda şema, sonuç metindeki ```json bloğundan; yönetici modeli ayarı kodlayıcı modelini ezer.
    const schema = { type: 'object', properties: { ok: { type: 'boolean' }, n: { type: 'number' } }, required: ['ok'] };
    const obj = await opencodecli.generate({ settings: { ...s, opencodeManagerModel: 'opencode/big-pickle' }, parts: [{ text: 'x' }], schema });
    assert.deepStrictEqual(obj, { ok: true, n: 2 });
    a = fake.last();
    assert.strictEqual(a.args[a.args.indexOf('-m') + 1], 'opencode/big-pickle');
    assert.match(a.input, /single ```json code block that matches this JSON schema/);
    // Ekler: dosyaya yazılır ve --file ile eklenir; desteklenmeyen ek not olur.
    await opencodecli.generate({ settings: s, parts: [{ text: 'bak' }, { inlineData: { mimeType: 'image/png', data: 'QUJD' } }, { inlineData: { mimeType: 'text/csv', data: 'QUJD' } }] });
    a = fake.last();
    assert.match(a.args[a.args.indexOf('--file') + 1], /ek-1\.png$/);
    assert.match(a.input, /type text\/csv was omitted/);
    // Hatalar işaretli: limit, bağlantı, anahtar; CLI yoksa açık ileti.
    const lim = await opencodecli.generate({ settings: s, parts: [{ text: 'LIMIT' }] }).catch((e) => e);
    assert.ok(lim.limited && lim.resetAt > Date.now());
    const off = await opencodecli.generate({ settings: s, parts: [{ text: 'OFFLINE' }] }).catch((e) => e);
    assert.ok(off.network && opencodecli.isNetworkError(off));
    const auth = await opencodecli.generate({ settings: s, parts: [{ text: 'AUTH' }] }).catch((e) => e);
    assert.ok(auth.auth && /opencode auth login/.test(auth.message));
    await assert.rejects(opencodecli.generate({ settings: { ...s, opencodePath: path.join(fake.bin, '..', 'yok') }, parts: [{ text: 'x' }] }), /OpenCode bulunamadı/);

    // gem(): OpenCode seçiliyse çağrı OpenCode istemcisine gider (anahtar yok, yönetici modeli); hazırlık geçidi CLI'yi arar.
    settings.save({ managerBy: 'opencode', opencodePath: fake.bin, opencodeModel: 'nvidia/coder', opencodeManagerModel: 'nvidia/big' });
    assert.strictEqual(settings.managerLabel(), 'OpenCode');
    assert.strictEqual(settings.managerReady(settings.get()), true);
    const { o } = orch();
    let got = null;
    const savedOc = opencodecli.generate;
    opencodecli.generate = async (args) => { got = args; args.onUsage({ totalTokenCount: 7 }); return { ok: true }; };
    claudecli.generate = localllm.generate = anthropic.generate = async () => { throw new Error('başka sağlayıcı çağrılmamalıydı'); };
    try {
      assert.deepStrictEqual(await o.gem({ system: 'S', parts: [{ text: 'm' }], schema: { type: 'OBJECT', properties: { a: { type: 'STRING' } } } }), { ok: true });
      assert.deepStrictEqual([got.apiKey, got.baseUrl, got.model, got.system, got.settings.opencodePath], [undefined, undefined, 'nvidia/big', 'S', fake.bin]);
      assert.strictEqual(o.job.stats.managerTokens, 7);
      assert.strictEqual(o.managerNote(settings.get()), 'OpenCode: nvidia/big');
    } finally {
      opencodecli.generate = savedOc;
    }
    settings.save({ opencodePath: path.join(fake.bin, '..', 'yok') });
    assert.strictEqual(settings.managerReady(settings.get()), false);
    assert.match(settings.managerMissingMessage(settings.get()), /OpenCode bulunamadı/);
    assert.throws(() => o.startPlanning({ idea: 'bir şey yap', projectDir: tmp(), agent: 'claude', attachments: [] }), /OpenCode bulunamadı/);
  } finally {
    Object.assign(claudecli, { generate: saved.c });
    Object.assign(localllm, { generate: saved.g });
    Object.assign(anthropic, { generate: saved.a });
    if (savedEnv === undefined) delete process.env.SONDA_OPENCODE_DATA;
    else process.env.SONDA_OPENCODE_DATA = savedEnv;
    settings.save({ managerBy: 'claudecli', opencodePath: '', opencodeModel: '', opencodeManagerModel: '' });
  }
});

test('Kadro: iş kendi kadrosunu taşır (yönetici / kodlayıcı / inceleyici), klasör başına hatırlanır, Ayarlar\'daki varsayılanlar değişmez', async () => {
  reset();
  settings.save({ managerBy: 'claudecli', defaultAgent: 'claude', reviewerBy: 'auto', anthropicKey: KEY });
  // Temizleme: tanınmayan alan ve geçersiz değer atılır.
  assert.deepStrictEqual(settings.cleanStack({ managerBy: 'anthropic', agent: 'codex', reviewerBy: 'agent', x: 1 }), { managerBy: 'anthropic', agent: 'codex', reviewerBy: 'agent' });
  assert.deepStrictEqual(settings.cleanStack({ managerBy: 'gemini', agent: 'cursor', reviewerBy: 'yok' }), {});
  assert.deepStrictEqual(settings.cleanStack(null), {});
  const over = settings.withStack(settings.get(), { managerBy: 'anthropic', agent: 'opencode' });
  assert.deepStrictEqual([over.managerBy, over.defaultAgent, over.reviewerBy], ['anthropic', 'opencode', 'auto'], 'verilmeyen rol Ayarlar\'dan');
  assert.deepStrictEqual(settings.resolveStack(over), { managerBy: 'anthropic', agent: 'opencode', codexProvider: 'openai', reviewerBy: 'auto' });
  assert.deepStrictEqual(settings.cleanStack({ agent: 'codex', codexProvider: 'local' }), { agent: 'codex', codexProvider: 'local' }, 'yerel modelle kodlama kadroya girer');
  // İş başlatma: kadro çözülüp işe yazılır, klasör için hatırlanır; Ayarlar'daki varsayılanlar aynı kalır.
  const { o } = orch();
  const savedBin = agents.resolveBin;
  const dir = tmp();
  agents.resolveBin = () => '/bin/x';
  o.guarded = () => {};
  try {
    o.startPlanning({ idea: 'bir şey yap', projectDir: dir, stack: { managerBy: 'anthropic', agent: 'codex', codexProvider: 'local', reviewerBy: 'agent' }, attachments: [] });
    assert.deepStrictEqual(o.job.stack, { managerBy: 'anthropic', agent: 'codex', codexProvider: 'local', reviewerBy: 'agent' });
    assert.strictEqual(o.cfg().codexProvider, 'local', 'Codex bu işte yerel modelle kodlar; Ayarlar bölümündeki sağlayıcı değişmez');
    assert.strictEqual(o.job.agent, 'codex');
    assert.deepStrictEqual([o.cfg().managerBy, o.cfg().reviewerBy, o.cfg().anthropicKey], ['anthropic', 'agent', KEY], 'orkestratör ayarları işin kadrosuyla okur');
    assert.strictEqual(o.reviewerId(), 'codex', 'inceleyici kadrodan: kodlayıcıyla aynı');
    assert.strictEqual(settings.managerBy(o.cfg()), 'anthropic');
    const pub = settings.getPublic();
    assert.deepStrictEqual([pub.managerBy, pub.defaultAgent, pub.reviewerBy], ['claudecli', 'claude', 'auto'], 'Ayarlar değişmedi');
    assert.ok(!('projectStacks' in pub), 'kadro kayıtları arayüze toptan gitmez');
    assert.deepStrictEqual(settings.projectStack(dir), { managerBy: 'anthropic', agent: 'codex', codexProvider: 'local', reviewerBy: 'agent' });
    assert.deepStrictEqual(settings.projectStack(`${dir}${path.sep}`), settings.projectStack(dir), 'sondaki ayraç fark etmez');
    assert.strictEqual(settings.getPublic().codexProvider, 'openai');
    assert.deepStrictEqual(settings.projectStack(tmp()), {}, 'başka klasörün kaydı yok');
    // Kadrosuz çağrı (eski biçim): Ayarlar'daki varsayılanlar; `agent` kodlayıcıyı belirler.
    o.startPlanning({ idea: 'bir şey yap', projectDir: tmp(), agent: 'opencode', attachments: [] });
    assert.deepStrictEqual(o.job.stack, { managerBy: 'claudecli', agent: 'opencode', codexProvider: 'openai', reviewerBy: 'auto' });
    assert.strictEqual(o.reviewerId(), 'claude');
    // Hazırlık geçidi kadronun yöneticisine bakar: Claude API seçili ve anahtar yoksa iş başlamaz.
    settings.save({ clearAnthropicKey: true });
    assert.throws(() => o.startPlanning({ idea: 'x', projectDir: tmp(), stack: { managerBy: 'anthropic' }, attachments: [] }), /Anthropic API anahtarı yok/);
    // Bakım işi de kadro alır.
    o.startMaintenance({ kind: 'bugfix', projectDir: process.cwd(), items: ['x'], stack: { managerBy: 'claudecli', agent: 'opencode', reviewerBy: 'agent' } });
    assert.deepStrictEqual(o.job.stack, { managerBy: 'claudecli', agent: 'opencode', codexProvider: 'openai', reviewerBy: 'agent' });
  } finally {
    agents.resolveBin = savedBin;
    settings.save({ clearAnthropicKey: true, defaultAgent: 'claude' });
  }
});
