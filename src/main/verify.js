// Doğrulama: kurulum/lint/test/build komutları, geliştirme sunucusu ile canlı test
// ve gizli bir tarayıcı penceresiyle ekran görüntüsü + konsol hatası toplama.
const { BrowserWindow } = require('electron');
const fs = require('fs');
const net = require('net');
const path = require('path');
const runner = require('./runner');
const project = require('./project');
const { verifyEnv, findExecutable } = require('./env');

const CHECK_TIMEOUT = 10 * 60 * 1000;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// pnpm/yarn/bun kurulu değilse corepack ya da npx üzerinden çalıştır.
function pmBin(pm) {
  if (pm === 'npm' || findExecutable(pm)) return pm;
  if (pm !== 'bun' && findExecutable('corepack')) return `corepack ${pm}`;
  return `npx -y ${pm}`;
}

function runScript(pm, name) {
  if (pm === 'npm') return name === 'test' ? 'npm test' : `npm run ${name}`;
  return `${pmBin(pm)} run ${name}`;
}

// Hangi komutların çalışacağını belirler.
/**
 * Hangi komutların çalışacağını belirler.
 * Normal mod (her görev sonrası): kurulum, lint, tip kontrolü, test, build.
 * Tam mod (faz kapısı / son test): + servis kurulumu (docker compose), planın ek komutları,
 * test:integration ve test:e2e.
 */
function planChecks(dir, { extraCommands = [], setupCommands = [], full = false } = {}) {
  const app = project.nodeApp(dir);
  const first = [];
  const later = [];
  if (app) {
    const { appDir, scripts, pm } = app;
    if (!fs.existsSync(path.join(appDir, 'node_modules'))) first.push({ name: 'Bağımlılıklar', cmd: `${pmBin(pm)} install`, cwd: appDir, critical: true });
    if (scripts.lint) later.push({ name: 'Lint', cmd: runScript(pm, 'lint'), cwd: appDir });
    const tc = ['typecheck', 'type-check', 'check-types'].find((s) => scripts[s]);
    if (tc) later.push({ name: 'Tip kontrolü', cmd: runScript(pm, tc), cwd: appDir });
    if (scripts.test && !/no test specified/.test(scripts.test)) later.push({ name: 'Testler', cmd: runScript(pm, 'test'), cwd: appDir });
    if (full && scripts['test:integration']) later.push({ name: 'Entegrasyon testleri', cmd: runScript(pm, 'test:integration'), cwd: appDir, needsServices: true });
    if (scripts.build) later.push({ name: 'Build', cmd: runScript(pm, 'build'), cwd: appDir });
    if (full && scripts['test:e2e']) later.push({ name: 'E2E testleri', cmd: runScript(pm, 'test:e2e'), cwd: appDir, timeoutMs: 20 * 60 * 1000, needsServices: true });
  }
  // "pnpm run lint", "npm run lint", "corepack pnpm run lint" aynı komuttur: paket yöneticisini ve "run"ı at.
  const key = (cmd) =>
    String(cmd || '').trim().replace(/\s+/g, ' ').replace(/^(corepack |npx -y )?(npm|pnpm|yarn|bun) (run )?/, '').replace(/^test$/, 'test');
  const seen = new Set([...first, ...later].map((c) => key(c.cmd)));
  const add = (list, cmd, extra = {}) => {
    const norm = String(cmd || '').trim().replace(/\s+/g, ' ');
    if (!norm || seen.has(key(norm))) return;
    seen.add(key(norm));
    list.push({ name: norm, cmd: norm, cwd: app?.appDir || dir, ...extra });
  };
  if (full) {
    // Servisler (ör. docker compose) kurulumdan hemen sonra; docker yoksa atlanır.
    for (const cmd of setupCommands || []) add(first, cmd, { setup: true });
    // Ek komutlar (ör. migration) lint/test/build'den önce; uzun süren sunucular hariç.
    for (const cmd of extraCommands || []) if (!/\b(dev|start|serve|watch)\b/.test(cmd)) add(first, cmd);
  }
  return { app, checks: [...first, ...later] };
}

