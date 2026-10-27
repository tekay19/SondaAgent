// Claude CLI "yönetici" istemcisi: Claude API ve yerel model istemcileriyle aynı sözleşmeyi taşır (`generate` metin ya da
// ayrıştırılmış nesne döner) ama isteği Claude Code CLI'si üzerinden, kullanıcının aboneliğiyle (Pro / Max) yapar;
// API anahtarı gerekmez ve kullanılmaz. Yönetici adımları (ürün tanımı, plan onayı, son kabul, rapor) böylece
// kodlayan ve inceleyen oturumlarla aynı hesaptan çalışır.
//
// Verimlilik: oturum araçsız (`--tools ""`), geçici bir klasörde (projenin CLAUDE.md'si, kullanıcının kişisel
// ayarları, eklentileri ve MCP bağlayıcıları yüklenmez) ve kalıcı değildir; istem yalnızca Sonda'nın verdiği
// metinden oluşur. Görüntü / PDF ekleri geçici dosyaya yazılır ve yalnızca o oturumda `Read` aracı açılır.
const fs = require('fs');
const os = require('os');
const path = require('path');
const core = require('./llmcore');
const runner = require('./runner');
const { resolveBin } = require('./agents/install');
const { agentRunEnv, conforms, cliRunError, cliFailure } = require('./agents/run');
const { claudeModelOf } = require('./models');

// Yönetici işleri için düşünme derinliği (Claude API istemcisiyle aynı varsayılan).
const DEFAULT_EFFORT = 'medium';
// Bir yönetici çağrısı için üst sınır: büyük bir şartname + plan 30 dakikayı aşmaz; aşarsa kopmuş bir oturumdur.
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
// Claude CLI ilk olayı saniyeler içinde yazar; bu süre geçtiyse oturum takılmıştır.
const FIRST_OUTPUT_MS = 3 * 60 * 1000;
// Ekli dosyaları okuyan oturum için adım sınırı (ek başına bir okuma + yanıt).
const MAX_TURNS_WITH_FILES = 24;

class ClaudeCliError extends core.ApiError {}

const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'application/pdf': '.pdf' };

/**
 * İstem parçalarını ([{ text }], [{ inlineData }]) istem metnine ve ek dosyalarına ayırır. Metinler sırayla
 * birleşir; ekler `dir` altına yazılır ve metinde yerleri belirtilir (model `Read` ile okur). Desteklenmeyen ya da boş
 * ek yerine kısa bir not konur ki yönetici eksikliği bilsin.
 */
function materialize(parts, dir) {
  const text = [];
  const files = [];
  for (const p of parts || []) {
    if (typeof p?.text === 'string') {
      if (p.text.trim()) text.push(p.text);
      continue;
    }
    const data = p?.inlineData?.data;
    if (!data) continue;
    const mime = p.inlineData.mimeType || 'image/jpeg';
    const ext = EXT[mime];
    if (!ext) {
      text.push(`[An attachment of type ${mime} was omitted: only images and PDF can be attached.]`);
      continue;
    }
    const file = path.join(dir, `ek-${files.length + 1}${ext}`);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    files.push(file);
    text.push(`[Attachment ${files.length}: ${file}]`);
  }
  return { text: text.join('\n'), files };
}

/**
 * Claude CLI'ye istek atar. `schema` (standart JSON Schema, üst düzey nesne) verilirse ayrıştırılmış nesne döner;
 * verilmezse metin. parts: [{ text }] veya [{ inlineData: { mimeType, data } }] (tüm yönetici istemcilerinde aynı biçim).
 * `settings`: CLI yolu (claudePath) ve varsayılan model için. onUsage({ totalTokenCount, inputTokens, outputTokens }).
 * Hatalar işaretlidir: `limited` + `resetAt` (kullanım limiti), `network` (bağlantı), `auth` (oturum yok).
 */
