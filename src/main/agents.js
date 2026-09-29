// Kodlama ajanı adaptörleri: Claude Code ve OpenAI Codex CLI.
// Her adaptör komut satırı argümanlarını kurar ve JSON olay akışını
// arayüz için normalleştirilmiş log satırlarına çevirir.
const crossSpawn = require('cross-spawn');
const fs = require('fs');
const os = require('os');
const path = require('path');
const runner = require('./runner');
const { findExecutable, findAllExecutables, agentEnv } = require('./env');

const clip = (s, n) => {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + '…' : s;
};

const LIMIT_ERROR = /usage limit|limit reached|hit your (usage )?limit|limit will reset|rate.?limit(ed)?|too many requests|quota exceeded|overloaded/i;

// Limit mesajından sıfırlanma zamanını çıkarır (ms). Bulamazsa 30 dk sonrası.
function parseResetAt(text, now = Date.now()) {
  const epoch = text.match(/\|(\d{10})\b/);
  if (epoch) return Number(epoch[1]) * 1000;
  const rel = text.match(/\bin\s+(\d+)\s*(hours?|hrs?|h|minutes?|mins?|m)\b(?:\s*(?:and\s*)?(\d+)\s*(?:minutes?|mins?|m)\b)?/i);
  if (rel) {
    const first = Number(rel[1]);
    const mins = /^h/i.test(rel[2]) ? first * 60 + Number(rel[3] || 0) : first;
    return now + mins * 60000;
  }
  const at = text.match(/(?:resets?|reset at|try again at)\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (at) {
    let h = Number(at[1]) % 24;
    const m = Number(at[2] || 0);
    if (at[3]) h = (h % 12) + (/pm/i.test(at[3]) ? 12 : 0);
    const d = new Date(now);
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  return now + 30 * 60000;
}

const AUTH_ERROR = /failed to authenticate|authentication (failed|error)|not logged in|please log ?in|run .{0,20}login|invalid (x-)?api[ -]?key|oauth (session|token)|unauthori[sz]ed/i;

// "Güvenli" modda Claude Code'un sormadan çalıştırabileceği komutlar.
const CLAUDE_SAFE_TOOLS = [
  'Read', 'Edit', 'Write', 'Glob', 'Grep', 'TodoWrite', 'WebFetch', 'WebSearch',
  'Bash(npm *)', 'Bash(npx *)', 'Bash(pnpm *)', 'Bash(yarn *)', 'Bash(bun *)', 'Bash(node *)',
  'Bash(git *)', 'Bash(ls *)', 'Bash(cat *)', 'Bash(mkdir *)', 'Bash(cp *)', 'Bash(mv *)',
  'Bash(python *)', 'Bash(python3 *)', 'Bash(pip *)', 'Bash(pip3 *)', 'Bash(tsc *)',
];

// İnceleyici ajan salt okunurdur: okuma/arama ve yalnızca test/lint/tip/build ile sürüm sorgulama
// komutları. Dosya yazma araçları kapalı; listede olmayan her Bash komutu reddedilir.
const REVIEW_TOOLS = 'Read,Grep,Glob,Bash';
const REVIEW_ALLOWED = [
  'Read', 'Grep', 'Glob',
  'Bash(ls:*)', 'Bash(cat:*)', 'Bash(head:*)', 'Bash(tail:*)', 'Bash(wc:*)', 'Bash(find:*)', 'Bash(grep:*)', 'Bash(rg:*)', 'Bash(tree:*)', 'Bash(pwd)',
  'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git status:*)', 'Bash(git ls-files:*)',
  'Bash(npm view:*)', 'Bash(npm ls:*)', 'Bash(node --version)', 'Bash(npm --version)', 'Bash(node -v)', 'Bash(npm -v)', 'Bash(pnpm -v)', 'Bash(git --version)',
  ...['npm', 'pnpm', 'yarn', 'bun'].flatMap((pm) => ['test', 'run test', 'run lint', 'run typecheck', 'run type-check', 'run build', 'lint', 'typecheck'].map((c) => `Bash(${pm} ${c}:*)`)),
  'Bash(npm test)', 'Bash(pnpm test)', 'Bash(yarn test)',
  'Bash(npx vitest:*)', 'Bash(npx jest:*)', 'Bash(npx tsc:*)', 'Bash(npx eslint:*)', 'Bash(npx playwright test:*)', 'Bash(npx prisma validate:*)',
];

function summarizeToolInput(name, input = {}) {
  if (input.command) return clip(input.command, 300);
  if (input.file_path) return input.file_path;
  if (input.path && input.pattern) return `${input.pattern} (${input.path})`;
  if (input.pattern) return input.pattern;
  if (input.url) return input.url;
  if (input.query) return input.query;
  if (input.description) return clip(input.description, 200);
  if (Array.isArray(input.todos)) {
    return input.todos.map((t) => `${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : '○'} ${t.content}`).join('\n');
  }
  return clip(JSON.stringify(input), 200);
}

// ---------- Claude Code ----------
function claudeParser() {
  const state = { sessionId: null, text: '', lastAssistantText: '', texts: [], structured: null, isError: false, costUsd: 0, gotResult: false, errorText: '' };
  return {
    state,
    onLine(line) {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return line.trim() ? [{ lvl: 'dim', text: line }] : [];
      }
      if (ev.session_id) state.sessionId = ev.session_id;
      const out = [];
      if (ev.type === 'system' && ev.subtype === 'init') {
        out.push({ lvl: 'info', text: `Claude Code oturumu başladı${ev.model ? ` · ${ev.model}` : ''}` });
      } else if (ev.type === 'system' && ev.subtype === 'api_retry') {
        out.push({ lvl: 'warn', text: `API yeniden deneniyor (${ev.error || ev.error_status || 'hata'}, deneme ${ev.attempt})` });
      } else if (ev.type === 'assistant') {
        for (const c of ev.message?.content || []) {
          if (c.type === 'text' && c.text?.trim()) {
            state.lastAssistantText = c.text;
            state.texts.push(c.text);
            out.push({ lvl: 'text', text: c.text.trim() });
          } else if (c.type === 'tool_use' && c.name === 'StructuredOutput' && c.input && typeof c.input === 'object') {
            // --json-schema sonucu: CLI son mesaja koymasa bile araç çağrısından yakala.
            state.structured = c.input;
            out.push({ lvl: 'tool', text: 'Sonuç yapılandırılmış olarak teslim edildi' });
          } else if (c.type === 'tool_use') {
            out.push({ lvl: 'tool', text: `${c.name} · ${summarizeToolInput(c.name, c.input)}` });
          }
        }
      } else if (ev.type === 'user') {
        for (const c of ev.message?.content || []) {
          if (c.type !== 'tool_result') continue;
          const body = Array.isArray(c.content) ? c.content.map((x) => x.text || '').join('\n') : String(c.content ?? '');
          if (c.is_error) out.push({ lvl: 'warn', text: clip(body.trim(), 600) });
          else if (body.trim()) out.push({ lvl: 'dim', text: clip(body.trim(), 280) });
        }
      } else if (ev.type === 'result') {
        state.gotResult = true;
        state.isError = !!ev.is_error || (ev.subtype && ev.subtype !== 'success');
        state.text = ev.result || state.lastAssistantText || '';
        if (ev.structured_output && typeof ev.structured_output === 'object') state.structured = ev.structured_output;
        state.costUsd = ev.total_cost_usd || 0;
        if (state.isError) state.errorText = state.text || ev.subtype;
        const secs = ev.duration_ms ? ` · ${Math.round(ev.duration_ms / 1000)} sn` : '';
        const cost = state.costUsd ? ` · $${state.costUsd.toFixed(2)}` : '';
        out.push({ lvl: state.isError ? 'error' : 'ok', text: `${state.isError ? 'Ajan hata ile bitti' : 'Ajan bitirdi'}${secs}${cost}${ev.num_turns ? ` · ${ev.num_turns} adım` : ''}` });
      }
      return out;
    },
  };
}

// ---------- OpenAI Codex CLI ----------
function codexParser() {
  const state = { sessionId: null, text: '', texts: [], structured: null, isError: false, costUsd: 0, gotResult: false, errorText: '', tokens: 0 };
  const itemLog = (item, phase) => {
    const t = item.type || item.item_type;
    if (t === 'agent_message' && phase === 'completed') {
      state.text = item.text || state.text;
      if (item.text) state.texts.push(item.text);
      return item.text?.trim() ? { lvl: 'text', text: item.text.trim() } : null;
    }
    if (t === 'reasoning' && phase === 'completed') return item.text?.trim() ? { lvl: 'dim', text: clip(item.text.trim(), 400) } : null;
    if (t === 'command_execution') {
      if (phase === 'started') return { lvl: 'tool', text: `Komut · ${clip(item.command, 300)}` };
      if (phase === 'completed') {
        const bad = item.exit_code != null && item.exit_code !== 0;
        const body = clip((item.aggregated_output || '').trim(), bad ? 600 : 240);
        return { lvl: bad ? 'warn' : 'dim', text: `çıkış ${item.exit_code ?? '?'}${body ? ` · ${body}` : ''}` };
      }
    }
    if (t === 'file_change' && phase === 'completed') {
      const files = (item.changes || []).map((c) => `${c.kind || 'değişti'} ${c.path}`).join('\n');
      return { lvl: 'tool', text: `Dosyalar · ${files || 'güncellendi'}` };
    }
    if (t === 'todo_list' && phase !== 'started') {
      return { lvl: 'tool', text: (item.items || []).map((i) => `${i.completed ? '✓' : '○'} ${i.text}`).join('\n') };
    }
    if (t === 'web_search' && phase === 'completed') return { lvl: 'tool', text: `Web araması · ${item.query}` };
    if (t === 'mcp_tool_call' && phase === 'started') return { lvl: 'tool', text: `MCP · ${item.server}.${item.tool}` };
    if (t === 'error') return { lvl: 'warn', text: item.message };
    return null;
  };
  return {
    state,
    onLine(line) {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return line.trim() ? [{ lvl: 'dim', text: line }] : [];
      }
      const out = [];
      switch (ev.type) {
        case 'thread.started':
          state.sessionId = ev.thread_id;
          out.push({ lvl: 'info', text: 'Codex oturumu başladı' });
          break;
        case 'item.started':
        case 'item.updated':
        case 'item.completed': {
          const l = ev.item && itemLog(ev.item, ev.type.split('.')[1]);
          if (l) out.push(l);
          break;
        }
        case 'turn.completed':
          state.gotResult = true;
          state.tokens = (ev.usage?.input_tokens || 0) + (ev.usage?.output_tokens || 0);
          out.push({ lvl: 'ok', text: `Ajan bitirdi${state.tokens ? ` · ${state.tokens.toLocaleString('tr-TR')} token` : ''}` });
          break;
        case 'turn.failed':
          state.gotResult = true;
          state.isError = true;
          state.errorText = ev.error?.message || 'Codex turu başarısız';
          out.push({ lvl: 'error', text: state.errorText });
          break;
        case 'error':
          state.errorText = ev.message || 'Codex hatası';
          out.push({ lvl: 'error', text: state.errorText });
          break;
        default:
          // Eski Codex sürümlerinin {"msg": {...}} biçimi.
          if (ev.msg?.type === 'agent_message') {
            state.text = ev.msg.message || state.text;
            out.push({ lvl: 'text', text: ev.msg.message });
          } else if (ev.msg?.type === 'exec_command_begin') {
            out.push({ lvl: 'tool', text: `Komut · ${[].concat(ev.msg.command).join(' ')}` });
          } else if (ev.msg?.type === 'error') {
            state.errorText = ev.msg.message;
            out.push({ lvl: 'error', text: ev.msg.message });
          } else if (ev.msg?.type === 'task_complete') {
            state.gotResult = true;
            state.text = ev.msg.last_agent_message || state.text;
          }
      }
      return out;
    },
  };
}

