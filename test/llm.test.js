// Ortak LLM çekirdeği ve sağlayıcı istemcileri: yerel bir sunucu Anthropic / OpenAI uyumlu akış biçimini taklit eder.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

const A = require('../src/main/anthropic');
const L = require('../src/main/localllm');

// Sahte anahtarlar parça parça kurulur: gerçek anahtar biçimindeki dizgeler gizli anahtar taramasına takılır.
const KEY = ['sk', 'ant', 'test', 'abcdefghijklmnop'].join('-');

async function server(handlers) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
      handlers[Math.min(seen.length - 1, handlers.length - 1)](req, res);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { seen, baseUrl: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
}
const sse = (res, events) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const ev of events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  res.end();
};
// OpenAI uyumlu akış (Ollama / LM Studio / llama.cpp): delta parçaları, bitiş nedeni, en sonda kullanım.
const oai = (chunks, { finish = 'stop', usage = { prompt_tokens: 30, completion_tokens: 12 } } = {}) => [
  ...chunks.map((t) => ({ choices: [{ delta: { content: t } }] })),
  { choices: [{ delta: {}, ...(finish ? { finish_reason: finish } : {}) }] },
  ...(usage ? [{ choices: [], usage }] : []),
];
const claude = (chunks, { stop = 'end_turn' } = {}) => [
  { type: 'message_start', message: { usage: { input_tokens: 10 } } },
  ...chunks.map((t) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } })),
  ...(stop ? [{ type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 3 } }] : []),
  { type: 'message_stop' },
];
const fail = (status, message) => (_q, res) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message } }));
};
const fast = { retryDelays: [5, 5, 5] };

test('Zaman aşımı: olay gelmeyen akış bir kez yeniden denenir, sonra ağ sorunu olarak bildirilir (2 saat beklenmez)', async () => {
  const srv = await server([(_q, res) => res.writeHead(200, { 'content-type': 'text/event-stream' })]);
  try {
    const err = await A.generate({ apiKey: KEY, model: 'm', parts: [{ text: 'x' }], baseUrl: srv.baseUrl, timeoutMs: 60, ...fast }).catch((e) => e);
    assert.match(err.message, /zaman aşımı/);
    assert.strictEqual(A.isNetworkError(err), true);
    assert.strictEqual(srv.seen.length, 2);
  } finally {
    await srv.close();
  }
});

test('Claude: PDF belge bloğu olarak gider; sınırı aşan görüntü ve desteklenmeyen ek yerine not konur', () => {
  const pdf = Buffer.from('%PDF-1.4').toString('base64');
  const big = 'A'.repeat(Math.ceil((5 * 1024 * 1024 + 10) / 3) * 4);
  const content = A.contentOf([{ text: 'Doküman:' }, { inlineData: { mimeType: 'application/pdf', data: pdf } }, { inlineData: { mimeType: 'image/png', data: big } }, { inlineData: { mimeType: 'application/zip', data: 'QUJD' } }, { inlineData: { mimeType: 'image/jpeg', data: 'QUJD' } }]);
  assert.deepStrictEqual(content[0], { type: 'text', text: 'Doküman:' });
  assert.deepStrictEqual(content[1], { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf } });
  assert.match(content[2].text, /image \(5\.0 MB\) was omitted/);
  assert.match(content[3].text, /application\/zip was omitted/);
  assert.deepStrictEqual(content[4], { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } });
});

test('Claude: görüntü biçimi hatası (400) yapılandırılmış çıktıyı bu model için kapatmaz', async () => {
  const srv = await server([fail(400, 'messages.0.content.1.image.source.base64.data: Could not process image format'), (_q, res) => sse(res, claude(['{"v":"ok"}']))]);
  try {
    const schema = { type: 'object', properties: { v: { type: 'string' } }, required: ['v'] };
    const call = () => A.generate({ apiKey: KEY, model: 'm-gorsel', parts: [{ text: 'x' }, { inlineData: { mimeType: 'image/png', data: 'QUJD' } }], schema, baseUrl: srv.baseUrl, ...fast });
    await assert.rejects(call(), /image format/);
    assert.strictEqual(srv.seen.length, 1, 'istek hatası yeniden denenmez');
    assert.deepStrictEqual(await call(), { v: 'ok' });
    assert.ok(srv.seen[1].body.output_config.format, 'ikinci çağrı yine yapılandırılmış çıktı ister');
    assert.strictEqual(srv.seen[1].body.tools, undefined);
  } finally {
    await srv.close();
  }
});

test('Claude: bitiş nedeni gelmeden kapanan akış yarım sayılır ve yeniden denenir', async () => {
  const srv = await server([(_q, res) => sse(res, claude(['yarım'], { stop: null })), (_q, res) => sse(res, claude(['tam']))]);
  try {
    assert.strictEqual(await A.generate({ apiKey: KEY, model: 'm', parts: [{ text: 'x' }], baseUrl: srv.baseUrl, ...fast }), 'tam');
    assert.strictEqual(srv.seen.length, 2);
  } finally {
    await srv.close();
  }
});

