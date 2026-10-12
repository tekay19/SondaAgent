// Anthropic (Claude API) istemcisi testleri: gerçek API yerine yerel bir sunucu Messages API'nin akış biçimini taklit eder.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

const A = require('../src/main/anthropic');

// Sahte anahtar parça parça kurulur: gerçek anahtar biçimindeki dizgeler gizli anahtar taramasına takılır.
const KEY = ['sk', 'ant', 'test', 'abcdefghijklmnop'].join('-');

// Her istek için sıradaki yanıt betiği çalışır; gelen istekler (başlık + gövde) kaydedilir.
async function server(handlers) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      seen.push({ url: req.url, method: req.method, headers: req.headers, body: raw ? JSON.parse(raw) : null });
      handlers[Math.min(seen.length - 1, handlers.length - 1)](req, res);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { seen, baseUrl: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
}

const sse = (res, events) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const ev of events) res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
  res.end();
};
const textStream = (chunks, { stop = 'end_turn', inTok = 100, outTok = 7 } = {}) => [
  { type: 'message_start', message: { usage: { input_tokens: inTok, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  ...chunks.map((t) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } })),
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: outTok } },
  { type: 'message_stop' },
];
const toolStream = (parts, { stop = 'tool_use' } = {}) => [
  { type: 'message_start', message: { usage: { input_tokens: 50 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'result', input: {} } },
  ...parts.map((p) => ({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: p } })),
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 12 } },
  { type: 'message_stop' },
];
const fail = (status, message, headers = {}) => (_req, res) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }));
};
const fast = { retryDelays: [5, 5, 5] };

test('Metin: akıştan birleşir; başlıklar, gövde (sistem, metin + görüntü) ve kullanım doğru gider', async () => {
  const srv = await server([(_q, res) => sse(res, textStream(['Merhaba ', 'dünya']))]);
  try {
    const usage = [];
    const out = await A.generate({
      apiKey: KEY, model: 'claude-sonnet-5-5', system: 'Sistem metni', temperature: 0.3, baseUrl: srv.baseUrl, onUsage: (u) => usage.push(u),
      parts: [{ text: 'Soru' }, { text: '   ' }, { inlineData: { mimeType: 'image/jpeg', data: 'QUJD' } }],
    });
    assert.strictEqual(out, 'Merhaba dünya');
    assert.deepStrictEqual(usage, [{ totalTokenCount: 107, inputTokens: 100, outputTokens: 7 }]);
    const r = srv.seen[0];
    assert.deepStrictEqual([r.method, r.url, r.headers['x-api-key'], r.headers['anthropic-version']], ['POST', '/v1/messages', KEY, '2023-06-01']);
    assert.deepStrictEqual([r.body.model, r.body.max_tokens, r.body.stream, r.body.temperature, r.body.system], ['claude-sonnet-5-5', 64000, true, 0.3, 'Sistem metni']);
    assert.deepStrictEqual(r.body.messages, [{ role: 'user', content: [{ type: 'text', text: 'Soru' }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } }] }], 'boş metin parçası gönderilmez');
    assert.strictEqual(r.body.tools, undefined);
    assert.deepStrictEqual(r.body.output_config, { effort: 'medium' }, 'yönetici işleri için orta düşünme derinliği');
  } finally {
    await srv.close();
  }
});

test('Şema: yapılandırılmış çıktı (output_config.format) olarak gider; zorunlu araç çağrısı hiç gönderilmez; metin JSON nesneye çevrilir', async () => {
  const srv = await server([(_q, res) => sse(res, textStream(['{"verdict":"pa', 'ss","n":2,"liste":[', '1,2]}']))]);
  try {
    const schema = { type: 'object', properties: { verdict: { type: 'string', enum: ['pass', 'fix'], default: 'pass' }, alt: { type: 'object', properties: { x: { type: 'integer', minimum: 0 } } } }, required: ['verdict'] };
    const out = await A.generate({ apiKey: KEY, model: 'm-sema', parts: [{ text: 'x' }], schema, maxOutputTokens: 65536, baseUrl: srv.baseUrl });
    assert.deepStrictEqual(out, { verdict: 'pass', n: 2, liste: [1, 2] });
    const b = srv.seen[0].body;
    assert.deepStrictEqual(b.output_config, { effort: 'medium', format: { type: 'json_schema', schema: A.strictSchema(schema) } });
    assert.deepStrictEqual([b.tools, b.tool_choice, b.max_tokens, b.temperature], [undefined, undefined, 65536, undefined]);
  } finally {
    await srv.close();
  }
});

