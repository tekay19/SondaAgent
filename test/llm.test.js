// Ortak LLM çekirdeği ve sağlayıcı istemcileri: yerel bir sunucu Gemini / Anthropic akış biçimini taklit eder.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

const G = require('../src/main/gemini');
const A = require('../src/main/anthropic');

// Sahte anahtarlar parça parça kurulur: gerçek anahtar biçimindeki dizgeler gizli anahtar taramasına takılır.
const KEY = ['sk', 'ant', 'test', 'abcdefghijklmnop'].join('-');
const GKEY = ['AIza', 'gemini', 'test', 'abcdefghijklmnop'].join('');

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
const gem = (chunks, { finish = 'STOP', usage = { totalTokenCount: 42 } } = {}) => [
  ...chunks.map((t) => ({ candidates: [{ content: { parts: [{ text: t }] } }] })),
  { candidates: [{ content: { parts: [] }, ...(finish ? { finishReason: finish } : {}) }], usageMetadata: usage },
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

test('Gemini: metin akıştan birleşir; gövde (sistem, sıcaklık, şema) ve kullanım doğru gider; şema → JSON nesne', async () => {
  const srv = await server([(_q, res) => sse(res, gem(['Mer', 'haba'])), (_q, res) => sse(res, gem(['{"a":', '[1]}']))]);
  try {
    const usage = [];
    const out = await G.generate({ apiKey: GKEY, model: 'models/gemini-pro-latest', system: 'Sistem', temperature: 0.2, maxOutputTokens: 1000, parts: [{ text: 'Soru' }], baseUrl: srv.baseUrl, onUsage: (u) => usage.push(u) });
    assert.strictEqual(out, 'Merhaba');
    assert.deepStrictEqual(usage, [{ totalTokenCount: 42 }]);
    const r = srv.seen[0];
    assert.deepStrictEqual([r.url, r.headers['x-goog-api-key']], ['/models/gemini-pro-latest:streamGenerateContent?alt=sse', GKEY]);
    assert.deepStrictEqual(r.body, { contents: [{ role: 'user', parts: [{ text: 'Soru' }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 1000 }, systemInstruction: { parts: [{ text: 'Sistem' }] } });
    const schema = { type: 'OBJECT', properties: { a: { type: 'ARRAY', items: { type: 'INTEGER' } } } };
    assert.deepStrictEqual(await G.generate({ apiKey: GKEY, model: 'g', parts: [{ text: 'x' }], schema, baseUrl: srv.baseUrl }), { a: [1] });
    assert.deepStrictEqual(srv.seen[1].body.generationConfig, { temperature: 0.4, responseMimeType: 'application/json', responseSchema: schema });
  } finally {
    await srv.close();
  }
});

test('Gemini: bitiş nedeni olmadan biten akış yarım sayılır ve yeniden denenir; güvenlik nedeniyle kesilen yanıt kullanılmaz', async () => {
  let srv = await server([(_q, res) => sse(res, gem(['yarım'], { finish: null })), (_q, res) => sse(res, gem(['tam']))]);
  try {
    assert.strictEqual(await G.generate({ apiKey: GKEY, model: 'g', parts: [{ text: 'x' }], baseUrl: srv.baseUrl, ...fast }), 'tam');
    assert.strictEqual(srv.seen.length, 2);
  } finally {
    await srv.close();
  }
  srv = await server([(_q, res) => sse(res, gem(['kısmen'], { finish: 'SAFETY' }))]);
  try {
    await assert.rejects(G.generate({ apiKey: GKEY, model: 'g', parts: [{ text: 'x' }], baseUrl: srv.baseUrl, ...fast }), /tamamlanmadı \(SAFETY\)/);
    assert.strictEqual(srv.seen.length, 1, 'model kararı yeniden denenmez');
  } finally {
    await srv.close();
  }
  srv = await server([(_q, res) => sse(res, [{ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }])]);
  try {
    await assert.rejects(G.generate({ apiKey: GKEY, model: 'g', parts: [{ text: 'x' }], baseUrl: srv.baseUrl, ...fast }), /yanıt üretmedi \(PROHIBITED_CONTENT\)/);
  } finally {
    await srv.close();
  }
});

test('Gemini: alan sırası ipucu ve çıktı sınırı reddedilirse çıkarılıp hemen yeniden denenir (deneme hakkı harcanmaz)', async () => {
  const srv = await server([fail(400, 'Invalid JSON payload received. Unknown name "propertyOrdering"'), fail(400, 'max output tokens exceeded for model'), (_q, res) => sse(res, gem(['{"v":1}']))]);
  try {
    const schema = { type: 'OBJECT', propertyOrdering: ['v'], properties: { v: { type: 'INTEGER' } } };
    const out = await G.generate({ apiKey: GKEY, model: 'g', parts: [{ text: 'x' }], schema, maxOutputTokens: 65536, baseUrl: srv.baseUrl, retryDelays: [] });
    assert.deepStrictEqual(out, { v: 1 });
    assert.deepStrictEqual(srv.seen.map((r) => [r.body.generationConfig.maxOutputTokens, 'propertyOrdering' in r.body.generationConfig.responseSchema]), [[65536, true], [65536, false], [undefined, false]]);
  } finally {
    await srv.close();
  }
});

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
