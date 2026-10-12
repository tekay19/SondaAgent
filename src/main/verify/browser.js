// Tarayıcı testi: geliştirme sunucusu, yalıtılmış gizli pencere, ekran görüntüsü, sayfa denetimleri.
const { BrowserWindow, session } = require('electron');
const fs = require('fs');
const net = require('net');
const path = require('path');
const runner = require('../runner');
const project = require('../project');
const { verifyEnv } = require('../env');
const { CHECK_TIMEOUT, delay, pmBin, runScript } = require('./checks');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d+)/;

/**
 * Dev sunucusu çıktısındaki bir satırdan uygulamanın adresi. Port Sonda'nın verdiğiyse yalnızca o porttaki adres alınır:
 * çıktıda geçen bir proxy, API ya da yardımcı servis adresi yanlışlıkla test edilmesin.
 */
function detectUrl(line, port) {
  const m = String(line || '').match(URL_RE);
  if (!m || (port && Number(m[1]) !== Number(port))) return null;
  return m[0].replace('0.0.0.0', 'localhost').replace('[::1]', 'localhost');
}

// Adres herhangi bir HTTP yanıtı veriyor mu (yönlendirme ve hata kodları da yanıttır)?
const responds = (url) => fetch(url, { signal: AbortSignal.timeout(1500), redirect: 'manual' }).then(() => true, () => false);

async function waitHttp(url, timeoutMs, signal) {
  const alt = url.replace('//localhost', '//127.0.0.1');
  const end = Date.now() + timeoutMs;
  let i = 0;
  while (Date.now() < end && !signal?.aborted) {
    const u = i++ % 2 ? alt : url;
    try {
      await fetch(u, { signal: AbortSignal.timeout(60000), redirect: 'manual' });
      return u;
    } catch {
      await delay(1500);
    }
  }
  return null;
}

// Tarayıcı testi, Sonda'nın kendi oturumundan yalıtılmış ve kalıcı olmayan bir oturumda çalışır. Test edilen
// uygulama (ajanın yazdığı kod) izin isteyemez (kamera, konum, bildirim…), dosya indiremez, pencere açamaz.
let smokeSession = null;

function testSession() {
  if (smokeSession) return smokeSession;
  const s = session.fromPartition('sonda-smoke'); // "persist:" öneki yok → yalnızca bellekte
  s.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  s.setPermissionCheckHandler(() => false);
  s.on('will-download', (e) => e.preventDefault());
  smokeSession = s;
  return s;
}

const sameOrigin = (a, b) => {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
};

// Sayfanın nesnel denetimleri (sayfa içinde çalışır): yatay taşma, kırık görsel, başarısız istek,
// temel erişilebilirlik ve iç bağlantılar. Ürüne özgü bilgi gerektirmez; her web uygulamasında geçerlidir.
const PROBE_JS = `(() => {
  const out = { overflowX: 0, brokenImages: [], failedRequests: [], a11y: [], links: [] };
  try {
    const de = document.documentElement;
    out.overflowX = Math.max(0, Math.round(de.scrollWidth - window.innerWidth));
    out.brokenImages = [...document.images].filter((i) => i.complete && i.naturalWidth === 0 && (i.currentSrc || i.getAttribute('src'))).map((i) => String(i.currentSrc || i.src).slice(0, 160)).slice(0, 8);
    const failed = performance.getEntriesByType('resource').filter((e) => e.responseStatus >= 400).map((e) => { try { const u = new URL(e.name); return u.origin === location.origin ? e.responseStatus + ' ' + u.pathname : null; } catch (_) { return null; } }).filter(Boolean);
    out.failedRequests = [...new Set(failed)].slice(0, 8);
    const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
    const named = (el) => (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title') || el.textContent || '').trim() || (el.querySelector('img[alt]:not([alt=""]), svg title, [aria-label]') ? 'x' : '') || (el.tagName === 'INPUT' ? (el.value || '').trim() : '');
    if (!de.getAttribute('lang')) out.a11y.push('html öğesinde lang özniteliği yok');
    if (!document.title.trim()) out.a11y.push('sayfa başlığı (title) boş');
    const noAlt = [...document.images].filter((i) => !i.hasAttribute('alt') && i.getAttribute('role') !== 'presentation' && visible(i)).length;
    if (noAlt) out.a11y.push(noAlt + ' görselde alt metni yok');
    const noLabel = [...document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]), select, textarea')].filter(visible).filter((el) => !(el.labels && el.labels.length) && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby') && !el.getAttribute('title')).length;
    if (noLabel) out.a11y.push(noLabel + ' form alanının etiketi yok');
    const noName = [...document.querySelectorAll('button, a[href], [role=button], input[type=submit], input[type=button]')].filter(visible).filter((el) => !named(el)).length;
    if (noName) out.a11y.push(noName + ' düğme ya da bağlantının erişilebilir adı yok');
    if (!document.querySelector('main, [role=main]')) out.a11y.push('main bölgesi yok');
    if (!document.querySelector('h1')) out.a11y.push('h1 başlığı yok');
    const links = [];
    for (const a of document.querySelectorAll('a[href]')) {
      try {
        const u = new URL(a.href);
        if (u.origin !== location.origin || (u.pathname === location.pathname && u.search === location.search)) continue;
        if (a.hasAttribute('download') || a.target === '_blank') continue;
        links.push(u.pathname + u.search);
      } catch (_) { /* geçersiz adres */ }
    }
    out.links = [...new Set(links)].slice(0, 40);
  } catch (e) {
    out.error = String(e && e.message);
  }
  return out;
})()`;

