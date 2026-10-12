// Temiz klon denetimi: commit'li proje sıfırdan kurulup test edilebiliyor mu.
const fs = require('fs');
const os = require('os');
const path = require('path');
const runner = require('../runner');
const project = require('../project');
const { verifyEnv } = require('../env');
const { killOrphans } = require('../procs');
const { CHECK_TIMEOUT, pmBin, runScript } = require('./checks');

// Üretim bağımlılıklarındaki bilinen güvenlik açıkları (npm/pnpm audit). Ağ yoksa ya da desteklenmiyorsa null.
// ---------- temiz klon denetimi ----------
const NETWORK_ERR = /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|getaddrinfo|socket hang up|network (request|connectivity)|ERR_SOCKET_TIMEOUT|fetch failed/i;

// Kilit dosyasına sadık kurulum: kilit ile package.json uyuşmuyorsa hata verir (npm install sessizce düzeltirdi).
function frozenInstall(pm, appDir) {
  if (pm === 'npm') return fs.existsSync(path.join(appDir, 'package-lock.json')) ? 'npm ci' : 'npm install';
  if (pm === 'pnpm' || pm === 'yarn' || pm === 'bun') return `${pmBin(pm)} install --frozen-lockfile`;
  return `${pmBin(pm)} install`;
}

/**
 * Temiz klon denetimi: projenin commit'li hali geçici bir klasöre klonlanır, yeni bir geliştiricinin yapacağı gibi
 * .env.example → .env kopyalanır; bağımlılıklar kilit dosyasından kurulur, tip kontrolü ve birim testleri çalışır.
 * "Yalnızca geliştirildiği klasörde çalışan" projeyi yakalar: commit'lenmemiş / yanlışlıkla yok sayılan dosya,
 * kurulumun parçası olmayan kod üretimi, .env.example'da eksik ayar isteyen postinstall, eşitlenmemiş kilit dosyası.
 * Dönen: runChecks biçiminde tek bir sonuç ({ name, cmd, ok, output, fresh: true }) ya da uygulanamıyorsa null.
 */
async function freshCloneCheck({ dir, log = () => {}, signal }) {
  const git = project.gitBin();
  if (!git || !project.nodeApp(dir) || !(await project.headCommit(dir))) return null;
  const name = 'Temiz kurulum (yeni klon)';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sonda-klon-'));
  const clone = path.join(tmp, 'proje');
  const started = Date.now();
  const steps = [];
  try {
    log({ lvl: 'tool', text: '$ git clone (geçici klasör) → .env.example → kurulum → tip kontrolü → test' });
    const c = await runner.run({ command: git, args: ['clone', '--quiet', '--no-hardlinks', path.resolve(dir), clone], env: verifyEnv(), timeoutMs: 180000, signal });
    if (c.code !== 0) return null; // klon alınamadı: ortam sorunu, kod hatası değil
    const app = project.nodeApp(clone);
    if (!app) return null;
    for (const d of new Set([clone, app.appDir])) {
      const example = path.join(d, '.env.example');
      if (fs.existsSync(example) && !fs.existsSync(path.join(d, '.env'))) fs.copyFileSync(example, path.join(d, '.env'));
    }
    const tc = ['typecheck', 'type-check', 'check-types'].find((k) => app.scripts[k]);
    const cmds = [frozenInstall(app.pm, app.appDir), tc && runScript(app.pm, tc), app.scripts.test && !/no test specified/.test(app.scripts.test) && runScript(app.pm, 'test')].filter(Boolean);
    for (const cmd of cmds) {
      if (signal?.aborted) return null;
      steps.push(cmd);
      const r = await runner.run({ shellCommand: cmd, cwd: app.appDir, env: verifyEnv(), timeoutMs: CHECK_TIMEOUT, signal, tailSize: 6000 });
      if (signal?.aborted) return null;
      if (r.code === 0 && !r.timedOut) continue;
      const out = `${r.stdout || ''}\n${r.stderr || ''}`.trim();
      if (steps.length === 1 && NETWORK_ERR.test(out)) {
        log({ lvl: 'warn', text: `${name} atlandı: paket kayıt defterine ulaşılamadı.` });
        return { name, cmd: `yeni klon: ${cmd}`, ok: false, env: true, fresh: true, code: r.code, output: 'Atlandı: paket kayıt defterine ulaşılamadı' };
      }
      log({ lvl: 'error', text: `✗ ${name} · ${cmd} · ${r.timedOut ? 'zaman aşımı' : `çıkış ${r.code}`}` });
      return {
        name,
        cmd: `yeni klon: ${cmd}`,
        ok: false,
        fresh: true,
        code: r.code,
        timedOut: !!r.timedOut,
        // Açıklama çıktıdan ayrı tutulur: istemler çıktının sonunu keser, açıklama kaybolmamalı.
        note: `A FRESH CLONE of the committed project fails (git clone → cp .env.example .env → ${steps.join(' → ')}), at \`${cmd}\`. A new developer following the README hits this even though the same command passes in the working folder. Typical causes: a file that is not committed or is ignored by mistake, code generation that is not part of install/build, a postinstall hook that needs a setting missing from .env.example, a lockfile out of sync with package.json, tests that depend on local state (a database file, a build output).`,
        output: out.slice(-4500),
      };
    }
    log({ lvl: 'ok', text: `✓ ${name} · ${Math.round((Date.now() - started) / 1000)} sn` });
    return { name, cmd: `yeni klon: ${steps.join(' → ')}`, ok: true, fresh: true, code: 0, output: '' };
  } catch (e) {
    if (!signal?.aborted) log({ lvl: 'warn', text: `${name} çalıştırılamadı: ${e.message}` });
    return null;
  } finally {
    // Klondaki testlerin açık bıraktığı süreçler (kilitli dosyaları da tutarlar) önce kapatılır. Silme hatası denetimin
    // sonucunu ezmesin: Windows'ta kilitli kalan geçici klasörü işletim sistemi temizler.
    await killOrphans(tmp).catch(() => {});
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
    } catch {
      /* geçici klasör */
    }
  }
}

module.exports = { frozenInstall, freshCloneCheck };
