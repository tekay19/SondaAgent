// Gemini API istemcisi (REST + SSE akışı, SDK bağımlılığı yok).
const https = require('https');
const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

class GeminiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function modelId(model) {
  return String(model || '').replace(/^models\//, '').trim();
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

async function request(url, { apiKey, method = 'GET', body, signal }) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* JSON değil */
  }
  if (!res.ok) {
    const msg = data?.error?.message || text.slice(0, 300) || res.statusText;
    throw new GeminiError(`Gemini ${res.status}: ${msg}`, res.status);
  }
  return data;
}

/**
 * Akışlı (SSE) istek. Node'un fetch'i yanıt başlıkları için 5 dakika bekler; büyük planlar
 * daha uzun sürebildiği için https modülüyle kendi zaman aşımımızı (20 dk) kullanıyoruz.
 */
function streamRequest(url, { apiKey, body, signal, onChunk, timeoutMs = 20 * 60 * 1000 }) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = https.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey, Accept: 'text/event-stream' },
      });
    } catch (e) {
      // Geçersiz başlık (ör. anahtarda bozuk karakter) ağ hatası değildir: tekrar deneme, hemen bildir.
      reject(new GeminiError(`Gemini isteği oluşturulamadı: ${e.message}. Ayarlar'dan API anahtarını yeniden girin.`, 0));
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
      done(reject, Object.assign(new GeminiError('Gemini zaman aşımı (20 dk)'), { status: 504 }));
    }, timeoutMs);
    const onAbort = () => {
      req.destroy();
      done(reject, new Error('İptal edildi'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    req.on('error', (e) => done(reject, Object.assign(new TypeError(`Gemini bağlantı hatası: ${e.message}`))));
    req.on('response', (res) => {
      res.setEncoding('utf8');
      if (res.statusCode >= 400) {
        let raw = '';
        res.on('data', (d) => (raw += d));
        res.on('end', () => {
          let msg = raw.slice(0, 400);
          try {
            msg = JSON.parse(raw).error?.message || msg;
          } catch {
            /* JSON değil */
          }
          done(reject, new GeminiError(`Gemini ${res.statusCode}: ${msg}`, res.statusCode));
        });
        return;
      }
      let buf = '';
      const events = [];
      res.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0 || (i = buf.indexOf('\r\n\r\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + (buf[i] === '\r' ? 4 : 2));
          const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
          if (!data) continue;
          try {
            const ev = JSON.parse(data);
            events.push(ev);
            onChunk?.(ev);
          } catch {
            /* yarım olay — yok say */
          }
        }
      });
      res.on('end', () => done(resolve, events));
      res.on('error', (e) => done(reject, new TypeError(`Gemini akışı kesildi: ${e.message}`)));
    });
    req.end(JSON.stringify(body));
  });
}

/**
 * Gemini'ye istek atar. `schema` verilirse JSON döner ve ayrıştırılmış nesneyi verir.
 * parts: [{ text }] veya [{ inlineData: { mimeType, data } }]
 * onProgress(karakterSayısı) uzun yanıtlarda ilerleme bildirir.
 */
async function generate({ apiKey, model, system, parts, schema, temperature = 0.4, maxOutputTokens, signal, onUsage, onProgress }) {
  if (!apiKey) throw new GeminiError('Gemini API anahtarı ayarlanmamış ya da kayıtlı anahtar okunamadı. Ayarlar\'dan girin.');
  const url = `${BASE}/models/${encodeURIComponent(modelId(model))}:streamGenerateContent?alt=sse`;
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature },
  };
  if (maxOutputTokens) body.generationConfig.maxOutputTokens = maxOutputTokens;
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (schema) {
    body.generationConfig.responseMimeType = 'application/json';
    body.generationConfig.responseSchema = schema;
  }

  const delays = [3000, 10000, 30000];
  for (let attempt = 0; ; attempt++) {
    try {
      let text = '';
      let finishReason = null;
      let blockReason = null;
      let usage = null;
      let lastReport = 0;
      await streamRequest(url, {
        apiKey,
        body,
        signal,
        onChunk: (ev) => {
          if (ev.usageMetadata) usage = ev.usageMetadata;
          if (ev.promptFeedback?.blockReason) blockReason = ev.promptFeedback.blockReason;
          const cand = ev.candidates?.[0];
          if (cand?.finishReason) finishReason = cand.finishReason;
          for (const p of cand?.content?.parts || []) if (!p.thought && typeof p.text === 'string') text += p.text;
          if (onProgress && text.length - lastReport > 4000) {
            lastReport = text.length;
            onProgress(text.length);
          }
        },
      });
      if (usage && onUsage) onUsage(usage);
      if (finishReason === 'MAX_TOKENS') throw new GeminiError('Gemini yanıtı çıktı sınırına takıldı (MAX_TOKENS). Daha büyük çıktı destekleyen bir model seçin ya da isteği bölün.', 0);
      if (!text) throw new GeminiError(`Gemini yanıt üretmedi (${blockReason || finishReason || 'boş yanıt'})`, 0);
      return schema ? parseJson(text) : text;
    } catch (err) {
      if (signal?.aborted) throw new Error('İptal edildi');
      // Bazı modeller yüksek maxOutputTokens değerini reddeder: sınırı kaldırıp tekrar dene.
      if (err.status === 400 && body.generationConfig.maxOutputTokens && /output.?tokens/i.test(err.message)) {
        delete body.generationConfig.maxOutputTokens;
        continue;
      }
      const retryable = RETRY_STATUS.has(err.status) || err instanceof TypeError || err instanceof SyntaxError;
      if (!retryable || attempt >= delays.length) throw err;
      await sleep(delays[attempt], signal);
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
    throw new SyntaxError('Gemini geçersiz JSON döndürdü');
  }
}

async function listModels({ apiKey, signal }) {
  if (!apiKey) throw new GeminiError('Önce API anahtarını girin.');
  const out = [];
  let pageToken = '';
  do {
    const url = `${BASE}/models?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const data = await request(url, { apiKey, signal });
    for (const m of data.models || []) {
      const id = modelId(m.name);
      if (!/gemini/i.test(id)) continue;
      if (!(m.supportedGenerationMethods || []).includes('generateContent')) continue;
      if (/embedding|tts|image|transcribe|computer-use|robotics|customtools|omni|live|audio|banana/i.test(id)) continue;
      out.push({ id, label: m.displayName || id });
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  // En yeni ve "pro" modeller üstte.
  return out.sort((a, b) => score(b.id) - score(a.id) || b.id.localeCompare(a.id));
}

// Sıralama: önce "-latest" takma adları, sonra pro > flash > lite, sonra sürüm.
function score(id) {
  const v = parseFloat((id.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0);
  const tier = /pro/.test(id) ? 3 : /lite/.test(id) ? 1 : /flash/.test(id) ? 2 : 0;
  return (/-latest$/.test(id) ? 1000 : 0) + tier * 100 + v - (/preview|exp/.test(id) ? 0.05 : 0);
}

// Standart JSON Schema'yı (küçük harf tipler) Gemini'nin responseSchema biçimine çevirir.
function toGeminiSchema(schema) {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'type' && typeof v === 'string') out.type = v.toUpperCase();
    else if (k === 'properties') out.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, toGeminiSchema(pv)]));
    else if (k === 'items') out.items = toGeminiSchema(v);
    else if (['required', 'enum', 'description'].includes(k)) out[k] = v;
  }
  return out;
}

module.exports = { generate, listModels, GeminiError, toGeminiSchema };