/** Gizli pencerede sayfayı açar; durum kodu, konsol hataları, metin, sayfa denetimleri ve JPEG döner. */
async function capture(url, { width = 1280, height = 800, mobile = false, auth = null } = {}) {
  const win = new BrowserWindow({
    show: false,
    width,
    height,
    paintWhenInitiallyHidden: true,
    webPreferences: { session: testSession(), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const wc = win.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  if (mobile) wc.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1');
  const errors = [];
  let status = null;
  wc.on('console-message', (...args) => {
    const e = args[0] || {};
    const level = e.level ?? args[1];
    const message = e.message ?? args[2];
    if ((level === 'error' || level === 3) && message && errors.length < 25) errors.push(String(message).slice(0, 500));
  });
  wc.on('did-navigate', (_e, _url, code) => {
    status = code;
  });
  wc.on('did-fail-load', (_e, code, desc, _u, isMainFrame) => {
    if (isMainFrame && code !== -3) errors.push(`Sayfa yüklenemedi: ${desc} (${code})`);
  });
  wc.on('render-process-gone', (_e, d) => errors.push(`Sayfa çöktü: ${d.reason}`));
  // Basic Auth korumalı uygulamalar: kullanıcının .env'ye girdiği kullanıcı adı/parola (yalnızca bir kez denenir).
  // Kimlik bilgisi yalnızca test edilen uygulamanın kendi adresine gönderilir (sayfanın yüklediği başka
  // bir siteye ya da bir vekil sunucuya asla).
  let authTried = false;
  wc.on('login', (e, details, authInfo, callback) => {
    if (!auth || authTried || authInfo?.isProxy || !sameOrigin(details?.url, url)) return;
    authTried = true;
    e.preventDefault();
    callback(auth.username, auth.password);
  });

  let title = '';
  let text = '';
  let jpeg = null;
  let probes = null;
  try {
    await Promise.race([wc.loadURL(url), delay(90000).then(() => { throw new Error('90 sn içinde yüklenmedi'); })]).catch((e) => {
      if (!/ERR_ABORTED/.test(e.message)) errors.push(e.message);
    });
    await delay(2500); // hidrasyon ve istemci tarafı hatalar için
    title = wc.getTitle();
    text = await wc.executeJavaScript('document.body ? document.body.innerText.slice(0, 1500) : ""', true).catch(() => '');
    probes = await wc.executeJavaScript(PROBE_JS, true).catch(() => null);
    const img = await wc.capturePage(undefined, { stayHidden: true });
    if (!img.isEmpty()) jpeg = (img.getSize().width > 1024 ? img.resize({ width: 1024 }) : img).toJPEG(72);
  } finally {
    win.destroy();
  }
  return { url, status, title, text, errors, jpeg, probes };
}

// Sayfa denetimlerini bulguya çevirir. "error": kusur (düzeltilir); "warn": inceleyici karar verir.
function probeProblems(route, viewport, probes) {
  const out = [];
  if (!probes) return out;
  const add = (level, text) => out.push({ level, route, viewport, text });
  const mobile = viewport === 'mobil';
  if (probes.overflowX > 8) add(mobile ? 'error' : 'warn', `${mobile ? 'Mobilde yatay' : 'Yatay'} taşma: sayfa görünür alandan ${probes.overflowX}px geniş (yatay kaydırma çıkıyor)`);
  for (const src of probes.brokenImages || []) add('error', `Kırık görsel: ${src}`);
  for (const f of probes.failedRequests || []) add(/^(401|403) /.test(f) ? 'warn' : 'error', `Başarısız istek: HTTP ${f}`);
  for (const a of probes.a11y || []) add('warn', `Erişilebilirlik: ${a}`);
  return out;
}

const RISKY_LINK = /(logout|log-out|signout|sign-out|cikis|delete|remove|destroy|sil|download|export|indir)/i;

const FILE_LINK = /\.(pdf|zip|csv|xlsx?|docx?|png|jpe?g|gif|webp|svg|mp4|mp3|ics)(\?|$)/i;

// İç bağlantıların durum kodu (sayfa gezilmeden): 404/5xx dönen bağlantı kırıktır.
async function checkLinks(base, links, { auth, signal }) {
  const out = [];
  const headers = auth ? { Authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}` } : {};
  const queue = links.slice();
  const worker = async () => {
    while (queue.length && !signal?.aborted) {
      const { from, href } = queue.shift();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      try {
        const res = await fetch(base + href, { method: 'GET', redirect: 'manual', headers, signal: ctrl.signal });
        if (res.status >= 400 && res.status !== 401 && res.status !== 403) out.push({ level: 'error', route: from, viewport: '', text: `Kırık iç bağlantı: ${href} → HTTP ${res.status}` });
        await res.arrayBuffer().catch(() => {});
      } catch {
        /* zaman aşımı / bağlantı: sayfa testleri zaten yakalar */
      } finally {
        clearTimeout(timer);
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return out;
}

// Diskteki bir HTML tasarım dosyasını (bağlı CSS / görselleriyle) yalıtılmış pencerede açıp görüntüsünü alır.
async function captureFile(file, opts = {}) {
  const url = `file://${encodeURI(path.resolve(file)).replace(/#/g, '%23').replace(/\?/g, '%3F')}`;
  return capture(url, { ...opts, auth: null });
}

/**
 * Projenin geliştirme sunucusunu boş bir portta başlatır ve yanıt verene kadar bekler.
 * Dönen: { ok, url, proc } ya da { ok: false, error, output } / { skipped }
 */
async function startDevServer({ dir, command, url: fixedUrl, signal, log = () => {} }) {
  const app = project.nodeApp(dir);
  const script = app && (app.scripts.dev ? 'dev' : app.scripts.start ? 'start' : null);
  if (!script && !command) return { skipped: 'Web sunucusu betiği (dev/start) bulunamadı' };
  if (app && !fs.existsSync(path.join(app.appDir, 'node_modules'))) {
    log({ lvl: 'tool', text: `$ ${pmBin(app.pm)} install` });
    const r = await runner.run({ shellCommand: `${pmBin(app.pm)} install`, cwd: app.appDir, env: verifyEnv(), timeoutMs: CHECK_TIMEOUT, signal });
    if (r.code !== 0) return { ok: false, error: 'Bağımlılıklar kurulamadı', output: (r.stdout + '\n' + r.stderr).slice(-4000) };
  }

  // Sabit adres zaten yanıt veriyorsa orada başka bir uygulama çalışıyordur; yanlış uygulamayı test etme.
  if (fixedUrl) {
    const busy = await fetch(fixedUrl, { signal: AbortSignal.timeout(2500), redirect: 'manual' }).then(() => true, () => false);
    if (busy) return { skipped: `${fixedUrl} adresinde zaten başka bir uygulama çalışıyor; tarayıcı testi atlandı. O uygulamayı kapatıp tekrar deneyin.` };
  }

  // Plan özel bir komut verdiyse (monorepo: API + mağaza birlikte) PORT'a dokunma; aksi halde boş port ver.
  const port = command ? null : await freePort();
  const cmd = command || runScript(app.pm, script);
  const cwd = command ? dir : app.appDir;
  log({ lvl: 'tool', text: `$ ${cmd}${port ? `  (PORT=${port})` : ''}` });

  let detected = null;
  const onLine = (l) => {
    if (!detected) detected = detectUrl(l, port);
  };
  const proc = runner.start({ shellCommand: cmd, cwd, env: verifyEnv(port ? { PORT: String(port) } : {}), signal, onStdout: onLine, onStderr: onLine, tailSize: 5000 });
  let exited = null;
  proc.done.then((r) => {
    exited = r;
  });
  const fail = async (error, output) => {
    proc.kill();
    await Promise.race([proc.done, delay(6000)]);
    return { ok: false, error, output: output ?? (exited ? (exited.stdout + '\n' + exited.stderr).slice(-4000) : '') };
  };

  const t0 = Date.now();
  // Port Sonda'nın verdiğiyse adresin yazdırılması beklenmez: port da yoklanır ("listening on 4123" yazan bir sunucu
  // her faz kapısında 3 dakika bekletmesin).
  const portUrl = port ? `http://localhost:${port}` : null;
  if (!fixedUrl) {
    while (!detected && !exited && Date.now() - t0 < 180000 && !signal?.aborted) {
      if (portUrl && (await responds(portUrl))) detected = portUrl;
      else await delay(500);
    }
  }
  if (exited) return fail(`Sunucu kapandı (çıkış ${exited.code})`);
  const target = fixedUrl || detected || (port ? `http://localhost:${port}` : null);
  if (!target) return fail('Sunucu 3 dakikada bir adres yazdırmadı (planda devUrl tanımlı değil)');
  const url = await waitHttp(target, 180000, signal);
  if (!url) return fail('Sunucu 3 dakikada yanıt vermedi');
  return { ok: true, url, proc };
}

/** Geliştirme sunucusunu başlatır, rotaları gezer, ekran görüntüsü alır, kapatır. */
async function runSmoke({ dir, routes, command, url, auth, log, signal }) {
  const server = await startDevServer({ dir, command, url, signal, log });
  if (!server.ok) return server;
  const { url: base, proc } = server;
  log({ lvl: 'info', text: `Sunucu hazır: ${base}` });
  try {
    // Önceki projenin çerezleri / yerel depolaması bu teste karışmasın (localhost çerezleri portlar arasında ortaktır).
    await testSession().clearStorageData().catch(() => {});
    const list = [...new Set(['/', ...(routes || [])].map((r) => (String(r).startsWith('/') ? r : `/${r}`)))].slice(0, 6);
    const pages = [];
    const problems = [];
    const linkSet = new Map();
    for (const route of list) {
      if (signal?.aborted) break;
      const r = await capture(base + route, { auth });
      pages.push({ route, viewport: 'masaüstü', ...r });
      const found = probeProblems(route, 'masaüstü', r.probes);
      problems.push(...found);
      for (const href of r.probes?.links || []) if (!linkSet.has(href) && !list.includes(href.split('?')[0]) && !RISKY_LINK.test(href) && !FILE_LINK.test(href)) linkSet.set(href, route);
      const bad = (r.status && r.status >= 400) || r.errors.length;
      const errs = found.filter((x) => x.level === 'error').length;
      log({ lvl: bad || errs ? 'warn' : 'ok', text: `${bad || errs ? '⚠' : '✓'} ${route} · HTTP ${r.status ?? '?'}${r.errors.length ? ` · ${r.errors.length} konsol hatası` : ''}${errs ? ` · ${errs} sayfa kusuru` : ''}` });
    }
    if (!signal?.aborted) {
      // Mobil görünüm: ana sayfa ve (varsa) ilk iç sayfa.
      for (const route of list.slice(0, 2)) {
        const m = await capture(base + route, { width: 390, height: 844, mobile: true, auth });
        pages.push({ route, viewport: 'mobil', ...m });
        problems.push(...probeProblems(route, 'mobil', m.probes).filter((x) => /taşma/.test(x.text)));
      }
    }
    if (!signal?.aborted) {
      // Var olmayan adres: uygulama çökmemeli, boş sayfa ya da hata yığını göstermemeli.
      const nf = await capture(`${base}/sonda-olmayan-sayfa-${Date.now().toString(36)}`, { auth });
      const crashed = (nf.status && nf.status >= 500) || /Unhandled Runtime Error|Application error|Internal Server Error|\bat \S+ \(.+:\d+:\d+\)/.test(nf.text);
      if (crashed) problems.push({ level: 'error', route: '(var olmayan adres)', viewport: '', text: `Bilinmeyen bir adres ${nf.status ? `HTTP ${nf.status} ile ` : ''}hata sayfası/yığın izi gösteriyor; düzgün bir "bulunamadı" sayfası olmalı` });
      else if (!nf.text.trim()) problems.push({ level: 'warn', route: '(var olmayan adres)', viewport: '', text: 'Bilinmeyen bir adres boş sayfa gösteriyor; "bulunamadı" sayfası yok' });
    }
    if (!signal?.aborted && linkSet.size) problems.push(...(await checkLinks(base, [...linkSet.entries()].slice(0, 25).map(([href, from]) => ({ href, from })), { auth, signal })));
    const errCount = problems.filter((x) => x.level === 'error').length;
    if (problems.length) {
      log({ lvl: errCount ? 'warn' : 'dim', text: `Sayfa denetimi: ${errCount} kusur, ${problems.length - errCount} uyarı` });
      for (const x of problems.slice(0, 12)) log({ lvl: x.level === 'error' ? 'warn' : 'dim', text: `${x.level === 'error' ? '✗' : '·'} ${x.route}${x.viewport ? ` (${x.viewport})` : ''}: ${x.text}` });
    } else log({ lvl: 'ok', text: 'Sayfa denetimi: taşma, kırık görsel/bağlantı ve temel erişilebilirlik sorunu yok.' });
    return { ok: true, base, pages, problems };
  } finally {
    proc.kill();
    await Promise.race([proc.done, delay(6000)]);
  }
}

module.exports = { PROBE_JS, probeProblems, captureFile, detectUrl, startDevServer, runSmoke };