// ---------- yerel model (OpenAI uyumlu sunucu) ----------
test('Yerel model: adres /v1 ile tamamlanır; metin akıştan birleşir; gövde (sistem, sıcaklık, akış) ve kullanım doğru; anahtar yalnızca verilirse gider', async () => {
  const srv = await server([(_q, res) => sse(res, oai(['Mer', 'haba']))]);
  try {
    const usage = [];
    const out = await L.generate({ baseUrl: srv.baseUrl, model: 'qwen3', system: 'Sistem', temperature: 0.2, maxOutputTokens: 500, parts: [{ text: 'Soru' }], onUsage: (u) => usage.push(u) });
    assert.strictEqual(out, 'Merhaba');
    assert.deepStrictEqual(usage, [{ totalTokenCount: 42, inputTokens: 30, outputTokens: 12 }]);
    const r = srv.seen[0];
    assert.strictEqual(r.url, '/v1/chat/completions');
    assert.strictEqual(r.headers.authorization, undefined, 'anahtar verilmediyse başlık yok');
    assert.deepStrictEqual(r.body, { model: 'qwen3', messages: [{ role: 'system', content: 'Sistem' }, { role: 'user', content: 'Soru' }], stream: true, stream_options: { include_usage: true }, max_tokens: 500, temperature: 0.2 });
    assert.deepStrictEqual([L.normalizeBase('localhost:1234'), L.normalizeBase('http://x/v1/'), L.normalizeBase('')], ['http://localhost:1234/v1', 'http://x/v1', 'http://localhost:11434/v1']);
  } finally {
    await srv.close();
  }
});

test('Yerel model: şema json_schema ile istenir; sunucu reddederse json_object, o da reddedilirse yalnızca istemle (hemen, deneme hakkı harcamadan); <think> ayıklanır; şemaya uymayan yanıt yeniden denenir', async () => {
  const schema = { type: 'object', properties: { v: { type: 'integer' } }, required: ['v'] };
  let srv = await server([fail(400, 'response_format.type json_schema is not supported'), fail(400, 'response_format json_object unsupported'), (_q, res) => sse(res, oai(['<think>düşünüyorum</think>', '{"v":', '1}']))]);
  try {
    const out = await L.generate({ baseUrl: srv.baseUrl, model: 'm', parts: [{ text: 'x' }], schema, ...fast });
    assert.deepStrictEqual(out, { v: 1 });
    assert.deepStrictEqual(srv.seen.map((r) => r.body.response_format?.type), ['json_schema', 'json_object', undefined]);
    assert.match(srv.seen[2].body.messages[0].content, /matches this JSON Schema exactly/);
  } finally {
    await srv.close();
  }
  // Aynı sunucu için öğrenildi: sonraki çağrı doğrudan istemle gider; şemaya uymayan JSON yeniden denenir.
  srv = await server([(_q, res) => sse(res, oai(['{"baska":1}'])), (_q, res) => sse(res, oai(['{"v":2}']))]);
  try {
    assert.deepStrictEqual(await L.generate({ baseUrl: srv.baseUrl, model: 'm', parts: [{ text: 'x' }], schema, ...fast }), { v: 2 });
    assert.strictEqual(srv.seen.length, 2);
  } finally {
    await srv.close();
  }
});

test('Yerel model: çıktı sınırına takılan yanıt hata; yarım akış yeniden denenir; görüntü data URL, PDF yerine not; bağlantı yoksa ağ hatası', async () => {
  let srv = await server([(_q, res) => sse(res, oai(['yarım'], { finish: 'length' }))]);
  try {
    await assert.rejects(L.generate({ baseUrl: srv.baseUrl, model: 'm', parts: [{ text: 'x' }], ...fast }), /çıktı sınırına takıldı/);
    assert.strictEqual(srv.seen.length, 1, 'model sınırı yeniden denenmez');
  } finally {
    await srv.close();
  }
  srv = await server([(_q, res) => sse(res, oai(['yarım'], { finish: null, usage: null })), (_q, res) => sse(res, oai(['tam']))]);
  try {
    assert.strictEqual(await L.generate({ baseUrl: srv.baseUrl, model: 'm', parts: [{ text: 'x' }], ...fast }), 'tam');
    assert.strictEqual(srv.seen.length, 2);
  } finally {
    await srv.close();
  }
  const content = L.contentOf([{ text: 'Bak:' }, { inlineData: { mimeType: 'image/png', data: 'QUJD' } }, { inlineData: { mimeType: 'application/pdf', data: 'QUJD' } }]);
  assert.deepStrictEqual(content, [{ type: 'text', text: 'Bak:' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }, { type: 'text', text: '[An attachment of type application/pdf was omitted: the local model server accepts only text and images.]' }]);
  srv = await server([(_q, res) => sse(res, oai(['ok']))]);
  try {
    await L.generate({ baseUrl: srv.baseUrl, model: 'm', parts: [{ text: 'Bak:' }, { inlineData: { mimeType: 'image/png', data: 'QUJD' } }] });
    assert.ok(Array.isArray(srv.seen[0].body.messages[0].content), 'görüntü varken içerik dizi olarak gider');
  } finally {
    await srv.close();
  }
  const err = await L.listModels({ baseUrl: 'http://127.0.0.1:1', signal: AbortSignal.timeout(2000) }).catch((e) => e);
  assert.ok(L.isNetworkError(err) && /ulaşılamadı/.test(err.message));
  await assert.rejects(L.generate({ baseUrl: 'http://127.0.0.1:1', model: '', parts: [{ text: 'x' }] }), /Yerel model seçilmemiş/);
});

test('Yerel model: model listesi /v1/models biçiminden okunur; anahtar Bearer başlığıyla gider', async () => {
  const srv = await server([(_q, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'qwen3:30b' }, { id: 'llama3' }] })); }]);
  try {
    assert.deepStrictEqual(await L.listModels({ baseUrl: srv.baseUrl, apiKey: KEY }), [{ id: 'qwen3:30b', label: 'qwen3:30b' }, { id: 'llama3', label: 'llama3' }]);
    assert.deepStrictEqual([srv.seen[0].url, srv.seen[0].headers.authorization], ['/v1/models', `Bearer ${KEY}`]);
  } finally {
    await srv.close();
  }
});
