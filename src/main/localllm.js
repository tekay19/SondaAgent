// Yerel model istemcisi: OpenAI uyumlu bir sohbet sunucusuyla (Ollama, LM Studio, llama.cpp server, vLLM…) konuşur ve
// diğer yönetici istemcileriyle aynı sözleşmeyi taşır (`generate` metin ya da ayrıştırılmış nesne döner). Veri
// bilgisayardan çıkmaz; anahtar gerekmez (sunucu isterse isteğe bağlı). Akış (SSE), zaman aşımı, iptal ve yeniden
// deneme ortak çekirdektedir (bkz. llmcore.js).
//
// Yerel modeller şemalı çıktıda daha kırılgandır: önce sunucunun `response_format: json_schema` desteği denenir;
// reddederse `json_object` + şema metni, o da yoksa yalnızca istemle JSON istenir. Yanıt yine de ayrıştırılıp
// şemaya uygunluğu denetlenir; uymayan yanıt yeniden denenir. Görüntüler `image_url` (data URL) olarak gider
// (görüntü destekleyen bir model gerekir); PDF yerel sunuculara verilemez, yerine kısa bir not konur.
const core = require('./llmcore');
const { conforms } = require('./agents/run');

const DEFAULT_BASE = 'http://localhost:11434/v1';
// Yerel üretim yavaştır; büyük bir plan 20 dakikayı aşabilir. Olaysız geçen süre sınırı (çekirdek varsayılanıyla aynı).
const DEFAULT_TIMEOUT_MS = core.STREAM_TIMEOUT_MS;
const DEFAULT_MAX_TOKENS = 16384;

class LocalLlmError extends core.ApiError {}

// Sunucu adresi: `/v1` eki yoksa eklenir; sondaki eğik çizgiler atılır.
function normalizeBase(url) {
  let u = String(url || '').trim() || DEFAULT_BASE;
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  u = u.replace(/\/+$/, '');
  if (!/\/v\d+$/.test(u)) u += '/v1';
  return u;
}

// Şema desteği sunucuya göre çalışma anında öğrenilir (her çağrıda aynı 400'ü yaşamamak için).
const learned = new Map(); // base → Set('json_schema' | 'json_object')
const learnedFor = (b) => {
  if (!learned.has(b)) learned.set(b, new Set());
  return learned.get(b);
};

/**
 * İstem parçalarını ([{ text }], [{ inlineData }]) OpenAI sohbet içeriğine çevirir. Görüntüler data URL;
 * PDF ve diğer ekler yerine not.
 */
