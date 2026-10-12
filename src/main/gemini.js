// Gemini API istemcisi (REST + SSE akışı, SDK bağımlılığı yok). Akış, zaman aşımı ve yeniden deneme ortak
// çekirdektedir (bkz. llmcore.js); burada yalnızca isteğin biçimi, olayların okunması ve bitiş kuralları var.
const core = require('./llmcore');

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

class GeminiError extends core.ApiError {}

const makeError = (message, status, extra) => new GeminiError(message, status, extra);

function modelId(model) {
  return String(model || '').replace(/^models\//, '').trim();
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
 * Gemini'ye istek atar. `schema` verilirse JSON döner ve ayrıştırılmış nesneyi verir.
 * parts: [{ text }] veya [{ inlineData: { mimeType, data } }]
 * onProgress(karakterSayısı) uzun yanıtlarda ilerleme bildirir. onUsage(usageMetadata).
 * Yalnızca STOP ile biten yanıt kullanılır: güvenlik / alıntı nedeniyle kesilen yanıt (yarım metinle) kabul edilmez;
 * bitiş nedeni hiç gelmeden kapanan akış yarım sayılır ve yeniden denenir.
 */
async function generate({ apiKey, model, system, parts, schema, temperature = 0.4, maxOutputTokens, signal, onUsage, onProgress, baseUrl = BASE, retryDelays, timeoutMs }) {
  if (!apiKey) throw new GeminiError('Gemini API anahtarı ayarlanmamış ya da kayıtlı anahtar okunamadı. Ayarlar\'dan girin.');
  const url = `${baseUrl.replace(/\/+$/, '')}/models/${encodeURIComponent(modelId(model))}:streamGenerateContent?alt=sse`;
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
  let orderingStripped = false;

  return core.withRetries(
    async () => {
      const acc = { text: '', finishReason: null, blockReason: null, usage: null };
      let lastReport = 0;
      await core.streamRequest(url, {
        headers: { 'x-goog-api-key': apiKey },
        body,
        signal,
        timeoutMs,
        label: 'Gemini',
        makeError,
        onEvent: (ev) => {
          if (ev.usageMetadata) acc.usage = ev.usageMetadata;
          if (ev.promptFeedback?.blockReason) acc.blockReason = ev.promptFeedback.blockReason;
          const cand = ev.candidates?.[0];
          if (cand?.finishReason) acc.finishReason = cand.finishReason;
          for (const p of cand?.content?.parts || []) if (!p.thought && typeof p.text === 'string') acc.text += p.text;
          if (onProgress && acc.text.length - lastReport > 4000) {
            lastReport = acc.text.length;
            onProgress(acc.text.length);
          }
        },
      });
      if (acc.usage && onUsage) onUsage(acc.usage);
      if (acc.finishReason === 'MAX_TOKENS') throw new GeminiError('Gemini yanıtı çıktı sınırına takıldı (MAX_TOKENS). Daha büyük çıktı destekleyen bir model seçin ya da isteği bölün.', 0);
      if (acc.finishReason && acc.finishReason !== 'STOP') throw new GeminiError(`Gemini yanıtı tamamlanmadı (${acc.finishReason})${acc.text ? '; yarım yanıt kullanılmadı' : ''}`, 0);
      if (!acc.finishReason) {
        if (acc.blockReason) throw new GeminiError(`Gemini yanıt üretmedi (${acc.blockReason})`, 0);
        throw new GeminiError('Gemini akışı bitiş nedeni olmadan sona erdi (yarım yanıt)', 0, { truncated: true });
      }
      if (!acc.text) throw new GeminiError('Gemini yanıt üretmedi (boş yanıt)', 0);
      return schema ? core.parseJson(acc.text, 'Gemini') : acc.text;
    },
    {
      signal,
      delays: retryDelays,
      adjust: (err) => {
        // Bazı modeller yüksek maxOutputTokens değerini reddeder: sınırı kaldırıp tekrar dene.
        if (body.generationConfig.maxOutputTokens && /output.?tokens/i.test(err.message)) {
          delete body.generationConfig.maxOutputTokens;
          return true;
        }
        // Alan sırası (propertyOrdering) şemada isteğe bağlı bir ipucudur; onu tanımayan bir model/sürüm isteği
        // reddederse şema sırasız gönderilir (iş bu yüzden durmaz).
        if (body.generationConfig.responseSchema && !orderingStripped && /propertyOrdering|property_ordering|Unknown name|Invalid JSON payload/i.test(err.message)) {
          body.generationConfig.responseSchema = withoutKey(body.generationConfig.responseSchema, 'propertyOrdering');
          orderingStripped = true;
          return true;
        }
        return false;
      },
    }
  );
}

// Şemadan (iç içe) bir anahtarı çıkarır.
function withoutKey(node, key) {
  if (Array.isArray(node)) return node.map((x) => withoutKey(x, key));
  if (!node || typeof node !== 'object') return node;
  return Object.fromEntries(Object.entries(node).filter(([k]) => k !== key).map(([k, v]) => [k, withoutKey(v, key)]));
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

module.exports = { GeminiError, withoutKey, generate, listModels, toGeminiSchema, isNetworkError: core.isNetworkError };
