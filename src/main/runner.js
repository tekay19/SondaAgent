// Alt süreç çalıştırıcı: satır satır akış, zaman aşımı, iptal ve süreç ağacını öldürme.
// Windows'ta .cmd kabukları (claude.cmd, codex.cmd) için cross-spawn kullanılır.
const crossSpawn = require('cross-spawn');
const { spawn } = require('child_process');
const treeKill = require('tree-kill');
const { IS_WIN } = require('./env');

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
const stripAnsi = (s) => s.replace(ANSI, '');

/**
 * Akışı satırlara böler. Satır sonu gelmemiş parçalar birleştirilmeden biriktirilir: her parçada baştan arama yapılmaz,
 * dev bir satır (ör. büyük bir araç sonucu taşıyan stream-json satırı) zamanı katlamaz. `maxLine`'ı aşan satır kesilir;
 * kalanı ayrı bir satır gibi görünmesin diye bir sonraki satır sonuna kadar atlanır.
 */
function lineSplitter(onLine, maxLine = 32 * 1024 * 1024) {
  let parts = [];
  let size = 0;
  let skipping = false;
  const reset = () => {
    parts = [];
    size = 0;
  };
  return {
    push(chunk) {
      let pos = 0;
      let i;
      while ((i = chunk.indexOf('\n', pos)) >= 0) {
        if (skipping) skipping = false;
        else {
          parts.push(chunk.slice(pos, i));
          onLine(parts.join('').replace(/\r$/, ''));
        }
        reset();
        pos = i + 1;
      }
      if (skipping || pos >= chunk.length) return;
      const rest = chunk.slice(pos);
      parts.push(rest);
      size += rest.length;
      if (size > maxLine) {
        onLine(parts.join('').slice(0, maxLine));
        reset();
        skipping = true;
      }
    },
    flush() {
      if (!skipping && size) onLine(parts.join('').replace(/\r$/, ''));
      reset();
      skipping = false;
    },
  };
}

class Tail {
  constructor(max) {
    this.max = max;
    this.s = '';
  }
  add(line) {
    this.s += line + '\n';
    if (this.s.length > this.max * 2) this.s = this.s.slice(-this.max);
  }
  get() {
    return this.s.length > this.max ? '…' + this.s.slice(-this.max) : this.s;
  }
}

// Kapanmamış süreçler: uygulama kapanırken hepsi sonlandırılır (bkz. terminateAll).
const live = new Set();

/**
 * Bir süreci başlatır. Dönen nesne: { child, done: Promise<result>, kill() }
 * - command + args: doğrudan çalıştırma (cross-spawn)
 * - shellCommand: kabuk üzerinden çalıştırma (npm run build gibi)
 * - firstOutputMs: bu süre içinde hiç çıktı gelmezse süreç takılmış sayılır ve kapatılır (sonuçta noOutput: true)
 * - exitGraceMs: ana süreç çıktıktan sonra, çıktı borularını tutan arka plan süreçleri (`cmd &`) için bekleme; sonra
 *   süreç grubu kapatılır. Aksi halde arka planda kalan bir dev sunucusu beklemeyi sonsuza uzatırdı.
 */
