// Ajan adaptörleri: araç izinleri, çıktı ayrıştırıcıları (stream-json → günlük) ve komut satırı.
const { IS_WIN } = require('../env');
const { DEFAULT_CLAUDE_MODEL, claudeModelOf } = require('../models');

const clip = (s, n) => {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + '…' : s;
};

const LIMIT_ERROR = /usage limit|limit reached|hit your (usage )?limit|limit will reset|rate.?limit(ed)?|too many requests|quota exceeded|overloaded/i;

// Bağlantı sorunu (internet / DNS yok, API'ye ulaşılamıyor, geçici 5xx): ajanın ya da kodun hatası değildir;
// oturum başarısız sayılmaz, bağlantı gelince aynı oturumdan devam edilir.
const NETWORK_ERROR = /can.t reach the api|check your internet|connection error|request timed out|ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENETDOWN|socket hang up|fetch failed|network (error|is unreachable|unavailable)|dns error|error sending request|stream (error|disconnected)|API Error:? (500|502|503|504)\b|internal server error|bad gateway|service unavailable|gateway time-?out/i;

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
  // `find` yok: -delete / -exec ile dosya silebilir; dosya aramak için Glob ve Grep araçları var.
  // `cat` / `head` / `tail` / `grep` / `rg` yok: dosya okumak ve aramak için Read ve Grep araçları var; kabuk komutları
  // .env okuma yasağını (Read kuralları) atlatırdı.
  'Bash(ls:*)', 'Bash(wc:*)', 'Bash(tree:*)', 'Bash(pwd)',
  'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git status:*)', 'Bash(git ls-files:*)',
  'Bash(npm view:*)', 'Bash(npm ls:*)', 'Bash(node --version)', 'Bash(npm --version)', 'Bash(node -v)', 'Bash(npm -v)', 'Bash(pnpm -v)', 'Bash(git --version)',
  // test:unit / test:integration ayrı yazılır: önek eşleşmesi kelime sınırında yapılır ("run test" ≠ "run test:integration").
  ...['npm', 'pnpm', 'yarn', 'bun'].flatMap((pm) => ['test', 'run test', 'run test:unit', 'run test:integration', 'run lint', 'run typecheck', 'run type-check', 'run check-types', 'run build', 'lint', 'typecheck'].map((c) => `Bash(${pm} ${c}:*)`)),
  'Bash(npm test)', 'Bash(pnpm test)', 'Bash(yarn test)',
  ...['npx', 'pnpm exec', 'yarn'].flatMap((x) => ['vitest', 'jest', 'tsc', 'eslint'].map((t) => `Bash(${x} ${t}:*)`)),
  'Bash(npx playwright test:*)', 'Bash(npx prisma validate:*)',
  // Node dışı projeler: inceleyici testleri ve statik denetimleri kendi çalıştırabilsin.
  'Bash(pytest:*)', 'Bash(python -m pytest:*)', 'Bash(python3 -m pytest:*)', 'Bash(ruff check:*)', 'Bash(mypy:*)',
  'Bash(go test:*)', 'Bash(go vet:*)', 'Bash(go build:*)', 'Bash(cargo test:*)', 'Bash(cargo check:*)', 'Bash(cargo clippy:*)',
  // uv / poetry / sanal ortamla çalışan Python projeleri (kök dizinden, yalın biçimde).
  ...['uv run', 'poetry run', '.venv/bin/python -m'].flatMap((x) => (x.endsWith('-m') ? ['pytest', 'mypy', 'ruff check'] : ['pytest', 'python -m pytest', 'ruff check', 'mypy']).map((t) => `Bash(${x} ${t}:*)`)),
  'Bash(.venv/bin/pytest:*)', 'Bash(.venv/bin/ruff check:*)', 'Bash(.venv/bin/mypy:*)',
  // Araç zinciri yoklamaları (yalnızca sürüm / durum sorar): plan ve inceleme bu makinede gerçekten bulunan araçlara dayansın.
  ...['python', 'python3', 'pip', 'pip3', 'uv', 'poetry', 'docker', 'cargo', 'rustc', 'dotnet', 'php', 'composer', 'ruby', 'bun', 'yarn', 'pnpm', 'deno'].map((t) => `Bash(${t} --version)`),
  'Bash(docker compose version)', 'Bash(docker info)', 'Bash(go version)', 'Bash(java -version)', 'Bash(java --version)',
  // PyPI'deki güncel sürümler (npm view'un karşılığı; hiçbir şey kurmaz).
  ...['pip', 'pip3', 'python -m pip', 'python3 -m pip'].map((p) => `Bash(${p} index versions:*)`),
];