test('Yapılandırılmış çıktı şeması: her nesnede additionalProperties:false; desteklenmeyen kısıtlar çıkar; "default" adlı alan korunur', () => {
  const out = A.strictSchema({ type: 'object', propertyOrdering: ['a'], properties: { a: { type: 'array', minItems: 1, items: { type: 'object', properties: { default: { type: 'string', maxLength: 9 } }, required: ['default'] } }, s: { type: 'string', enum: ['x'], default: 'x' } }, required: ['a'] });
  assert.deepStrictEqual(out, { type: 'object', properties: { a: { type: 'array', items: { type: 'object', properties: { default: { type: 'string' } }, required: ['default'], additionalProperties: false } }, s: { type: 'string', enum: ['x'] } }, required: ['a'], additionalProperties: false });
});

test('Model yapılandırılmış çıktıyı reddederse serbest araç çağrısına düşer (tool_choice auto + talimat) ve bunu hatırlar', async () => {
  const srv = await server([
    fail(400, 'output_config.format: structured outputs are not supported for this model'),
    (_q, res) => sse(res, toolStream(['{"verdict":"fix"}'])),
    (_q, res) => sse(res, toolStream(['{"verdict":"pass"}'])),
  ]);
  try {
    const schema = { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] };
    const call = () => A.generate({ apiKey: KEY, model: 'm-eski', system: 'S', parts: [{ text: 'x' }], schema, baseUrl: srv.baseUrl, ...fast });
    assert.deepStrictEqual(await call(), { verdict: 'fix' });
    assert.deepStrictEqual(await call(), { verdict: 'pass' });
    assert.strictEqual(srv.seen.length, 3, 'ikinci çağrı doğrudan araç kipinde: yeniden 400 yaşanmaz');
    const [first, second, third] = srv.seen.map((r) => r.body);
    assert.ok(first.output_config.format && !first.tools);
    for (const b of [second, third]) {
      assert.deepStrictEqual([b.tools[0].name, b.tool_choice, b.output_config?.format], ['result', { type: 'auto' }, undefined]);
      assert.match(b.system, /^S\n\n[\s\S]*calling the "result" tool exactly once/);
    }
    assert.ok(srv.seen.every((r) => !r.body.tool_choice || r.body.tool_choice.type === 'auto'), 'zorunlu tool_choice ("tool"/"any") hiç gönderilmez');
  } finally {
    await srv.close();
  }
});

test('Model düşünme derinliğini (effort) tanımazsa çıkarılır ve sonraki çağrılarda hiç gönderilmez', async () => {
  const srv = await server([fail(400, 'output_config.effort: unsupported for this model'), (_q, res) => sse(res, textStream(['a'])), (_q, res) => sse(res, textStream(['b']))]);
  try {
    const call = () => A.generate({ apiKey: KEY, model: 'm-haiku', parts: [{ text: 'x' }], baseUrl: srv.baseUrl, ...fast });
    assert.deepStrictEqual([await call(), await call()], ['a', 'b']);
    assert.deepStrictEqual(srv.seen.map((r) => r.body.output_config), [{ effort: 'medium' }, undefined, undefined]);
  } finally {
    await srv.close();
  }
});

test('Geçici hatalar yeniden denenir: 429 (Retry-After), akış içi aşırı yük; her ikisinde sonunda yanıt gelir', async () => {
  const srv = await server([
    fail(429, 'rate limited', { 'retry-after': '0' }),
    (_q, res) => sse(res, [{ type: 'message_start', message: { usage: {} } }, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]),
    (_q, res) => sse(res, textStream(['tamam'])),
  ]);
  try {
    assert.strictEqual(await A.generate({ apiKey: KEY, model: 'm', parts: [{ text: 'x' }], baseUrl: srv.baseUrl, ...fast }), 'tamam');
    assert.strictEqual(srv.seen.length, 3);
  } finally {
    await srv.close();
  }
});

test('Model reddederse sıcaklık kaldırılıp, çok büyük max_tokens yarıya indirilip yeniden denenir', async () => {
  const srv = await server([
    fail(400, '`temperature` is not supported for this model'),
    fail(400, 'max_tokens: 65536 > 32000, which is the maximum allowed number of output tokens for this model'),
    (_q, res) => sse(res, textStream(['ok'])),
  ]);
  try {
    assert.strictEqual(await A.generate({ apiKey: KEY, model: 'm-sicaklik', parts: [{ text: 'x' }], temperature: 0.2, maxOutputTokens: 65536, baseUrl: srv.baseUrl, ...fast }), 'ok');
    assert.deepStrictEqual(srv.seen.map((r) => [r.body.temperature, r.body.max_tokens]), [[0.2, 65536], [undefined, 65536], [undefined, 32768]]);
    // Öğrenilen: bu model için sıcaklık gönderilmez, çıktı sınırı 32768'i geçmez (ilk denemede tutturulur).
    assert.strictEqual(await A.generate({ apiKey: KEY, model: 'm-sicaklik', parts: [{ text: 'x' }], temperature: 0.2, maxOutputTokens: 65536, baseUrl: srv.baseUrl, ...fast }), 'ok');
    assert.deepStrictEqual([srv.seen.length, srv.seen[3].body.temperature, srv.seen[3].body.max_tokens], [4, undefined, 32768]);
  } finally {
    await srv.close();
  }
});

