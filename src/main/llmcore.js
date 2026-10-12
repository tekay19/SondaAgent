// Ortak LLM istemci çekirdeği: SSE akışı, zaman aşımı, iptal, yeniden deneme ve JSON ayrıştırma. Gemini ve Claude
// istemcileri yalnızca isteğin biçimini, olayların okunmasını ve bitiş kurallarını sağlar (bkz. gemini.js, anthropic.js).
const https = require('https');
const http = require('http');

class ApiError extends Error {
  constructor(message, status = 0, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

const RETRY_STATUS = new Set([429, 500, 502, 503, 504, 529]);
// Geçici hatalarda (429, 5xx, aşırı yük, bağlantı, yarım kalan akış) yaklaşık 4 dakikaya yayılan yeniden denemeler:
// saatler süren bir iş, sağlayıcının kısa bir kesintisi yüzünden düşmesin.
const RETRY_DELAYS = [3000, 10000, 30000, 60000, 120000];
// Node'un fetch'i yanıt başlıkları için 5 dakika bekler; büyük planlar daha uzun sürebildiği için kendi zaman aşımımız.
const STREAM_TIMEOUT_MS = 20 * 60 * 1000;

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
    return JSON.parse(raw).error?.message || raw.slice(0, 400);
  } catch {
    return raw.slice(0, 400);
  }
}

function parseJson(text, who = 'Model') {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new SyntaxError(`${who} geçersiz JSON döndürdü`);
  }
}

// Bağlantı sorunu mu (internet / DNS yok, akış koptu, geçici ağ geçidi hatası)? Kota (429), aşırı yük (529) ve model
// hataları değildir.
const isNetworkError = (e) => e?.network === true || [502, 503, 504].includes(e?.status);

/**
 * Akışlı (SSE) istek. Her `data:` olayı JSON olarak `onEvent`e verilir; onEvent'in fırlattığı hata isteği o hatayla
 * bitirir (akış içi hata olayları böyle bildirilir). JSON olmayan / yarım olaylar yok sayılır.
 * `makeError(message, status, extra)`: sağlayıcının hata sınıfı. Kendi zaman aşımımız `timeout: true` ile işaretlenir
 * (bkz. withRetries) ve ağ sorunu sayılır: 20 dakika olaysız kalan bir akış büyük olasılıkla kopmuş bir bağlantıdır.
 */
function streamRequest(url, { headers, body, signal, onEvent, timeoutMs = STREAM_TIMEOUT_MS, label, makeError }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    let req;
    try {
      req = (target.protocol === 'http:' ? http : https).request(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...headers },
      });
    } catch (e) {
      // Geçersiz başlık (ör. anahtarda bozuk karakter) ağ hatası değildir: tekrar deneme, hemen bildir.
      reject(makeError(`${label} isteği oluşturulamadı: ${e.message}. Ayarlar'dan API anahtarını yeniden girin.`, 0));
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
      done(reject, makeError(`${label} zaman aşımı (${Math.max(1, Math.round(timeoutMs / 60000))} dk)`, 0, { timeout: true, network: true }));
    }, timeoutMs);
    const onAbort = () => {
      req.destroy();
      done(reject, new Error('İptal edildi'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    req.on('error', (e) => done(reject, Object.assign(new TypeError(`${label} bağlantı hatası: ${e.message}`), { network: true })));
    req.on('response', (res) => {
      res.setEncoding('utf8');
      if (res.statusCode >= 400) {
        let raw = '';
        res.on('data', (d) => (raw += d));
        res.on('end', () => {
          const retryAfter = Number(res.headers['retry-after']);
          done(reject, makeError(`${label} ${res.statusCode}: ${errorMessage(raw)}`, res.statusCode, { retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : 0 }));
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
          let ev;
          try {
            ev = JSON.parse(data);
          } catch {
            continue; // yarım olay
          }
          try {
            onEvent?.(ev);
          } catch (e) {
            done(reject, e);
            req.destroy();
            return;
          }
        }
      });
      res.on('end', () => done(resolve));
      res.on('error', (e) => done(reject, Object.assign(new TypeError(`${label} akışı kesildi: ${e.message}`), { network: true })));
    });
    req.end(JSON.stringify(body));
  });
}

/**
 * Yeniden deneme döngüsü. `run()` isteği yapar ve sonucu döner. `adjust(err)` sağlayıcının 400'lerden öğrendiği
 * düzeltmeyi uygular (desteklenmeyen parametreyi kaldırma gibi) ve düzeltme yaptıysa true döner: istek deneme hakkı
 * harcamadan hemen yinelenir. Geçici hatalar (429, 5xx, aşırı yük, bağlantı, yarım kalan akış) `delays` kadar yeniden
 * denenir; kendi zaman aşımımız yalnızca bir kez (20 dakika süren bir yanıt ikinci kez de sürebilir: 2 saat beklenmez).
 */
async function withRetries(run, { signal, delays = RETRY_DELAYS, adjust } = {}) {
  let attempt = 0;
  let timeouts = 0;
  for (;;) {
    try {
      return await run();
    } catch (err) {
      if (signal?.aborted) throw new Error('İptal edildi');
      if (err.status === 400 && adjust?.(err)) continue;
      if (err.timeout) {
        if (timeouts++ >= 1) throw err;
        continue;
      }
      const retryable = RETRY_STATUS.has(err.status) || err.truncated === true || err instanceof TypeError || err instanceof SyntaxError;
      if (!retryable || attempt >= delays.length) throw err;
      await sleep(Math.min(Math.max(err.retryAfterMs || 0, delays[attempt]), 120000), signal);
      attempt++;
    }
  }
}

module.exports = { ApiError, RETRY_DELAYS, STREAM_TIMEOUT_MS, sleep, errorMessage, parseJson, isNetworkError, streamRequest, withRetries };
