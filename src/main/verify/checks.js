// Doğrulama komutları: kurulum, lint, tip kontrolü, test, derleme; bağımlılık güvenlik taraması.
const fs = require('fs');
const path = require('path');
const runner = require('../runner');
const project = require('../project');
const { verifyEnv, findExecutable } = require('../env');

const CHECK_TIMEOUT = 10 * 60 * 1000;

// docker compose "required variable X is missing a value": kodun değil, ortamın (.env) eksiği. Adlar döner.
const envMissingNames = (output) => [...new Set([...String(output || '').matchAll(/required variable ([A-Za-z_][A-Za-z0-9_]*) is missing a value/g)].map((m) => m[1]))];

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
    if (scripts.lint) later.push({ name: 'Kod denetimi', cmd: runScript(pm, 'lint'), cwd: appDir });
    const tc = ['typecheck', 'type-check', 'check-types'].find((s) => scripts[s]);
    if (tc) later.push({ name: 'Tip kontrolü', cmd: runScript(pm, tc), cwd: appDir });
    if (scripts.test && !/no test specified/.test(scripts.test)) later.push({ name: 'Testler', cmd: runScript(pm, 'test'), cwd: appDir });
    if (full && scripts['test:integration']) later.push({ name: 'Entegrasyon testleri', cmd: runScript(pm, 'test:integration'), cwd: appDir, needsServices: true });
    if (scripts.build) later.push({ name: 'Derleme', cmd: runScript(pm, 'build'), cwd: appDir });
    if (full && scripts['test:e2e']) later.push({ name: 'Uçtan uca testler', cmd: runScript(pm, 'test:e2e'), cwd: appDir, timeoutMs: 20 * 60 * 1000, needsServices: true });
  }
  // "pnpm run lint", "npm run lint", "corepack pnpm run lint" aynı komuttur: paket yöneticisini ve "run"ı at.
  const key = (cmd) =>
    String(cmd || '').trim().replace(/\s+/g, ' ').replace(/^(corepack |npx -y )?(npm|pnpm|yarn|bun) (run )?/, '').replace(/^test$/, 'test');
  const seen = new Set([...first, ...later].map((c) => key(c.cmd)));
  const add = (list, cmd, extra = {}) => {
    let norm = String(cmd || '').trim().replace(/\s+/g, ' ');
    // "! komut": komut HATA vermeli (sıfır dışı çıkış) — ör. bir CLI'nin hatalı girdiyi reddettiğini doğrulamak.
    const expectFail = /^!\s*/.test(norm);
    if (expectFail) norm = norm.replace(/^!\s*/, '');
    const k = `${expectFail ? '!' : ''}${key(norm)}`;
    if (!norm || seen.has(k)) return;
    seen.add(k);
    list.push({ name: expectFail ? `${norm} (hata vermeli)` : norm, cmd: norm, cwd: app?.appDir || dir, ...(expectFail ? { expectFail: true } : {}), ...extra });
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
        log({ lvl: 'warn', text: `${servicesDown}; servisler başlatılamadı: ${c.cmd}. Entegrasyon ve uçtan uca testler atlanacak — Docker Desktop'ı açıp "Sürdür" diyebilirsiniz.` });
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
    // Hata vermesi beklenen komut: normal biçimde sıfır dışı bir kodla bitmeli (zaman aşımı, başlatılamama
    // ya da "komut bulunamadı" (126/127) beklenen hata sayılmaz).
    const failedProperly = !r.timedOut && r.code != null && r.code > 0 && r.code !== 126 && r.code !== 127;
    const ok = c.expectFail ? failedProperly : r.code === 0 && !r.timedOut;
    const secs = Math.round((Date.now() - started) / 1000);
    const why = r.timedOut ? ' · zaman aşımı' : ok ? '' : c.expectFail && r.code === 0 ? ' · hata vermesi gerekirken başarıyla bitti' : ` · çıkış ${r.code}`;
    log({ lvl: ok ? 'ok' : 'error', text: `${ok ? '✓' : '✗'} ${c.name} · ${secs} sn${why}` });
    const output = ((r.stdout || '') + '\n' + (r.stderr || '')).trim().slice(-6000);
    const missingEnv = !ok && !c.expectFail ? envMissingNames(output) : [];
    if (missingEnv.length) log({ lvl: 'warn', text: `Eksik ortam değişkeni: ${missingEnv.join(', ')} — "Anahtarlar"dan girin; bu kod hatası sayılmaz.` });
    results.push({ name: c.name, cmd: c.cmd, ok, code: r.code, timedOut: r.timedOut, ...(c.expectFail ? { expectFail: true } : {}), ...(missingEnv.length ? { env: true } : {}), output });
    if (!ok && c.setup) servicesDown = `servis kurulumu başarısız: ${c.cmd}`;
    // Bağımlılık kurulumu başarısızsa sonraki komutlar anlamsız.
    if (!ok && c.critical) break;
  }
  return results;
}

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

module.exports = { envMissingNames, CHECK_TIMEOUT, delay, pmBin, runScript, planChecks, runChecks, dependencyAudit };