test('Denenmeyecek hatalar tek istekte biter: çıktı sınırı, ret, geçersiz anahtar (anahtar iletide yer almaz)', async () => {
  let srv = await server([(_q, res) => sse(res, textStream(['yarım'], { stop: 'max_tokens' }))]);
  try {
    await assert.rejects(A.generate({ apiKey: KEY, model: 'm', parts: [{ text: 'x' }], baseUrl: srv.baseUrl, ...fast }), /max_tokens/);
    assert.strictEqual(srv.seen.length, 1);
  } finally {
    await srv.close();
  }
  srv = await server([(_q, res) => sse(res, toolStream(['{}'], { stop: 'refusal' }))]);
  try {
    await assert.rejects(A.generate({ apiKey: KEY, model: 'm', parts: [{ text: 'x' }], schema: { type: 'object' }, baseUrl: srv.baseUrl, ...fast }), /reddetti/);
  } finally {
    await srv.close();
  }
  srv = await server([fail(401, 'invalid x-api-key')]);
  try {
    const err = await A.generate({ apiKey: KEY, model: 'm', parts: [{ text: 'x' }], baseUrl: srv.baseUrl, ...fast }).catch((e) => e);
    assert.ok(err instanceof A.AnthropicError);
    assert.strictEqual(err.status, 401);
    assert.match(err.message, /Anthropic 401: invalid x-api-key[\s\S]*Ayarlar/);
    assert.ok(!err.message.includes(KEY), 'anahtar hata iletisinde görünmez');
    assert.strictEqual(srv.seen.length, 1, 'geçersiz anahtar yeniden denenmez');
    assert.strictEqual(A.isNetworkError(err), false);
  } finally {
    await srv.close();
  }
});

test('Bağlantı hatası ağ hatası sayılır (orkestratör bağlantıyı bekler); boş istek ve anahtarsız istek ağa çıkmadan reddedilir', async () => {
  const err = await A.generate({ apiKey: KEY, model: 'm', parts: [{ text: 'x' }], baseUrl: 'http://127.0.0.1:1', retryDelays: [] }).catch((e) => e);
  assert.strictEqual(err.network, true);
  assert.strictEqual(A.isNetworkError(err), true);
  assert.strictEqual(A.isNetworkError({ status: 503 }), true);
  assert.strictEqual(A.isNetworkError({ status: 429 }), false, 'kota bağlantı sorunu değildir');
  assert.strictEqual(A.isNetworkError({ status: 529 }), false, 'aşırı yük bağlantı sorunu değildir');
  await assert.rejects(A.generate({ apiKey: '', model: 'm', parts: [{ text: 'x' }] }), /anahtarı ayarlanmamış/);
  await assert.rejects(A.generate({ apiKey: KEY, model: 'm', parts: [{ text: '  ' }] }), /isteği boş/);
});

test('İptal: sinyal tetiklenince istek düşer ve "İptal edildi" fırlatılır', async () => {
  const srv = await server([(_q, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: ping\ndata: {"type":"ping"}\n\n'); }]);
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 100);
    await assert.rejects(A.generate({ apiKey: KEY, model: 'm', parts: [{ text: 'x' }], signal: ctrl.signal, baseUrl: srv.baseUrl, ...fast }), /İptal edildi/);
  } finally {
    await srv.close();
  }
});

test('Modeller: yalnızca claude-* kimlikleri, API sırasıyla; geçersiz anahtar açıklayıcı hata verir', async () => {
  let srv = await server([(_q, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' }, { id: 'text-embedding-x' }, { id: 'claude-haiku-4-5-20251001' }] })); }]);
  try {
    assert.deepStrictEqual(await A.listModels({ apiKey: KEY, baseUrl: srv.baseUrl }), [{ id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' }, { id: 'claude-haiku-4-5-20251001', label: 'claude-haiku-4-5-20251001' }]);
    assert.deepStrictEqual([srv.seen[0].url, srv.seen[0].headers['x-api-key']], ['/v1/models?limit=1000', KEY]);
  } finally {
    await srv.close();
  }
  srv = await server([fail(401, 'invalid x-api-key')]);
  try {
    await assert.rejects(A.listModels({ apiKey: KEY, baseUrl: srv.baseUrl }), /Anthropic 401[\s\S]*Ayarlar/);
    await assert.rejects(A.listModels({ apiKey: '' }), /Önce API anahtarını girin/);
  } finally {
    await srv.close();
  }
});