function start({ command, args = [], shellCommand, cwd, env, input, onStdout, onStderr, timeoutMs, firstOutputMs, signal, tailSize = 8000, exitGraceMs = 10000 }) {
  const opts = { cwd, env, windowsHide: true, detached: !IS_WIN };
  const child = shellCommand
    ? spawn(shellCommand, { ...opts, shell: true })
    : crossSpawn(command, args, opts);

  const outTail = new Tail(tailSize);
  const errTail = new Tail(tailSize);
  let sawOutput = false;
  const out = lineSplitter((l) => {
    const line = stripAnsi(l);
    sawOutput = true;
    outTail.add(line);
    onStdout?.(line);
  });
  const err = lineSplitter((l) => {
    const line = stripAnsi(l);
    sawOutput = true;
    errTail.add(line);
    onStderr?.(line);
  });
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (d) => out.push(d));
  child.stderr?.on('data', (d) => err.push(d));

  if (child.stdin) {
    child.stdin.on('error', () => {});
    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  }

  let timedOut = false;
  let killed = false;
  let closed = false;
  const timers = new Set();
  const later = (ms, fn) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
  };
  // Süreç kendi grubunun lideridir (detached): grup sinyali EŞZAMANLI gider ve lider çıkmış olsa da gruptaki torunlara
  // ulaşır. tree-kill ayrıca kendi grubunu kurmuş torunları toplar.
  const signalAll = (sig) => {
    if (!child.pid || closed) return;
    if (!IS_WIN) {
      try {
        process.kill(-child.pid, sig);
      } catch {
        /* grup zaten kapanmış */
      }
    }
    treeKill(child.pid, sig, () => {});
  };
  // Grubundan kopmuş (setsid) bir torun boruyu hâlâ tutuyorsa bekleme sonsuza kadar sürmesin: borular kapatılır.
  const forceClose = () => {
    if (closed) return;
    child.stdout?.destroy();
    child.stderr?.destroy();
  };
  const escalate = (afterMs) =>
    later(afterMs, () => {
      if (closed) return;
      signalAll('SIGKILL');
      later(2000, forceClose);
    });
  const kill = () => {
    if (killed || closed) return;
    killed = true;
    signalAll('SIGTERM');
    escalate(4000); // kapanmayı reddeden süreçler için yedek
  };
  if (timeoutMs) {
    later(timeoutMs, () => {
      timedOut = true;
      kill();
    });
  }
  // İlk çıktı bekçisi: bu süre içinde tek bir satır bile gelmediyse süreç (ya da arkasındaki model sağlayıcısı)
  // takılmıştır; tam zaman aşımını (saatler olabilir) beklemeden kapatılır. Ajanlar ilk olayı saniyeler içinde yazar.
  let noOutput = false;
  if (firstOutputMs) {
    later(firstOutputMs, () => {
      if (sawOutput || closed) return;
      noOutput = true;
      timedOut = true;
      kill();
    });
  }
  const onAbort = () => kill();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) kill();
  child.on('exit', () => {
    if (closed || killed) return;
    // Ana süreç bitti ama borular açık: arka planda kalan bir süreç onları tutuyor.
    later(exitGraceMs, () => {
      if (closed) return;
      signalAll('SIGTERM');
      escalate(1000);
    });
  });

  const handle = { child, kill, forceKill: () => signalAll('SIGKILL') };
  live.add(handle);
  handle.done = new Promise((resolve) => {
    let spawnError = null;
    child.on('error', (e) => {
      spawnError = e;
    });
    child.on('close', (code, sig) => {
      closed = true;
      live.delete(handle);
      for (const t of timers) clearTimeout(t);
      timers.clear();
      signal?.removeEventListener('abort', onAbort);
      out.flush();
      err.flush();
      resolve({
        code: spawnError ? -1 : code,
        signal: sig,
        timedOut,
        noOutput,
        killed,
        error: spawnError ? spawnError.message : null,
        stdout: outTail.get(),
        stderr: errTail.get(),
      });
    });
  });
  return handle;
}

function run(opts) {
  return start(opts).done;
}

/**
 * Uygulama kapanırken: tüm süreçlere SIGTERM, en fazla `graceMs` beklenir, kalan süreç grupları SIGKILL ile kapatılır.
 * (Normal kill'in SIGKILL yedeği bir zamanlayıcıdır; uygulama o zamana kadar çoktan kapanmış olurdu.)
 */
async function terminateAll(graceMs = 2000) {
  const procs = [...live];
  if (!procs.length) return;
  for (const p of procs) p.kill();
  let timer;
  await Promise.race([Promise.all(procs.map((p) => p.done)), new Promise((r) => (timer = setTimeout(r, graceMs)))]);
  clearTimeout(timer);
  for (const p of live) p.forceKill();
}

module.exports = { start, run, terminateAll, lineSplitter };