async function runChecks({ dir, extraCommands, setupCommands, full = false, log, signal }) {
  const { checks } = planChecks(dir, { extraCommands, setupCommands, full });
  if (!checks.length) {
    log({ lvl: 'dim', text: 'Çalıştırılacak doğrulama komutu bulunamadı.' });
    return [];
  }
  const results = [];
  let servicesDown = null;
  let dockerOk = null;
  for (const c of checks) {
    if (signal?.aborted) break;
    // Docker kurulu/çalışır değilse bu bir kod hatası değil, ortam sorunudur: ajana düzelttirme, kullanıcıyı uyar.
    if (c.setup && /^docker\b/.test(c.cmd)) {
      if (dockerOk === null) dockerOk = !!findExecutable('docker') && (await runner.run({ shellCommand: 'docker info', env: verifyEnv(), timeoutMs: 20000 })).code === 0;
      if (!dockerOk) {
        servicesDown = 'Docker kurulu değil ya da Docker Desktop çalışmıyor';
        log({ lvl: 'warn', text: `${servicesDown}; servisler başlatılamadı: ${c.cmd}. Entegrasyon/E2E testleri atlanacak — Docker Desktop'ı açıp "Sürdür" diyebilirsiniz.` });
        results.push({ name: c.name, cmd: c.cmd, ok: false, env: true, code: null, output: servicesDown });
        continue;
      }
    }
    if (c.needsServices && servicesDown) {
      log({ lvl: 'warn', text: `${c.name} atlandı (${servicesDown}).` });
      results.push({ name: c.name, cmd: c.cmd, ok: false, env: true, code: null, output: `Atlandı: ${servicesDown}` });
      continue;
    }
    const started = Date.now();
    log({ lvl: 'tool', text: `$ ${c.cmd}` });
    let lines = 0;
    const onLine = (l) => {
      if (l.trim() && lines++ < 400) log({ lvl: 'dim', text: l });
    };
    const r = await runner.run({ shellCommand: c.cmd, cwd: c.cwd, env: verifyEnv(), timeoutMs: c.timeoutMs || CHECK_TIMEOUT, signal, tailSize: 6000, onStdout: onLine, onStderr: onLine });
    const ok = r.code === 0 && !r.timedOut;
    const secs = Math.round((Date.now() - started) / 1000);
    log({ lvl: ok ? 'ok' : 'error', text: `${ok ? '✓' : '✗'} ${c.name} · ${secs} sn${r.timedOut ? ' · zaman aşımı' : ok ? '' : ` · çıkış ${r.code}`}` });
    results.push({ name: c.name, cmd: c.cmd, ok, code: r.code, timedOut: r.timedOut, output: ((r.stdout || '') + '\n' + (r.stderr || '')).trim().slice(-6000) });
    if (!ok && c.setup) servicesDown = `servis kurulumu başarısız: ${c.cmd}`;
    // Bağımlılık kurulumu başarısızsa sonraki komutlar anlamsız.
    if (!ok && c.critical) break;
  }
  return results;
}

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