// Kullanıcının gerçek değerlerini taşıyan .env dosyaları ajan oturumlarına okutulmaz: Read aracı (Grep / Glob da bu
// kurala uyar) ve dosyayı doğrudan okuyan yaygın kabuk komutları reddedilir (örnek dosyası .env.example okunabilir).
// Kabuk kuralları önek eşleşmesidir: `cat .env` ve `cat .env.local` yakalanır; dolaylı okumayı (betik, `grep -r`)
// tam olarak engellemez — asıl koruma, değerlerin istemlere hiç girmemesi ve loglarda maskelenmesidir.
// Uygulama ve araçlar dosyayı çalışma anında kendileri okumaya devam eder.
const ENV_FILES = ['.env', '.env.local', '.env.*.local'];
const ENV_READERS = ['cat', 'head', 'tail', 'less', 'more', 'bat', 'sed', 'awk', 'grep', 'rg', 'strings', 'xxd', 'od', 'base64', 'cp', 'source'];
const ENV_DENY = [
  ...ENV_FILES.flatMap((f) => [`Read(${f})`, `Read(**/${f})`]),
  ...ENV_READERS.flatMap((c) => ['.env', './.env'].map((f) => `Bash(${c} ${f}:*)`)),
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

// ---------- OpenCode ----------
// `opencode run --format json`: her satır bir olay ({ type, sessionID, part }). text → metin, tool → araç çağrısı,
// step_finish → adım bitti (token / maliyet), error → hata. İstem stdin'den okunur.
function opencodeParser() {
  const state = { sessionId: null, text: '', texts: [], structured: null, isError: false, costUsd: 0, gotResult: false, errorText: '', tokens: 0 };
  return {
    state,
    onLine(line) {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return line.trim() ? [{ lvl: 'dim', text: line }] : [];
      }
      if (ev.sessionID) state.sessionId = ev.sessionID;
      const p = ev.part || {};
      const out = [];
      switch (ev.type) {
        case 'step_start':
          if (!state.gotResult && !state.texts.length) out.push({ lvl: 'info', text: 'OpenCode oturumu başladı' });
          break;
        case 'text':
          if (p.text?.trim()) {
            state.text = p.text;
            state.texts.push(p.text);
            out.push({ lvl: 'text', text: p.text.trim() });
          }
          break;
        case 'tool_use':
        case 'tool': {
          const name = p.tool || p.name || 'araç';
          const st = p.state || {};
          out.push({ lvl: 'tool', text: `${name} · ${summarizeToolInput(name, st.input || p.input || {})}` });
          if (st.status === 'error') out.push({ lvl: 'warn', text: clip(String(st.error || st.output || 'araç hatası').trim(), 600) });
          else if (typeof st.output === 'string' && st.output.trim()) out.push({ lvl: 'dim', text: clip(st.output.trim(), 280) });
          break;
        }
        case 'step_finish':
          state.gotResult = true;
          state.tokens += p.tokens?.total || 0;
          state.costUsd += p.cost || 0;
          if (p.reason === 'stop' || p.reason === 'length' || p.reason === 'error') {
            out.push({ lvl: p.reason === 'stop' ? 'ok' : 'warn', text: `${p.reason === 'stop' ? 'Ajan bitirdi' : `Ajan durdu (${p.reason})`}${state.tokens ? ` · ${state.tokens.toLocaleString('tr-TR')} token` : ''}${state.costUsd ? ` · $${state.costUsd.toFixed(2)}` : ''}` });
          }
          break;
        case 'error':
          state.isError = true;
          state.errorText = ev.error?.data?.message || ev.error?.message || ev.error?.name || 'OpenCode hatası';
          out.push({ lvl: 'error', text: state.errorText });
          break;
        default:
          break;
      }
      return out;
    },
  };
}

// Kodlayan ajanın araçları: yalnızca kodlama araçları. Alt ajan başlatma, kendine uyandırma kurma,
// yayın yapma (Artifact), telefona bildirim, başka oturumlara mesaj gibi araçlar otonom hat içinde kapalı:
// hem zaman kaybettirir (ör. alt ajan incelemesini 20 dk beklemek) hem de dışarıya etki eder.
const CODE_TOOLS = 'Bash,Read,Edit,Write,Glob,Grep,NotebookEdit,WebFetch,WebSearch,TodoWrite';

