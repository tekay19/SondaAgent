// Anthropic Messages API istemcisi (REST + SSE akışı, SDK bağımlılığı yok). Gemini istemcisiyle aynı sözleşmeyi
// taşır (`generate` metin ya da ayrıştırılmış nesne döner), böylece "yönetici" adımları (ürün tanımı, plan onayı,
// son kabul, rapor) hangisi seçilirse onunla çalışır. Kodlayan ve inceleyen Claude oturumları bunu KULLANMAZ:
// onlar Claude CLI ve abonelikle çalışır; bu anahtar ajanların ortamına hiç geçmez.
const https = require('https');
const http = require('http');

const BASE = 'https://api.anthropic.com';
const VERSION = '2023-06-01';
const TOOL = 'result';
// Akışlı isteklerde önerilen tavan (~64K): büyük planlar ve şartnameler 16K'ya sığmaz; ödenen yalnızca üretilen tokendır.
const DEFAULT_MAX_TOKENS = 64000;
// Yönetici işleri (onay, son kabul, rapor) için düşünme derinliği: yeni modellerde varsayılan "high" gereğinden pahalı.
const DEFAULT_EFFORT = 'medium';
// Bir modelin reddettiği parametreler çalışma anında öğrenilir ve hatırlanır: her çağrıda aynı 400'ü yaşamamak için.
// Yeni modeller (Opus 5.5, Sonnet 5.5, Fable 5.1…) sıcaklığı ve zorunlu araç çağrısını reddeder; eski modeller
// `effort`'u ya da yapılandırılmış çıktıyı tanımayabilir.
const learned = new Map(); // model → Set('temperature' | 'effort' | 'structured')
const maxCap = new Map(); // model → kabul edilen en büyük max_tokens
const learnedFor = (m) => {
  if (!learned.has(m)) learned.set(m, new Set());
  return learned.get(m);
};

// Yapılandırılmış çıktı şeması: her nesnede `additionalProperties: false` zorunlu; sayı/dizge kısıtları, varsayılan ve
// Gemini'ye özgü alanlar desteklenmez (bkz. Claude API belgesi, Structured Outputs → JSON Schema Limitations).
const DROP_KEYS = new Set(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems', 'uniqueItems', 'pattern', 'default', 'nullable', 'propertyOrdering', 'examples']);
function strictSchema(node) {
  if (Array.isArray(node)) return node.map(strictSchema);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (DROP_KEYS.has(k)) continue;
    if (k === 'properties') out.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, strictSchema(pv)]));
    else out[k] = k === 'enum' || k === 'required' || k === 'const' ? v : strictSchema(v);
  }
  if (out.type === 'object' || out.properties) out.additionalProperties = false;
  return out;
}
const RETRY_STATUS = new Set([429, 500, 502, 503, 504, 529]);
// Geçici hatalarda (429, 5xx, aşırı yük, bağlantı) yaklaşık 4 dakikaya yayılan yeniden denemeler.
const RETRY_DELAYS = [3000, 10000, 30000, 60000, 120000];

class AnthropicError extends Error {
  constructor(message, status, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('İptal edildi'));
    }, { once: true });
  });
}

// Hata gövdesinden okunur bir ileti (anahtar hiçbir yerde yankılanmaz).
function errorMessage(raw) {
  try {
    const j = JSON.parse(raw);
    return j.error?.message || raw.slice(0, 400);
  } catch {
    return raw.slice(0, 400);
  }
}

const STATUS_HINT = {
  401: ' Anahtar geçersiz ya da silinmiş; Ayarlar\'dan yeniden girin.',
  403: ' Bu anahtarın bu modele erişim izni yok.',
};

/**
 * Akışlı (SSE) istek. Node'un fetch'i yanıt başlıkları için 5 dakika bekler; büyük çıktılar daha uzun sürebildiği
 * için https modülüyle kendi zaman aşımımızı (20 dk) kullanıyoruz.
 */
