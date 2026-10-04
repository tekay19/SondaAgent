// Ajan CLI'sinin bulunması, sürümü, kurulumu ve güncellenmesi.
const crossSpawn = require('cross-spawn');
const fs = require('fs');
const path = require('path');
const runner = require('../runner');
const { IS_WIN, findExecutable, findAllExecutables, agentEnv } = require('../env');
const { ADAPTERS } = require('./adapters');

// Bilgisayarda birden fazla kurulum olabilir (Homebrew, resmi yükleyici, npm). Kullanıcı yol
// vermediyse en yeni sürüm kullanılır: Homebrew çoğu zaman birkaç sürüm geriden gelir.
function resolveBin(agentId, settings) {
  const custom = agentId === 'claude' ? settings.claudePath : settings.codexPath;
  if (custom?.trim()) return findExecutable(custom.trim());
  const all = findAllExecutables(ADAPTERS[agentId].bin);
  if (all.length <= 1) return all[0] || null;
  let best = all[0];
  let bestV = semver(versionOf(best));
  for (const b of all.slice(1)) {
    const v = semver(versionOf(b));
    if (v && (!bestV || cmpVersion(v, bestV) > 0)) {
      best = b;
      bestV = v;
    }
  }
  return best;
}

// `--version` çıktısı dosya değişmedikçe önbellekte tutulur (resolveBin sık çağrılır).
const versionCache = new Map();

function versionOf(bin) {
  let key = bin;
  try {
    const real = fs.realpathSync(bin);
    key = `${real}:${fs.statSync(real).mtimeMs}`;
  } catch {
    /* yol çözülemedi */
  }
  if (versionCache.has(key)) return versionCache.get(key);
  let v = null;
  try {
    const r = crossSpawn.sync(bin, ['--version'], { encoding: 'utf8', timeout: 15000, env: agentEnv(), windowsHide: true });
    v = ((r.stdout || '') + (r.stderr || '')).trim().split('\n')[0] || null;
  } catch {
    v = null;
  }
  if (v) versionCache.set(key, v);
  return v;
}

const semver = (text) => String(text || '').match(/(\d+)\.(\d+)\.(\d+)/)?.[0] || null;