const ADAPTERS = {
  claude: {
    id: 'claude',
    defaultModel: DEFAULT_CLAUDE_MODEL,
    label: 'Claude Code',
    bin: 'claude',
    install: IS_WIN ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash',
    login: '"Giriş yap" tarayıcıda Claude hesabınla (Pro / Max aboneliği) giriş sayfasını açar.',
    supportsResume: true,
    buildArgs({ settings, resumeId, mode = 'code', schema, protectEnv = false }) {
      const a = ['-p', '--output-format', 'stream-json', '--verbose'];
      // Model seçilmediyse Opus 5.5 (planlama, kodlama ve incelemelerin hepsi için).
      a.push('--model', claudeModelOf(settings));
      // Verimlilik ve yalıtım: kullanıcının kişisel Claude Code ayarları (~/.claude CLAUDE.md, hafıza, eklentiler,
      // hook'lar) ajan oturumlarına yüklenmez; yalnızca projenin kendi ayar ve CLAUDE.md'si girer. Kişisel
      // talimatlar her oturuma binlerce token ekliyor ve otonom işe karışabiliyordu. Ayarlar'dan açılabilir.
      if (!settings.claudeUserSettings) a.push('--setting-sources', 'project');
      if (settings.claudeEffort) a.push('--effort', settings.claudeEffort);
      // Bilgisayardaki kişisel MCP bağlantıları (deploy, tasarım araçları…) otonom ajanlara açılmaz. Salt okunur
      // oturumlar (brif, inceleme, uzman, doğrulama, hafıza) bu araçları hiç kullanamaz; ayar açık olsa bile yüklenmez:
      // claude.ai bağlayıcılarının araç tanımları her oturumun bağlamına yüz binlerce token ekliyordu.
      if (!settings.claudeAllowMcp || mode === 'review') a.push('--strict-mcp-config');
      if (mode === 'review') {
        // Salt-okunur oturum da devam ettirilebilir (ör. plan revizyonu: önceki araştırma kaybolmaz).
        if (resumeId) a.push('--resume', resumeId);
        a.push('--tools', REVIEW_TOOLS, '--allowedTools', ...REVIEW_ALLOWED, '--disallowedTools', ...ENV_DENY);
        if (schema) a.push('--json-schema', JSON.stringify(schema));
        return a;
      }
      if (resumeId) a.push('--resume', resumeId);
      a.push('--tools', CODE_TOOLS);
      if (settings.claudePermission === 'safe') a.push('--permission-mode', 'acceptEdits', '--allowedTools', ...CLAUDE_SAFE_TOOLS);
      else a.push('--dangerously-skip-permissions');
      // Kullanıcı bu projeye gerçek anahtar girdiyse kodlayan ajan da .env'yi okuyamaz (yalnızca adları bilir).
      if (protectEnv) a.push('--disallowedTools', ...ENV_DENY);
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
      // Sağlayıcı: yerel model (codex --oss: Ollama / LM Studio, OpenAI hesabı gerekmez) ya da NVIDIA NIM (OpenAI uyumlu
      // sohbet API'si; sağlayıcı -c ile tanımlanır, anahtar NVIDIA_API_KEY olarak yalnızca bu oturumun ortamına girer).
      // Model adı codexModel'den gelir (yerelde ör. "qwen3-coder:30b", NIM'de yönetici için seçilen model yedektir).
      const provider = settings.codexProvider || 'openai';
      if (provider === 'local') a.push('--oss', '--local-provider', settings.codexLocalProvider === 'lmstudio' ? 'lmstudio' : 'ollama');
      else if (provider === 'nim') {
        a.push('-c', 'model_provider=nim', '-c', 'model_providers.nim.name="NVIDIA NIM"', '-c', `model_providers.nim.base_url="${String(settings.nimBaseUrl || 'https://integrate.api.nvidia.com/v1').replace(/"/g, '')}"`, '-c', 'model_providers.nim.env_key="NVIDIA_API_KEY"', '-c', 'model_providers.nim.wire_api="chat"');
      }
      const model = settings.codexModel || (provider === 'nim' ? settings.nimModel : '');
      if (model) a.push('--model', model);
      if (mode === 'review') a.push('--sandbox', 'read-only');
      else if (settings.codexPermission === 'safe') a.push('--full-auto', '-c', 'sandbox_workspace_write.network_access=true');
      else a.push('--dangerously-bypass-approvals-and-sandbox');
      if (lastMessageFile) a.push('--output-last-message', lastMessageFile);
      a.push('-'); // istem stdin'den okunur
      return a;
    },
    createParser: codexParser,
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    bin: 'opencode',
    // Masaüstü uygulamasının paketlediği CLI de tanınır (PATH'te opencode-cli ya da Windows'ta bilinen yolu, bkz. install.js);
    // sürümü yeni olan seçilir.
    altBins: ['opencode-cli'],
    install: 'npm install -g opencode-ai',
    login: 'Terminalde `opencode auth login` ile bir sağlayıcı (NVIDIA, OpenAI, Anthropic, OpenRouter…) anahtarı girin.',
    supportsResume: true,
    buildArgs({ settings, resumeId, mode = 'code' }) {
      const a = ['run', '--format', 'json'];
      // Model "sağlayıcı/model" biçimindedir (ör. nvidia/deepseek-ai/deepseek-v4-pro, opencode/big-pickle). Salt okunur
      // oturumlar ayrı bir model kullanabilir; boşsa OpenCode'un kendi varsayılanı.
      const model = mode === 'review' ? settings.opencodeReviewModel || settings.opencodeModel : settings.opencodeModel;
      if (model) a.push('-m', model);
      if (resumeId) a.push('-s', resumeId);
      // plan: OpenCode'un yerleşik salt okunur ajanı (dosya yazma ve düzenleme reddedilir). Yazma oturumunda izinler
      // sorulmadan onaylanır (--auto); aksi halde etkileşimsiz çalışma takılırdı.
      if (mode === 'review') a.push('--agent', 'plan');
      else a.push('--auto');
      return a;
    },
    createParser: opencodeParser,
  },
};

module.exports = { clip, LIMIT_ERROR, NETWORK_ERROR, parseResetAt, AUTH_ERROR, REVIEW_ALLOWED, ENV_DENY, CODE_TOOLS, ADAPTERS };