function streamRequest(url, { apiKey, body, signal, onEvent, timeoutMs = 20 * 60 * 1000 }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    let req;
    try {
      req = (target.protocol === 'http:' ? http : https).request(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': VERSION, accept: 'text/event-stream' },
      });
    } catch (e) {
      // Geçersiz başlık (ör. anahtarda bozuk karakter) ağ hatası değildir: tekrar deneme, hemen bildir.
      reject(new AnthropicError(`Anthropic isteği oluşturulamadı: ${e.message}. Ayarlar'dan API anahtarını yeniden girin.`, 0));
      return;
    }
    let settled = false;
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn(v);
    };
    const timer = setTimeout(() => {
      req.destroy();
      done(reject, new AnthropicError('Anthropic zaman aşımı (20 dk)', 504));
    }, timeoutMs);
    const onAbort = () => {
      req.destroy();
      done(reject, new Error('İptal edildi'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    req.on('error', (e) => done(reject, Object.assign(new TypeError(`Anthropic bağlantı hatası: ${e.message}`), { network: true })));
    req.on('response', (res) => {
      res.setEncoding('utf8');
      if (res.statusCode >= 400) {
        let raw = '';
        res.on('data', (d) => (raw += d));
        res.on('end', () => {
          const retryAfter = Number(res.headers['retry-after']);
          done(reject, new AnthropicError(`Anthropic ${res.statusCode}: ${errorMessage(raw)}${STATUS_HINT[res.statusCode] || ''}`, res.statusCode, { retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : 0 }));
        });
        return;
      }
      let buf = '';
      res.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
          const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
          if (!data) continue;
          try {
            onEvent?.(JSON.parse(data));
          } catch (e) {
            if (e instanceof AnthropicError) done(reject, e);
            /* yarım olay — yok say */
          }
        }
      });
      res.on('end', () => done(resolve));
      res.on('error', (e) => done(reject, Object.assign(new TypeError(`Anthropic akışı kesildi: ${e.message}`), { network: true })));
    });
    req.end(JSON.stringify(body));
  });
}

// Akıştaki "error" olayı: aşırı yük ve geçici sunucu hataları yeniden denenir, istek hataları denenmez.
const STREAM_ERROR_STATUS = { overloaded_error: 529, rate_limit_error: 429, api_error: 500, timeout_error: 504 };

/**
 * Claude'a istek atar. `schema` (standart JSON Schema, üst düzey nesne) verilirse bir araç çağrısı zorlanır ve
 * ayrıştırılmış nesne döner; verilmezse metin döner.
 * parts: [{ text }] veya [{ inlineData: { mimeType, data } }] (Gemini ile aynı biçim).
 * onProgress(karakterSayısı) uzun yanıtlarda ilerleme bildirir. onUsage({ totalTokenCount, inputTokens, outputTokens }).
 */