// Varsayılan Claude modeli (kullanıcı Ayarlar'da başka bir model yazmadıysa).
const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';

const ADAPTERS = {
  claude: {
    id: 'claude',
    defaultModel: DEFAULT_CLAUDE_MODEL,
    label: 'Claude Code',
    bin: 'claude',
    install: 'npm install -g @anthropic-ai/claude-code',
    login: '"Giriş yap" terminalde giriş akışını açar (abonelik ya da Anthropic Console).',
    supportsResume: true,
    buildArgs({ settings, resumeId, mode = 'code', schema }) {
      const a = ['-p', '--output-format', 'stream-json', '--verbose'];
      // Model boş bırakılırsa Opus 5.5 (planlama, kodlama ve incelemelerin hepsi için).
      a.push('--model', String(settings.claudeModel || '').trim() || DEFAULT_CLAUDE_MODEL);
      if (settings.claudeEffort) a.push('--effort', settings.claudeEffort);
      // Bilgisayardaki kişisel MCP bağlantıları (deploy, tasarım araçları…) otonom ajanlara açılmaz.
      if (!settings.claudeAllowMcp) a.push('--strict-mcp-config');
      if (mode === 'review') {
        // Salt-okunur oturum da devam ettirilebilir (ör. plan revizyonu: önceki araştırma kaybolmaz).
        if (resumeId) a.push('--resume', resumeId);
        a.push('--tools', REVIEW_TOOLS, '--allowedTools', ...REVIEW_ALLOWED);
        if (schema) a.push('--json-schema', JSON.stringify(schema));
        return a;
      }
      if (resumeId) a.push('--resume', resumeId);
      if (settings.claudePermission === 'safe') a.push('--permission-mode', 'acceptEdits', '--allowedTools', ...CLAUDE_SAFE_TOOLS);
      else a.push('--dangerously-skip-permissions');
      return a;
    },
    createParser: claudeParser,
  },
  codex: {
    id: 'codex',
    label: 'OpenAI Codex',
    bin: 'codex',
    install: 'npm install -g @openai/codex',
    login: 'Terminalde `codex login` çalıştırın.',
    supportsResume: false,
    buildArgs({ settings, lastMessageFile, mode = 'code' }) {
      const a = ['exec', '--json', '--skip-git-repo-check'];
      if (settings.codexModel) a.push('--model', settings.codexModel);
      if (mode === 'review') a.push('--sandbox', 'read-only');
      else if (settings.codexPermission === 'safe') a.push('--full-auto', '-c', 'sandbox_workspace_write.network_access=true');
      else a.push('--dangerously-bypass-approvals-and-sandbox');
      if (lastMessageFile) a.push('--output-last-message', lastMessageFile);
      a.push('-'); // istem stdin'den okunur
      return a;
    },
    createParser: codexParser,
  },
};

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

