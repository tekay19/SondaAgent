// Ajanların proje klasöründe açık bıraktığı süreçleri (ör. arka planda başlatılıp kapatılmayan
// dev sunucusu) bulur ve kapatır. Aksi halde portu işgal eder, tarayıcı testi yanlış uygulamayı ölçer.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const treeKill = require('tree-kill');
const { IS_WIN } = require('./env');

// Yalnızca geliştirme araçları hedeflenir; editör, terminal vb. asla.
const DEV_TOOL = /^(node|npm|npx|pnpm|yarn|bun|deno|vite|next|next-server|tsx|ts-node|esbuild|nodemon|turbo|vitest|playwright|python|python3|uvicorn|php)(\.exe)?$/i;

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15000, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout) => resolve(err && !stdout ? '' : String(stdout || '')));
  });
}

function realDir(dir) {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

const inside = (p, dir) => p === dir || p.startsWith(dir + path.sep);

// Çalışma klasörü proje içinde olan geliştirme süreçleri: [{ pid, name }]
async function projectProcesses(dir) {
  const root = realDir(dir);
  const out = [];
  if (IS_WIN) {
    const ps = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${root.replace(/'/g, "''")}') } | ForEach-Object { "$($_.ProcessId)\`t$($_.Name)" }`;
    const text = await run('powershell.exe', ['-NoProfile', '-Command', ps]);
    for (const line of text.split(/\r?\n/)) {
      const [pid, name] = line.trim().split('\t');
      if (pid && name && DEV_TOOL.test(name)) out.push({ pid: Number(pid), name });
    }
  } else {
    // lsof -F: p<pid> / c<komut> / n<yol> satırları.
    const text = await run('lsof', ['-a', '-d', 'cwd', '-F', 'pcn']);
    let pid = null;
    let name = '';
    for (const line of text.split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1));
      else if (line.startsWith('c')) name = line.slice(1);
      else if (line.startsWith('n') && pid && DEV_TOOL.test(name) && inside(line.slice(1), root)) out.push({ pid, name });
    }
  }
  const own = new Set([process.pid, process.ppid]);
  return out.filter((p) => !own.has(p.pid));
}

// Sahipsiz süreçleri kapatır; kapatılanları döner. `keep`: dokunulmayacak PID'ler (ör. Sonda'nın kendi sunucusu).
async function killOrphans(dir, { keep = [] } = {}) {
  const procs = (await projectProcesses(dir)).filter((p) => !keep.includes(p.pid));
  if (!procs.length) return [];
  await Promise.all(procs.map((p) => new Promise((resolve) => treeKill(p.pid, 'SIGTERM', () => resolve()))));
  await new Promise((r) => setTimeout(r, 1500));
  const left = new Set((await projectProcesses(dir)).map((p) => p.pid));
  await Promise.all(procs.filter((p) => left.has(p.pid)).map((p) => new Promise((resolve) => treeKill(p.pid, 'SIGKILL', () => resolve()))));
  return procs;
}

module.exports = { projectProcesses, killOrphans };
