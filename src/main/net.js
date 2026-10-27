// Bağlantı yoklaması: internet / DNS kesintisinde iş başarısız sayılmaz; bağlantı gelene kadar beklenir.
const dns = require('dns');
const net = require('net');

// Ajan oturumlarının ve yöneticinin konuştuğu sunucular.
// OpenCode'un sağlayıcısı bilinmez (NVIDIA, OpenAI, OpenRouter…); bağlantı yoklaması için OpenCode'un açılışta
// model kataloğunu çektiği sunucu kullanılır.
const HOSTS = { claude: 'api.anthropic.com', codex: 'api.openai.com', opencode: 'models.dev' };

// Vekil sunucu arkasında doğrudan bağlantı denemesi yanıltır (API vekilden erişilebilir olabilir): yoklama atlanır.
const proxied = () => ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy'].some((k) => process.env[k]);

/** Sunucunun adı çözülüyor ve 443'e bağlanılabiliyor mu? */
function reachable(host, timeoutMs = 5000) {
  if (proxied()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let sock = null;
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock?.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    dns.lookup(host, (err, address) => {
      if (err || settled) return finish(false);
      sock = net.connect({ host: address, port: 443 });
      sock.once('connect', () => finish(true));
      sock.once('error', () => finish(false));
    });
  });
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Durduruldu'));
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error('Durduruldu'));
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Sunucuya ulaşılana kadar bekler. Dönen: true (bağlantı var) | false (maxMs doldu). İptal edilirse reddeder.
 * `probe` ve `everyMs` testler için değiştirilebilir.
 */
async function waitOnline(host, { signal, maxMs = 6 * 3600 * 1000, everyMs = 15000, probe = reachable } = {}) {
  const t0 = Date.now();
  for (;;) {
    if (signal?.aborted) throw new Error('Durduruldu');
    if (await probe(host)) return true;
    if (Date.now() - t0 >= maxMs) return false;
    await sleep(everyMs, signal);
  }
}

// Bir API adresinin sunucu adı (bağlantı yoklaması için); çözülemezse Claude'un sunucusu.
const hostOf = (url) => {
  try {
    return new URL(String(url || '')).hostname || HOSTS.claude;
  } catch {
    return HOSTS.claude;
  }
};

module.exports = { HOSTS, hostOf, reachable, waitOnline };