/** Gizli pencerede sayfayı açar; durum kodu, konsol hataları, metin ve JPEG döner. */
async function capture(url, { width = 1280, height = 800, mobile = false, auth = null } = {}) {
  const win = new BrowserWindow({
    show: false,
    width,
    height,
    paintWhenInitiallyHidden: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const wc = win.webContents;
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
  let authTried = false;
  wc.on('login', (e, _details, _authInfo, callback) => {
    if (!auth || authTried) return;
    authTried = true;
    e.preventDefault();
    callback(auth.username, auth.password);
  });

  let title = '';
  let text = '';
  let jpeg = null;
  try {
    await Promise.race([wc.loadURL(url), delay(90000).then(() => { throw new Error('90 sn içinde yüklenmedi'); })]).catch((e) => {
      if (!/ERR_ABORTED/.test(e.message)) errors.push(e.message);
    });
    await delay(2500); // hidrasyon ve istemci tarafı hatalar için
    title = wc.getTitle();
    text = await wc.executeJavaScript('document.body ? document.body.innerText.slice(0, 1500) : ""', true).catch(() => '');
    const img = await wc.capturePage(undefined, { stayHidden: true });
    if (!img.isEmpty()) jpeg = (img.getSize().width > 1024 ? img.resize({ width: 1024 }) : img).toJPEG(72);
  } finally {
    win.destroy();
  }
  return { url, status, title, text, errors, jpeg };
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
  const urlRe = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d+/;
  const onLine = (l) => {
    if (!detected) {
      const m = l.match(urlRe);
      if (m) detected = m[0].replace('0.0.0.0', 'localhost').replace('[::1]', 'localhost');
    }
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
  if (!fixedUrl) while (!detected && !exited && Date.now() - t0 < 180000 && !signal?.aborted) await delay(500);
  if (exited) return fail(`Sunucu kapandı (çıkış ${exited.code})`);
  const url = await waitHttp(fixedUrl || detected || `http://localhost:${port}`, 180000, signal);
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
    const list = [...new Set(['/', ...(routes || [])].map((r) => (String(r).startsWith('/') ? r : `/${r}`)))].slice(0, 6);
    const pages = [];
    for (const route of list) {
      if (signal?.aborted) break;
      const r = await capture(base + route, { auth });
      pages.push({ route, viewport: 'masaüstü', ...r });
      const bad = (r.status && r.status >= 400) || r.errors.length;
      log({ lvl: bad ? 'warn' : 'ok', text: `${bad ? '⚠' : '✓'} ${route} · HTTP ${r.status ?? '?'}${r.errors.length ? ` · ${r.errors.length} konsol hatası` : ''}` });
    }
    if (!signal?.aborted) {
      const m = await capture(base + '/', { width: 390, height: 844, mobile: true, auth });
      pages.push({ route: '/', viewport: 'mobil', ...m });
    }
    return { ok: true, base, pages };
  } finally {
    proc.kill();
    await Promise.race([proc.done, delay(6000)]);
  }
}

// Üretim bağımlılıklarındaki bilinen güvenlik açıkları (npm/pnpm audit). Ağ yoksa ya da desteklenmiyorsa null.
async function dependencyAudit(dir, signal) {
  const app = project.nodeApp(dir);
  if (!app || !['npm', 'pnpm'].includes(app.pm)) return null;
  const cmd = app.pm === 'npm' ? 'npm audit --omit=dev --json' : `${pmBin('pnpm')} audit --prod --json`;
  const r = await runner.run({ shellCommand: cmd, cwd: app.appDir, env: verifyEnv(), timeoutMs: 120000, signal, tailSize: 400000 });
  let data;
  try {
    data = JSON.parse(r.stdout.trim().replace(/^[^{]*/, ''));
  } catch {
    return null;
  }
  const counts = data?.metadata?.vulnerabilities || {};
  const list = [];
  for (const [name, v] of Object.entries(data?.vulnerabilities || data?.advisories || {})) {
    const sev = v.severity;
    if (!['high', 'critical'].includes(sev)) continue;
    const fix = v.fixAvailable === false ? 'düzeltme yok' : v.fixAvailable ? 'düzeltme var' : 'bilinmiyor';
    list.push(`${v.name || name} (${sev}, ${fix})`);
  }
  return { counts, highCritical: list, summary: `critical ${counts.critical || 0}, high ${counts.high || 0}, moderate ${counts.moderate || 0}, low ${counts.low || 0}` };
}

module.exports = { runChecks, runSmoke, planChecks, startDevServer, dependencyAudit };