async function generate({ apiKey, model, system, parts, schema, temperature, maxOutputTokens, effort = DEFAULT_EFFORT, signal, onUsage, onProgress, baseUrl = BASE, retryDelays = RETRY_DELAYS }) {
  if (!apiKey) throw new AnthropicError('Anthropic API anahtarı ayarlanmamış ya da kayıtlı anahtar okunamadı. Ayarlar\'dan girin.');
  const content = [];
  for (const p of parts || []) {
    if (typeof p?.text === 'string') {
      if (p.text.trim()) content.push({ type: 'text', text: p.text });
    } else if (p?.inlineData?.data) {
      content.push({ type: 'image', source: { type: 'base64', media_type: p.inlineData.mimeType || 'image/jpeg', data: p.inlineData.data } });
    }
  }
  if (!content.length) throw new AnthropicError('Anthropic isteği boş: gönderilecek metin ya da görüntü yok.', 0);
  const id = String(model || '').trim();
  const known = learnedFor(id);
  // Şema varsa önce yapılandırılmış çıktı (output_config.format). Model reddederse serbest araç çağrısı (tool_choice
  // "auto" + açık talimat): zorunlu araç çağrısı ("tool"/"any") yeni modellerde 400 döner, hiç gönderilmez.
  const flags = {
    temperature: temperature != null && !known.has('temperature'),
    effort: !!effort && !known.has('effort'),
    structured: !!schema && !known.has('structured'),
    maxTokens: Math.min(maxOutputTokens || DEFAULT_MAX_TOKENS, maxCap.get(id) || Infinity),
  };
  const strict = schema ? strictSchema(schema) : null;
  const build = () => {
    const b = { model: id, max_tokens: flags.maxTokens, stream: true, messages: [{ role: 'user', content }] };
    let sys = system || '';
    if (flags.temperature) b.temperature = Math.max(0, Math.min(1, temperature));
    const oc = {};
    if (flags.effort) oc.effort = effort;
    if (schema && flags.structured) oc.format = { type: 'json_schema', schema: strict };
    else if (schema) {
      b.tools = [{ name: TOOL, description: 'Return the final result as structured data that matches the schema.', input_schema: schema }];
      b.tool_choice = { type: 'auto' };
      sys = `${sys}${sys ? '\n\n' : ''}When you are done, return your final answer by calling the "${TOOL}" tool exactly once with data that matches its schema. Do not answer in plain text.`;
    }
    if (Object.keys(oc).length) b.output_config = oc;
    if (sys) b.system = sys;
    return b;
  };
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/messages`;

  for (let attempt = 0; ; attempt++) {
    try {
      const acc = { text: '', json: '', stop: null, inTokens: 0, outTokens: 0, streamError: null };
      let lastReport = 0;
      await streamRequest(url, {
        apiKey,
        body: build(),
        signal,
        onEvent: (ev) => {
          if (ev.type === 'message_start') {
            const u = ev.message?.usage || {};
            acc.inTokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
          } else if (ev.type === 'content_block_delta') {
            if (ev.delta?.type === 'text_delta') acc.text += ev.delta.text || '';
            else if (ev.delta?.type === 'input_json_delta') acc.json += ev.delta.partial_json || '';
            const n = acc.text.length + acc.json.length;
            if (onProgress && n - lastReport > 4000) {
              lastReport = n;
              onProgress(n);
            }
          } else if (ev.type === 'message_delta') {
            if (ev.delta?.stop_reason) acc.stop = ev.delta.stop_reason;
            if (ev.usage?.output_tokens != null) acc.outTokens = ev.usage.output_tokens;
          } else if (ev.type === 'error') {
            const type = ev.error?.type || 'api_error';
            throw new AnthropicError(`Anthropic ${type}: ${ev.error?.message || 'akış hatası'}`, STREAM_ERROR_STATUS[type] || 0);
          }
        },
      });
      onUsage?.({ totalTokenCount: acc.inTokens + acc.outTokens, inputTokens: acc.inTokens, outputTokens: acc.outTokens });
      if (acc.stop === 'max_tokens') throw new AnthropicError('Claude yanıtı çıktı sınırına takıldı (max_tokens). Daha büyük çıktı destekleyen bir model seçin ya da isteği bölün.', 0);
      if (acc.stop === 'refusal') throw new AnthropicError('Claude bu isteği yanıtlamayı reddetti (refusal).', 0);
      const raw = schema ? (flags.structured ? acc.text : acc.json || acc.text) : acc.text;
      if (!raw.trim()) throw new AnthropicError(`Claude yanıt üretmedi (${acc.stop || 'boş yanıt'})`, 0);
      return schema ? parseJson(raw) : acc.text;
    } catch (err) {
      if (signal?.aborted) throw new Error('İptal edildi');
      // Modelin desteklemediği parametre: kaldırılır, bu model için hatırlanır ve hemen yeniden denenir (iş durmaz).
      if (err.status === 400) {
        const m = err.message;
        if (flags.temperature && /temperature/i.test(m)) {
          flags.temperature = false;
          known.add('temperature');
          continue;
        }
        if (flags.effort && /effort/i.test(m)) {
          flags.effort = false;
          known.add('effort');
          continue;
        }
        if (schema && flags.structured && /output_config|format|json_schema|schema|structured/i.test(m)) {
          flags.structured = false;
          known.add('structured');
          continue;
        }
        // Modelin çıktı sınırını aşan max_tokens reddedilir: yarıya indirilir ve bu model için hatırlanır.
        if (/max_tokens/i.test(m) && flags.maxTokens > 8192) {
          flags.maxTokens = Math.max(8192, Math.floor(flags.maxTokens / 2));
          maxCap.set(id, flags.maxTokens);
          continue;
        }
      }
      const retryable = RETRY_STATUS.has(err.status) || err instanceof TypeError || err instanceof SyntaxError;
      if (!retryable || attempt >= retryDelays.length) throw err;
      await sleep(Math.min(Math.max(err.retryAfterMs || 0, retryDelays[attempt]), 120000), signal);
    }
  }
}

function parseJson(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new SyntaxError('Claude geçersiz JSON döndürdü');
  }
}

// Anahtarın geçerli olduğunu ve erişilebilen modelleri gösterir (en yeni üstte; API böyle sıralar).
async function listModels({ apiKey, signal, baseUrl = BASE }) {
  if (!apiKey) throw new AnthropicError('Önce API anahtarını girin.');
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/models?limit=1000`, { headers: { 'x-api-key': apiKey, 'anthropic-version': VERSION }, signal });
  const text = await res.text();
  if (!res.ok) throw new AnthropicError(`Anthropic ${res.status}: ${errorMessage(text)}${STATUS_HINT[res.status] || ''}`, res.status);
  const data = JSON.parse(text);
  return (data.data || []).filter((m) => m?.id && /^claude-/.test(m.id)).map((m) => ({ id: m.id, label: m.display_name || m.id }));
}

// Bağlantı sorunu mu (internet / DNS yok, akış koptu, geçici ağ geçidi hatası)? Kota (429), aşırı yük (529) ve model hataları değildir.
const isNetworkError = (e) => e?.network === true || [502, 503, 504].includes(e?.status);

module.exports = { AnthropicError, generate, listModels, isNetworkError, parseJson, strictSchema, DEFAULT_EFFORT };
