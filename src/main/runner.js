// Alt süreç çalıştırıcı: satır satır akış, zaman aşımı, iptal ve süreç ağacını öldürme.
// Windows'ta .cmd kabukları (claude.cmd, codex.cmd) için cross-spawn kullanılır.
const crossSpawn = require('cross-spawn');
const { spawn } = require('child_process');
const treeKill = require('tree-kill');
const { IS_WIN } = require('./env');

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
const stripAnsi = (s) => s.replace(ANSI, '');

function lineSplitter(onLine) {
  let buf = '';
  return {
    push(chunk) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        onLine(line);
      }
    },
    flush() {
      if (buf) onLine(buf.replace(/\r$/, ''));
      buf = '';
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

/**
 * Bir süreci başlatır. Dönen nesne: { child, done: Promise<result>, kill() }
 * - command + args: doğrudan çalıştırma (cross-spawn)
 * - shellCommand: kabuk üzerinden çalıştırma (npm run build gibi)
 */
function start({ command, args = [], shellCommand, cwd, env, input, onStdout, onStderr, timeoutMs, signal, tailSize = 8000 }) {
  const opts = { cwd, env, windowsHide: true, detached: !IS_WIN };
  const child = shellCommand
    ? spawn(shellCommand, { ...opts, shell: true })
    : crossSpawn(command, args, opts);

  const outTail = new Tail(tailSize);
  const errTail = new Tail(tailSize);
  const out = lineSplitter((l) => {
    const line = stripAnsi(l);
    outTail.add(line);
    onStdout?.(line);
  });
  const err = lineSplitter((l) => {
    const line = stripAnsi(l);
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
  const kill = () => {
    if (killed || child.exitCode != null) return;
    killed = true;
    if (child.pid) treeKill(child.pid, 'SIGTERM', () => {});
    // Kapanmayı reddeden süreçler için yedek.
    setTimeout(() => {
      if (child.exitCode == null && child.pid) treeKill(child.pid, 'SIGKILL', () => {});
    }, 4000).unref();
  };
  const timer = timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        kill();
      }, timeoutMs)
    : null;
  const onAbort = () => kill();
  signal?.addEventListener('abort', onAbort, { once: true });

  const done = new Promise((resolve) => {
    let spawnError = null;
    child.on('error', (e) => {
      spawnError = e;
    });
    child.on('close', (code, sig) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      out.flush();
      err.flush();
      resolve({
        code: spawnError ? -1 : code,
        signal: sig,
        timedOut,
        killed,
        error: spawnError ? spawnError.message : null,
        stdout: outTail.get(),
        stderr: errTail.get(),
      });
    });
  });

  return { child, done, kill };
}

function run(opts) {
  return start(opts).done;
}

module.exports = { start, run, stripAnsi };