async function generate({ settings = {}, model, system, parts, schema, effort = DEFAULT_EFFORT, signal, onUsage, onProgress, timeoutMs = DEFAULT_TIMEOUT_MS, retryDelays }) {
  const bin = resolveBin('claude', settings);
  if (!bin) throw new ClaudeCliError('Claude Code bulunamadı. Ayarlar → Bağlantılar\'dan "Claude\'u kur ve bağla" ile bağlayın.');
  const id = String(model || '').trim() || claudeModelOf(settings);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonda-yonetici-'));
  try {
    const { text, files } = materialize(parts, dir);
    if (!text.trim()) throw new ClaudeCliError('Claude isteği boş: gönderilecek metin ya da görüntü yok.', 0);
    // --setting-sources "": kullanıcının kişisel CLAUDE.md'si, hafızası, eklentileri ve hook'ları yüklenmez (ölçüldü:
    // yalnızca bu, her yönetici çağrısının girdisinden binlerce token düşürür ve kişisel talimatların işe karışmasını önler).
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', id, '--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands', '--setting-sources', ''];
    if (effort) args.push('--effort', effort);
    // Sistem istemi dosyadan: Windows komut satırı sınırı (32K) uzun istemlere yetmez.
    let sys = system || '';
    if (schema) sys += `${sys ? '\n\n' : ''}Your final answer must be the structured output that matches the given JSON schema; do not answer in plain text.`;
    if (sys) {
      const sysFile = path.join(dir, 'system.txt');
      fs.writeFileSync(sysFile, sys, 'utf8');
      args.push('--system-prompt-file', sysFile);
    }
    if (files.length) {
      args.push('--tools', 'Read', '--allowedTools', 'Read', '--max-turns', String(MAX_TURNS_WITH_FILES));
    } else args.push('--tools', '');
    if (schema) args.push('--json-schema', JSON.stringify(schema));
    const prompt = files.length ? `${text}\n\nRead each attachment above with the Read tool before answering.` : text;

    return await core.withRetries(
      async () => {
        const st = { texts: [], result: null, structured: null, isError: false, errorText: '', usage: null, cost: 0, gotResult: false, chars: 0 };
        const stderr = [];
        let lastReport = 0;
        const r = await runner.run({
          command: bin,
          args,
          cwd: dir,
          env: agentRunEnv('claude', settings, 'review'),
          input: prompt,
          signal,
          timeoutMs,
          firstOutputMs: FIRST_OUTPUT_MS,
          tailSize: 20000,
          onStdout: (line) => {
            let ev;
            try {
              ev = JSON.parse(line);
            } catch {
              return;
            }
            if (ev.type === 'assistant') {
              for (const c of ev.message?.content || []) {
                if (c.type === 'text' && c.text?.trim()) st.texts.push(c.text);
                else if (c.type === 'tool_use' && c.name === 'StructuredOutput' && c.input && typeof c.input === 'object') st.structured = c.input;
              }
              st.chars = st.texts.reduce((n, t) => n + t.length, 0);
              if (onProgress && st.chars - lastReport > 4000) {
                lastReport = st.chars;
                onProgress(st.chars);
              }
            } else if (ev.type === 'result') {
              st.gotResult = true;
              st.isError = !!ev.is_error || (ev.subtype && ev.subtype !== 'success');
              st.result = typeof ev.result === 'string' ? ev.result : '';
              if (ev.structured_output && typeof ev.structured_output === 'object') st.structured = ev.structured_output;
              st.usage = ev.usage || null;
              st.cost = ev.total_cost_usd || 0;
              if (st.isError) st.errorText = st.result || ev.subtype || '';
            }
          },
          onStderr: (line) => {
            if (!line.trim()) return;
            stderr.push(line);
            if (stderr.length > 100) stderr.shift();
          },
        });
        if (signal?.aborted) throw new Error('İptal edildi');
        const runErr = cliRunError(ClaudeCliError, 'Claude CLI', r, { firstOutputMs: FIRST_OUTPUT_MS, timeoutMs });
        if (runErr) throw runErr;
        const u = st.usage || {};
        const inTok = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
        const outTok = u.output_tokens || 0;
        if (st.usage) onUsage?.({ totalTokenCount: inTok + outTok, inputTokens: inTok, outputTokens: outTok, costUsd: st.cost });
        const errText = st.errorText || (r.code !== 0 ? stderr.slice(-15).join('\n') : '');
        if (st.isError || (r.code !== 0 && !st.gotResult)) throw cliFailure(ClaudeCliError, 'Claude CLI', errText, r.code, { loginHint: 'Ayarlar → Bağlantılar\'dan giriş yapın.' });
        if (!st.gotResult) throw new ClaudeCliError('Claude CLI sonuç olayı göndermeden kapandı (yarım yanıt)', 0, { truncated: true });
        const textOut = st.result || st.texts.join('\n\n');
        if (!schema) {
          if (!textOut.trim()) throw new ClaudeCliError('Claude yanıt üretmedi', 0);
          return textOut;
        }
        // Yapılandırılmış sonuç: CLI'nin verdiği nesne; yoksa metindeki JSON (şemaya uyuyorsa).
        if (st.structured && conforms(st.structured, schema)) return st.structured;
        for (const t of [st.result, ...st.texts.slice().reverse()]) {
          if (!t) continue;
          try {
            const v = core.parseJson(t, 'Claude');
            if (conforms(v, schema)) return v;
          } catch {
            /* sonraki */
          }
        }
        throw new SyntaxError('Claude şemaya uyan bir sonuç vermedi');
      },
      // Yalnızca yarım yanıt ve bozuk JSON yeniden denenir (iki kez); limit, oturum ve bağlantı hataları çağırana gider.
      { signal, delays: retryDelays || [3000, 10000] }
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
}

module.exports = { ClaudeCliError, generate, materialize, isNetworkError: (e) => e?.network === true, DEFAULT_EFFORT };