function cmpVersion(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

// ---------- güncelleme ----------
const NPM_PACKAGE = { claude: '@anthropic-ai/claude-code', codex: '@openai/codex' };

const BREW_NAME = { claude: 'claude-code', codex: 'codex' };

// Kurulumun nasıl yapıldığı gerçek dosya yolundan anlaşılır; güncelleme komutu buna göre seçilir.
function installKind(bin) {
  let real = bin;
  try {
    real = fs.realpathSync(bin);
  } catch {
    /* olduğu gibi */
  }
  const p = real.replace(/\\/g, '/');
  if (/\/(Caskroom|Cellar)\//.test(p)) return { kind: 'brew', label: 'Homebrew', cask: p.includes('/Caskroom/') };
  if (/\/\.local\/share\/claude\/versions\/|\/\.claude\/local\//.test(p)) return { kind: 'native', label: 'resmi yükleyici' };
  if (/node_modules\//.test(p)) return { kind: 'npm', label: 'npm' };
  return { kind: 'other', label: '' };
}

function updateCommand(agentId, bin) {
  const { kind, cask } = installKind(bin);
  if (kind === 'brew') return { command: findExecutable('brew') || 'brew', args: cask ? ['upgrade', '--cask', BREW_NAME[agentId]] : ['upgrade', BREW_NAME[agentId]] };
  if (kind === 'npm') return { command: findExecutable('npm') || 'npm', args: ['install', '-g', `${NPM_PACKAGE[agentId]}@latest`] };
  if (agentId === 'claude') return { command: bin, args: ['update'] };
  return null;
}

const latestCache = new Map();

// En yeni sürüm: Homebrew kurulumunda Homebrew'un sunduğu sürüm (npm'den geride olabilir), diğerlerinde npm.
async function latestVersion(agentId, bin) {
  const { kind, cask } = installKind(bin);
  const key = `${agentId}:${kind}`;
  const hit = latestCache.get(key);
  if (hit && Date.now() - hit.at < 30 * 60000) return hit.v;
  let v = null;
  try {
    if (kind === 'brew') {
      const r = await runner.run({ command: findExecutable('brew') || 'brew', args: ['info', '--json=v2', cask ? '--cask' : '--formula', BREW_NAME[agentId]], env: { ...agentEnv(), HOMEBREW_NO_AUTO_UPDATE: '1' }, timeoutMs: 20000, tailSize: 200000 });
      const data = JSON.parse(r.stdout);
      v = semver(cask ? data.casks?.[0]?.version : data.formulae?.[0]?.versions?.stable);
    } else {
      const res = await fetch(`https://registry.npmjs.org/${NPM_PACKAGE[agentId].replace('/', '%2f')}/latest`, { signal: AbortSignal.timeout(8000) });
      if (res.ok) v = semver((await res.json()).version);
    }
  } catch {
    v = null;
  }
  if (v) latestCache.set(key, { at: Date.now(), v });
  return v;
}

/**
 * Claude Code'u resmi yükleyiciyle kurar (Node.js gerekmez; ~/.local/bin/claude).
 * macOS / Linux: `curl -fsSL https://claude.ai/install.sh | bash` · Windows: `irm https://claude.ai/install.ps1 | iex`
 */
async function install(agentId, settings, { onLine, signal } = {}) {
  if (agentId !== 'claude') throw new Error(`${ADAPTERS[agentId]?.label || agentId} için otomatik kurulum yok. Terminalde: ${ADAPTERS[agentId]?.install || ''}`);
  if (resolveBin('claude', settings)) return { already: true, version: semver(versionOf(resolveBin('claude', settings))) };
  const lines = [];
  const collect = (line) => {
    if (!line.trim()) return;
    lines.push(line);
    if (lines.length > 200) lines.shift();
    onLine?.(line);
  };
  const opts = { env: agentEnv(), signal, timeoutMs: 10 * 60000, tailSize: 20000, onStdout: collect, onStderr: collect };
  const r = IS_WIN
    ? await runner.run({ command: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://claude.ai/install.ps1 | iex'], ...opts })
    : await runner.run({ command: '/bin/bash', args: ['-c', 'set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash'], ...opts });
  versionCache.clear();
  const bin = resolveBin('claude', settings);
  if (!bin) {
    const tail = lines.slice(-6).join('\n') || r.error || `çıkış kodu ${r.code}`;
    throw new Error(`Claude Code kurulamadı${r.timedOut ? ' (zaman aşımı)' : ''}:\n${tail}\nElle kurmak için terminalde: ${ADAPTERS.claude.install}`);
  }
  return { already: false, version: semver(versionOf(bin)), path: bin };
}

async function update(agentId, settings) {
  const bin = resolveBin(agentId, settings);
  if (!bin) throw new Error(`${ADAPTERS[agentId].label} kurulu değil. Kurulum: ${ADAPTERS[agentId].install}`);
  const cmd = updateCommand(agentId, bin);
  if (!cmd) throw new Error(`${ADAPTERS[agentId].label} için otomatik güncelleme yok. Terminalde: ${ADAPTERS[agentId].install}`);
  const before = semver(versionOf(bin));
  const r = await runner.run({ ...cmd, env: { ...agentEnv(), HOMEBREW_NO_INSTALL_CLEANUP: '1', CI: '1' }, timeoutMs: 5 * 60000, tailSize: 20000 });
  versionCache.clear();
  latestCache.clear();
  const nowBin = resolveBin(agentId, settings);
  const after = semver(versionOf(nowBin));
  if (r.code !== 0) {
    const out = `${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-6).join('\n');
    throw new Error(`Güncelleme başarısız (${[cmd.command, ...cmd.args].join(' ')}):\n${out}`);
  }
  return { before, after, command: [path.basename(cmd.command), ...cmd.args].join(' ') };
}

module.exports = { resolveBin, versionOf, semver, cmpVersion, installKind, updateCommand, latestVersion, install, update };