// Oturum durumu: true / false / null (bilinmiyor). Ajan işe başlamadan kullanıcı uyarılsın diye.
function authStatus(id, bin) {
  const args = id === 'claude' ? ['auth', 'status'] : ['login', 'status'];
  try {
    const r = crossSpawn.sync(bin, args, { encoding: 'utf8', timeout: 15000, env: agentEnv(), windowsHide: true });
    const text = `${r.stdout || ''}\n${r.stderr || ''}`;
    if (id === 'claude') {
      const m = text.match(/"loggedIn"\s*:\s*(true|false)/);
      if (m) return m[1] === 'true';
    } else {
      if (/not logged in/i.test(text)) return false;
      if (/logged in/i.test(text)) return true;
    }
    return r.status === 0 ? null : null;
  } catch {
    return null;
  }
}

// `claude auth status` bazı giriş türlerinde (ör. Console / API Usage Billing ya da süresi
// dolmuş ama yenilenebilir jeton) yanlış "giriş yok" diyebiliyor. Olumsuz sonucu gerçek bir
// mini istekle doğrularız; sonuç 10 dk önbellekte tutulur.
const liveCheckCache = new Map();

function liveCheck(bin) {
  return new Promise((resolve) => {
    const child = crossSpawn(bin, ['-p', '--output-format', 'json', '--model', 'haiku', '--no-session-persistence'], {
      cwd: os.tmpdir(),
      env: agentEnv(),
      windowsHide: true,
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill(), 90000);
    child.stdout?.on('data', (d) => (out += d));
    child.stderr?.on('data', (d) => (err += d));
    child.on('error', () => resolve({ ok: false, error: 'başlatılamadı' }));
    child.on('close', () => {
      clearTimeout(timer);
      let r = null;
      try {
        r = JSON.parse(out.trim().split('\n').pop());
      } catch {
        /* JSON değil */
      }
      const text = r?.result || err || out;
      if (r && !r.is_error) return resolve({ ok: true });
      // Kimlik doğrulama dışı bir hata (ör. model erişimi) girişin çalıştığını gösterir.
      resolve({ ok: !AUTH_ERROR.test(text), error: clip(String(text).trim(), 300) });
    });
    child.stdin?.end('Reply with exactly: OK');
  });
}

async function detect(settings, { force = false } = {}) {
  const out = {};
  for (const id of Object.keys(ADAPTERS)) {
    const a = ADAPTERS[id];
    const bin = resolveBin(id, settings);
    let loggedIn = bin ? authStatus(id, bin) : null;
    let authError = null;
    if (bin && id === 'claude' && loggedIn !== true) {
      // Yalnızca başarılı sonuç önbelleğe alınır; kullanıcı giriş yapınca hemen görülsün.
      const cached = liveCheckCache.get(bin);
      const fresh = cached && Date.now() - cached.at < 10 * 60000 && !force;
      const r = fresh ? cached.r : await liveCheck(bin);
      if (r.ok) liveCheckCache.set(bin, { at: Date.now(), r });
      else liveCheckCache.delete(bin);
      loggedIn = r.ok;
      authError = r.ok ? null : r.error;
    }
    const version = bin ? versionOf(bin) : null;
    const latest = bin ? await latestVersion(id, bin) : null;
    const current = semver(version);
    out[id] = {
      id,
      label: a.label,
      found: !!bin,
      path: bin,
      version,
      installedVia: bin ? installKind(bin).label : '',
      latest,
      updateAvailable: !!(current && latest && cmpVersion(latest, current) > 0),
      canUpdate: !!(bin && updateCommand(id, bin)),
      loggedIn,
      authError,
      install: a.install,
      login: a.login,
      loginCommand: id === 'claude' ? 'claude auth login' : 'codex login',
    };
  }
  return out;
}

/**
 * Bir ajanı çalıştırır, logları akıtır. Dönen: { ok, text, sessionId, costUsd, error, fatal }
 */
// Metnin sonundaki JSON'u (```json bloğu ya da çıplak nesne) ayrıştırır — yapılandırılmış çıktı yoksa yedek.
function jsonFromText(text) {
  const t = String(text || '');
  const blocks = [...t.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  for (const b of blocks.reverse()) {
    try {
      return JSON.parse(b);
    } catch {
      /* sonraki */
    }
  }
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch {
      /* JSON yok */
    }
  }
  return null;
}

async function runAgent({ agentId, settings, cwd, prompt, resumeId, onLog, signal, mode = 'code', schema }) {
  const adapter = ADAPTERS[agentId];
  const bin = resolveBin(agentId, settings);
  if (!bin) {
    return { ok: false, fatal: true, error: `${adapter.label} bulunamadı. Kurulum: ${adapter.install}` };
  }
  const lastMessageFile = agentId === 'codex' ? path.join(os.tmpdir(), `sonda-codex-${Date.now()}.txt`) : null;
  const args = adapter.buildArgs({ settings, resumeId: adapter.supportsResume ? resumeId : null, lastMessageFile, mode, schema });
  if (mode === 'review' && schema && agentId !== 'claude') {
    prompt = `${prompt}\n\nFinish your answer with a single \`\`\`json code block that matches this JSON schema:\n${JSON.stringify(schema)}`;
  }
  const parser = adapter.createParser();
  const stderrLines = [];

  const res = await runner.run({
    command: bin,
    args,
    cwd,
    env: agentEnv(),
    input: prompt,
    signal,
    timeoutMs: settings.agentTimeoutMin * 60 * 1000,
    onStdout: (line) => {
      for (const l of parser.onLine(line)) onLog(l);
    },
    onStderr: (line) => {
      if (!line.trim()) return;
      stderrLines.push(line);
      if (stderrLines.length > 200) stderrLines.shift();
      onLog({ lvl: 'dim', text: line });
    },
  });

  const st = parser.state;
  if (lastMessageFile) {
    try {
      st.text = fs.readFileSync(lastMessageFile, 'utf8').trim() || st.text;
      fs.unlinkSync(lastMessageFile);
    } catch {
      /* dosya oluşmadıysa akıştaki mesaj kullanılır */
    }
  }

  if (signal?.aborted) return { ok: false, aborted: true, error: 'Durduruldu', sessionId: st.sessionId };
  if (res.error) return { ok: false, fatal: true, error: `${adapter.label} başlatılamadı: ${res.error}` };
  if (res.timedOut) return { ok: false, error: `Ajan ${settings.agentTimeoutMin} dakikada bitiremedi (zaman aşımı).`, text: st.text, sessionId: st.sessionId };

  const errText = st.errorText || (res.code !== 0 ? stderrLines.slice(-15).join('\n') : '');
  const failed = st.isError || (res.code !== 0 && !st.gotResult);
  if (failed && LIMIT_ERROR.test(errText) && !AUTH_ERROR.test(errText)) {
    return { ok: false, limited: true, resetAt: parseResetAt(errText), error: clip(errText, 500), text: st.text, sessionId: st.sessionId, costUsd: st.costUsd };
  }
  if (failed) {
    const fatal = AUTH_ERROR.test(errText);
    const hint = fatal ? `\n${adapter.label} oturumu yok veya süresi dolmuş. ${adapter.login}` : '';
    return { ok: false, fatal, error: `${clip(errText || `çıkış kodu ${res.code}`, 1500)}${hint}`, text: st.text, sessionId: st.sessionId, costUsd: st.costUsd };
  }
  let structured = null;
  let transcript = '';
  if (mode === 'review') {
    // Öncelik: araç çağrısı / sonuç alanı → son mesaj → önceki tüm mesajlar (sondan başa).
    structured = st.structured || jsonFromText(st.text);
    for (let i = st.texts.length - 1; !structured && i >= 0; i--) structured = jsonFromText(st.texts[i]);
    transcript = st.texts.join('\n\n').slice(-60000);
  }
  return { ok: true, text: st.text, structured, transcript, sessionId: st.sessionId, costUsd: st.costUsd || 0 };
}

// "Bağlantıyı test et" sonucunu durum önbelleğine yansıtır.
function rememberLiveCheck(agentId, settings, ok) {
  const bin = resolveBin(agentId, settings);
  if (!bin) return;
  if (ok) liveCheckCache.set(bin, { at: Date.now(), r: { ok: true } });
  else liveCheckCache.delete(bin);
}

module.exports = { ADAPTERS, DEFAULT_CLAUDE_MODEL, detect, runAgent, resolveBin, update, installKind, cmpVersion, parseResetAt, rememberLiveCheck, jsonFromText, REVIEW_ALLOWED };
