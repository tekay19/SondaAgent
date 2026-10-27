// Anthropic Messages API istemcisi (REST + SSE akışı, SDK bağımlılığı yok). Diğer yönetici istemcileriyle aynı sözleşmeyi
// taşır (`generate` metin ya da ayrıştırılmış nesne döner), böylece "yönetici" adımları (ürün tanımı, plan onayı,
// son kabul, rapor) hangisi seçilirse onunla çalışır. Kodlayan ve inceleyen Claude oturumları bunu KULLANMAZ:
// onlar Claude CLI ve abonelikle çalışır; bu anahtar ajanların ortamına hiç geçmez.
// Akış, zaman aşımı ve yeniden deneme ortak çekirdektedir (bkz. llmcore.js).
const core = require('./llmcore');

const BASE = 'https://api.anthropic.com';
const VERSION = '2023-06-01';
const TOOL = 'result';
// Akışlı isteklerde önerilen tavan (~64K): büyük planlar ve şartnameler 16K'ya sığmaz; ödenen yalnızca üretilen tokendır.
const DEFAULT_MAX_TOKENS = 64000;
// Yönetici işleri (onay, son kabul, rapor) için düşünme derinliği: yeni modellerde varsayılan "high" gereğinden pahalı.
const DEFAULT_EFFORT = 'medium';
// Sağlayıcının ek başına sınırları (base64 çözülmüş bayt): görüntü 5 MB, PDF 32 MB (istek sınırı).
const IMAGE_MAX = 5 * 1024 * 1024;
const PDF_MAX = 32 * 1024 * 1024;

// Bir modelin reddettiği parametreler çalışma anında öğrenilir ve hatırlanır: her çağrıda aynı 400'ü yaşamamak için.
// Yeni modeller (Opus 5.5, Sonnet 5.5, Fable 5.1…) sıcaklığı ve zorunlu araç çağrısını reddeder; eski modeller
// `effort`'u ya da yapılandırılmış çıktıyı tanımayabilir.
const learned = new Map(); // model → Set('temperature' | 'effort' | 'structured')
const maxCap = new Map(); // model → kabul edilen en büyük max_tokens
const learnedFor = (m) => {
  if (!learned.has(m)) learned.set(m, new Set());
  return learned.get(m);
};

class AnthropicError extends core.ApiError {}

const STATUS_HINT = {
  401: ' Anahtar geçersiz ya da silinmiş; Ayarlar\'dan yeniden girin.',
  403: ' Bu anahtarın bu modele erişim izni yok.',
};
const makeError = (message, status, extra) => new AnthropicError(`${message}${STATUS_HINT[status] || ''}`, status, extra);

// Yapılandırılmış çıktı reddi yalnızca bu parametreye özgü iletilerden anlaşılır: bir görüntü biçimi hatasındaki
// "format" sözcüğü yapılandırılmış çıktıyı bu model için kalıcı olarak kapatmasın.
const STRUCTURED_REJECTED = /output_config\.format|output_format|json_schema|structured outputs?/i;

// Yapılandırılmış çıktı şeması: her nesnede `additionalProperties: false` zorunlu; sayı/dizge kısıtları, varsayılan ve
// sağlayıcıya özgü alanlar desteklenmez (bkz. Claude API belgesi, Structured Outputs → JSON Schema Limitations).
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

// Akıştaki "error" olayı: aşırı yük ve geçici sunucu hataları yeniden denenir, istek hataları denenmez.
const STREAM_ERROR_STATUS = { overloaded_error: 529, rate_limit_error: 429, api_error: 500, timeout_error: 504 };