function contentOf(parts) {
  const content = [];
  for (const p of parts || []) {
    if (typeof p?.text === 'string') {
      if (p.text.trim()) content.push({ type: 'text', text: p.text });
      continue;
    }
    const data = p?.inlineData?.data;
    if (!data) continue;
    const mime = p.inlineData.mimeType || 'image/jpeg';
    if (mime.startsWith('image/')) content.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${data}` } });
    else content.push({ type: 'text', text: `[An attachment of type ${mime} was omitted: the local model server accepts only text and images.]` });
  }
  return content;
}

const makeError = (message, status, extra) => new LocalLlmError(message, status, extra);

/**
 * Yerel modele istek atar. `schema` (standart JSON Schema) verilirse ayrıştırılmış nesne döner; verilmezse metin.
 * onUsage({ totalTokenCount, inputTokens, outputTokens }); onProgress(karakter sayısı).
 */
async function generate({ baseUrl, apiKey, model, system, parts, schema, temperature, maxOutputTokens, signal, onUsage, onProgress, retryDelays, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const base = normalizeBase(baseUrl);
  const id = String(model || '').trim();
  if (!id) throw new LocalLlmError('Yerel model seçilmemiş. Ayarlar → Bağlantılar → Yerel model sunucusu → "Modelleri getir", sonra Modeller → Yönetici\'den seçin.', 0);
  const content = contentOf(parts);
  if (!content.length) throw new LocalLlmError('Yerel model isteği boş: gönderilecek metin ya da görüntü yok.', 0);
  const known = learnedFor(base);
  const mode = { schema: !!schema && !known.has('json_schema'), object: !!schema && !known.has('json_object') };
  const build = () => {
    let sys = system || '';
    if (schema) {
      sys += `${sys ? '\n\n' : ''}Answer with a single JSON object only (no prose, no markdown fences) that matches this JSON Schema exactly:\n${JSON.stringify(schema)}`;
    }
    const messages = [];
    if (sys) messages.push({ role: 'system', content: sys });
    // Sunucuların çoğu düz metin içeriği de kabul eder; görüntü yoksa dizge gönderilir (en uyumlu biçim).
    messages.push({ role: 'user', content: content.every((c) => c.type === 'text') ? content.map((c) => c.text).join('\n') : content });
    const b = { model: id, messages, stream: true, stream_options: { include_usage: true }, max_tokens: maxOutputTokens || DEFAULT_MAX_TOKENS };
    if (temperature != null) b.temperature = Math.max(0, Math.min(2, temperature));
    if (schema && mode.schema) b.response_format = { type: 'json_schema', json_schema: { name: 'result', schema, strict: false } };
    else if (schema && mode.object) b.response_format = { type: 'json_object' };
    return b;
  };
  const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};

  return core.withRetries(
    async () => {
      const acc = { text: '', finish: null, inTokens: 0, outTokens: 0 };
      let lastReport = 0;
      await core.streamRequest(`${base}/chat/completions`, {
        headers,
        body: build(),
        signal,
        timeoutMs,
        label: 'Yerel model',
        makeError,
        onEvent: (ev) => {
          if (ev.error) throw new LocalLlmError(`Yerel model hatası: ${ev.error.message || JSON.stringify(ev.error).slice(0, 300)}`, 0);
          const choice = ev.choices?.[0];
          if (choice?.delta?.content) acc.text += choice.delta.content;
          if (choice?.finish_reason) acc.finish = choice.finish_reason;
          if (ev.usage) {
            acc.inTokens = ev.usage.prompt_tokens || acc.inTokens;
            acc.outTokens = ev.usage.completion_tokens || acc.outTokens;
          }
          if (onProgress && acc.text.length - lastReport > 4000) {
            lastReport = acc.text.length;
            onProgress(acc.text.length);
          }
        },
      });
      onUsage?.({ totalTokenCount: acc.inTokens + acc.outTokens, inputTokens: acc.inTokens, outputTokens: acc.outTokens });
      if (acc.finish === 'length') throw new LocalLlmError('Yerel model yanıtı çıktı sınırına takıldı (max_tokens / bağlam penceresi). Daha büyük bağlamlı bir model ya da daha yüksek num_ctx kullanın.', 0);
      if (!acc.finish) throw new LocalLlmError('Yerel model akışı bitiş nedeni olmadan sona erdi (yarım yanıt)', 0, { truncated: true });
      // Düşünen modeller (<think>…</think>) düşünceyi metne karıştırabilir: ayıklanır.
      const text = acc.text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      if (!text) throw new LocalLlmError(`Yerel model yanıt üretmedi (${acc.finish})`, 0);
      if (!schema) return text;
      const value = core.parseJson(text, 'Yerel model');
      if (!conforms(value, schema)) throw new SyntaxError('Yerel model şemaya uymayan bir JSON döndürdü');
      return value;
    },
    {
      signal,
      delays: retryDelays || [2000, 5000, 10000],
      // Sunucu response_format'ı reddediyorsa (400): kaldırılır, bu sunucu için hatırlanır ve hemen yeniden denenir.
      adjust: (err) => {
        const m = String(err.message || '');
        if (schema && mode.schema && /response_format|json_schema|schema/i.test(m)) {
          mode.schema = false;
          known.add('json_schema');
          return true;
        }
        if (schema && mode.object && /response_format|json_object/i.test(m)) {
          mode.object = false;
          known.add('json_object');
          return true;
        }
        return false;
      },
    }
  );
}

// Sunucudaki modeller (GET /v1/models). Ollama, LM Studio ve llama.cpp aynı biçimi verir.
async function listModels({ baseUrl, apiKey, signal }) {
  const base = normalizeBase(baseUrl);
  let res;
  try {
    res = await fetch(`${base}/models`, { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}, signal: signal || AbortSignal.timeout(8000) });
  } catch (e) {
    throw new LocalLlmError(`Yerel model sunucusuna ulaşılamadı (${base}): ${e.message}. Ollama / LM Studio açık mı?`, 0, { network: true });
  }
  const text = await res.text();
  if (!res.ok) throw new LocalLlmError(`Yerel model sunucusu ${res.status}: ${core.errorMessage(text)}`, res.status);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new LocalLlmError(`Yerel model sunucusu (${base}/models) JSON yerine başka bir yanıt verdi: ${text.trim().slice(0, 120) || '(boş)'}. Adres OpenAI uyumlu bir sunucu mu?`, 0);
  }
  return (data.data || []).filter((m) => m?.id).map((m) => ({ id: m.id, label: m.id }));
}

module.exports = { LocalLlmError, DEFAULT_BASE, normalizeBase, contentOf, generate, listModels, isNetworkError: (e) => e?.network === true };
