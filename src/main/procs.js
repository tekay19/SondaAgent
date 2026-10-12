// Ajanların proje klasöründe açık bıraktığı süreçleri (ör. arka planda başlatılıp kapatılmayan
// dev sunucusu) bulur ve kapatır. Aksi halde portu işgal eder, tarayıcı testi yanlış uygulamayı ölçer.
// Yalnızca SAHİPSİZ süreçler kapatılır: kullanıcının kendi terminalinde, editöründe ya da başka bir ajan
// oturumunda başlattığı süreçlerin yaşayan bir sahibi vardır; onlara dokunulmaz.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const treeKill = require('tree-kill');
const { IS_WIN } = require('./env');

// Yalnızca geliştirme araçları hedeflenir; editör, terminal vb. asla.
const DEV_TOOL = /^(node|npm|npx|pnpm|yarn|bun|deno|vite|next|next-server|tsx|ts-node|esbuild|nodemon|turbo|vitest|playwright|python|python3|uvicorn|php)(\.exe)?$/i;
// Kabuklar sahiplik zincirinde "geçirgen"dir: ajan komutları `zsh -c "npm run dev"` ile başlatır.
const SHELL = /^(sh|bash|zsh|dash|fish|ksh|tcsh|csh|cmd|powershell|pwsh|conhost)(\.exe)?$/i;

const baseName = (comm) => String(comm || '').trim().split(/[\\/]/).pop().replace(/^-/, ''); // giriş kabuğu: "-zsh"

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

/**
 * Windows: süreç komut satırında proje klasörü geçiyor mu? Büyük/küçük harf ve eğik çizgi yönü önemsizdir; klasör adı
 * sınırda bitmelidir (`C:\proj` için `C:\proj-old\…` sayılmaz).
 */
function commandLineInside(commandLine, root) {
  const norm = (s) => String(s || '').replace(/\//g, '\\').toLowerCase();
  const cmd = norm(commandLine);
  const dir = norm(root).replace(/\\+$/, '');
  if (!cmd || !dir) return false;
  for (let i = cmd.indexOf(dir); i >= 0; i = cmd.indexOf(dir, i + 1)) {
    const next = cmd[i + dir.length];
    if (next === undefined || /[\\"' ]/.test(next)) return true;
  }
  return false;
}

// Çalışan tüm süreçler: Map(pid → { ppid, name })
async function processTable() {
  const table = new Map();
  if (IS_WIN) {
    const text = await run('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.Name)" }']);
    for (const line of text.split(/\r?\n/)) {
      const [pid, ppid, name] = line.trim().split('\t');
      if (pid && name) table.set(Number(pid), { ppid: Number(ppid) || 0, name });
    }
  } else {
    const text = await run('ps', ['-A', '-o', 'pid=,ppid=,comm=']);
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
      if (m) table.set(Number(m[1]), { ppid: Number(m[2]), name: baseName(m[3]) });
    }
  }
  return table;
}

// Çalışma klasörü proje içinde olan geliştirme süreçleri: [{ pid, name }]
async function projectProcesses(dir) {
  const root = realDir(dir);
  const out = [];
  if (IS_WIN) {
    // Eşleşme burada (commandLineInside) yapılır: PowerShell'in Contains'i harfe duyarlıdır ve klasör sınırına bakmaz.
    const ps = 'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } | ForEach-Object { "$($_.ProcessId)`t$($_.Name)`t$($_.CommandLine)" }';
    const text = await run('powershell.exe', ['-NoProfile', '-Command', ps]);
    for (const line of text.split(/\r?\n/)) {
      const [pid, name, ...cmd] = line.trim().split('\t');
      if (pid && name && DEV_TOOL.test(name) && commandLineInside(cmd.join('\t'), root)) out.push({ pid: Number(pid), name });
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

/**
 * Adaylardan sahipsiz olanları seçer (saf işlev; test edilebilir).
 * Bir süreç, ebeveyn zinciri yalnızca adaylardan ve kabuklardan geçip köke (pid 1 ya da artık var olmayan
 * bir ebeveyne) ulaşıyorsa sahipsizdir. Zincirde yaşayan başka bir süreç (terminal, editör, ajan, Sonda'nın
 * kendisi) varsa sahiplidir: o süreç hâlâ onu yönetiyor demektir.
 */
function orphansOf(candidates, table) {
  const cand = new Set(candidates.map((p) => p.pid));
  const orphan = (pid) => {
    let cur = table.get(pid);
    if (!cur) return false; // artık çalışmıyor
    for (let hops = 0; hops < 64; hops++) {
      if (cur.ppid <= 1) return true; // launchd / init'e bağlanmış
      const parent = table.get(cur.ppid);
      if (!parent) return true; // ebeveyni kapanmış (Windows'ta kimlik havada kalır)
      if (!cand.has(cur.ppid) && !SHELL.test(parent.name)) return false; // yaşayan bir sahibi var
      cur = parent;
    }
    return false;
  };
  return candidates.filter((p) => orphan(p.pid));
}

const kill = (pid, sig) => new Promise((resolve) => treeKill(pid, sig, () => resolve()));

// Sahipsiz süreçleri kapatır; kapatılanları döner. `keep`: dokunulmayacak PID'ler.
async function killOrphans(dir, { keep = [] } = {}) {
  const found = (await projectProcesses(dir)).filter((p) => !keep.includes(p.pid));
  if (!found.length) return [];
  const procs = orphansOf(found, await processTable());
  if (!procs.length) return [];
  await Promise.all(procs.map((p) => kill(p.pid, 'SIGTERM')));
  await new Promise((r) => setTimeout(r, 1500));
  const left = new Set((await projectProcesses(dir)).map((p) => p.pid));
  await Promise.all(procs.filter((p) => left.has(p.pid)).map((p) => kill(p.pid, 'SIGKILL')));
  return procs;
}

module.exports = { projectProcesses, orphansOf, killOrphans, commandLineInside };