/**
 * İstem parçalarını ([{ text }], [{ inlineData }]) Messages API içerik bloklarına çevirir. PDF `document`
 * bloğu olur; sağlayıcı sınırını aşan ya da desteklenmeyen ek yerine kısa bir not konur (istek 400 ile düşmesin,
 * yönetici eksikliği bilsin).
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
    const pdf = mime === 'application/pdf';
    if (!pdf && !mime.startsWith('image/')) {
      content.push({ type: 'text', text: `[An attachment of type ${mime} was omitted: this provider accepts only images and PDF.]` });
      continue;
    }
    const bytes = Math.floor((data.length * 3) / 4);
    const max = pdf ? PDF_MAX : IMAGE_MAX;
    if (bytes > max) {
      content.push({ type: 'text', text: `[An attached ${pdf ? 'PDF' : 'image'} (${(bytes / 1048576).toFixed(1)} MB) was omitted: it exceeds the provider's ${max / 1048576} MB limit.]` });
      continue;
    }
    content.push(pdf ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } } : { type: 'image', source: { type: 'base64', media_type: mime, data } });
  }
  return content;
}

/**
 * Claude'a istek atar. `schema` (standart JSON Schema, üst düzey nesne) verilirse ayrıştırılmış nesne döner; verilmezse
 * metin döner. parts: [{ text }] veya [{ inlineData: { mimeType, data } }] (tüm yönetici istemcilerinde aynı biçim).
 * onProgress(karakterSayısı) uzun yanıtlarda ilerleme bildirir. onUsage({ totalTokenCount, inputTokens, outputTokens }).
 * Yalnızca bitiş nedeni gelen yanıt kullanılır: bitmeden kapanan akış yarım sayılır ve yeniden denenir.
 */
async function generate({ apiKey, model, system, parts, schema, temperature, maxOutputTokens, effort = DEFAULT_EFFORT, signal, onUsage, onProgress, baseUrl = BASE, retryDelays, timeoutMs }) {
  if (!apiKey) throw new AnthropicError('Anthropic API anahtarı ayarlanmamış ya da kayıtlı anahtar okunamadı. Ayarlar\'dan girin.');
  const content = contentOf(parts);
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

  return core.withRetries(
    async () => {
      const acc = { text: '', json: '', stop: null, inTokens: 0, outTokens: 0 };
      let lastReport = 0;
      await core.streamRequest(url, {
        headers: { 'x-api-key': apiKey, 'anthropic-version': VERSION },
        body: build(),
        signal,
        timeoutMs,
        label: 'Anthropic',
        makeError,
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
      if (!acc.stop) throw new AnthropicError('Claude akışı bitiş nedeni olmadan sona erdi (yarım yanıt)', 0, { truncated: true });
      const raw = schema ? (flags.structured ? acc.text : acc.json || acc.text) : acc.text;
      if (!raw.trim()) throw new AnthropicError(`Claude yanıt üretmedi (${acc.stop})`, 0);
      return schema ? core.parseJson(raw, 'Claude') : acc.text;
    },
    {
      signal,
      delays: retryDelays,
      // Modelin desteklemediği parametre: kaldırılır, bu model için hatırlanır ve hemen yeniden denenir (iş durmaz).
      adjust: (err) => {
        const m = err.message;
        if (flags.temperature && /temperature/i.test(m)) {
          flags.temperature = false;
          known.add('temperature');
          return true;
        }
        if (flags.effort && /effort/i.test(m)) {
          flags.effort = false;
          known.add('effort');
          return true;
        }
        if (schema && flags.structured && STRUCTURED_REJECTED.test(m)) {
          flags.structured = false;
          known.add('structured');
          return true;
        }
        // Modelin çıktı sınırını aşan max_tokens reddedilir: yarıya indirilir ve bu model için hatırlanır.
        if (/max_tokens/i.test(m) && flags.maxTokens > 8192) {
          flags.maxTokens = Math.max(8192, Math.floor(flags.maxTokens / 2));
          maxCap.set(id, flags.maxTokens);
          return true;
        }
        return false;
      },
    }
  );
}

// Anahtarın geçerli olduğunu ve erişilebilen modelleri gösterir (en yeni üstte; API böyle sıralar).
async function listModels({ apiKey, signal, baseUrl = BASE }) {
  if (!apiKey) throw new AnthropicError('Önce API anahtarını girin.');
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/models?limit=1000`, { headers: { 'x-api-key': apiKey, 'anthropic-version': VERSION }, signal });
  const text = await res.text();
  if (!res.ok) throw new AnthropicError(`Anthropic ${res.status}: ${core.errorMessage(text)}${STATUS_HINT[res.status] || ''}`, res.status);
  const data = JSON.parse(text);
  return (data.data || []).filter((m) => m?.id && /^claude-/.test(m.id)).map((m) => ({ id: m.id, label: m.display_name || m.id }));
}

module.exports = { AnthropicError, generate, listModels, contentOf, isNetworkError: core.isNetworkError, parseJson: (t) => core.parseJson(t, 'Claude'), strictSchema, DEFAULT_EFFORT };
