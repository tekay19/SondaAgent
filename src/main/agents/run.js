// Ajan oturumu: ortam, çalıştırma, yapılandırılmış çıktı ve şemaya uygunluk.
const fs = require('fs');
const os = require('os');
const path = require('path');
const runner = require('../runner');
const { agentEnv } = require('../env');
const { clip, LIMIT_ERROR, NETWORK_ERROR, parseResetAt, AUTH_ERROR, ADAPTERS } = require('./adapters');
const { resolveBin } = require('./install');

// Ajan oturumunun ortamı. Kullanıcı MCP erişimini açmadıysa Claude hesabındaki bağlayıcılar (claude.ai connectors:
// Vercel, Shopify, Slack…) da kapatılır: --strict-mcp-config yerel yapılandırmayı keser, bu değişken hesap
// bağlayıcılarını. Otonom bir ajan, tam yetkiyle çalışırken gerçek dünyada işlem yapabilecek araçlara erişmemeli.
// Claude hesabındaki bağlayıcılar (claude.ai MCP) yalnızca kullanıcı açtıysa ve yalnızca kodlama oturumunda yüklenir.
// Codex API anahtarıyla giriş yapılmış olabilir (ortam değişkeni): bu anahtarlar yalnızca Codex oturumuna gider.
const CODEX_AUTH_VARS = ['OPENAI_API_KEY', 'CODEX_API_KEY'];
function agentRunEnv(agentId, settings = {}, mode = 'code') {
  if (agentId === 'codex') return agentEnv(Object.fromEntries(CODEX_AUTH_VARS.filter((k) => process.env[k]).map((k) => [k, process.env[k]])));
  return agentEnv(agentId === 'claude' && (!settings.claudeAllowMcp || mode === 'review') ? { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' } : {});
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

// Metinden bulunan JSON gerçekten beklenen sonuç mu? (İnceleyicinin alıntıladığı bir package.json parçası
// ya da yapılandırma nesnesi "sonuç" sanılmasın.) Üst düzey zorunlu alanlar ve tipleri kontrol edilir.
function conforms(value, schema) {
  if (!schema || typeof schema !== 'object') return value != null && typeof value === 'object';
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const props = schema.properties || {};
  const typeOk = (v, t) => {
    const type = String(t || '').toLowerCase();
    if (type === 'array') return Array.isArray(v);
    if (type === 'object') return !!v && typeof v === 'object' && !Array.isArray(v);
    if (type === 'string') return typeof v === 'string';
    if (type === 'number' || type === 'integer') return typeof v === 'number';
    if (type === 'boolean') return typeof v === 'boolean';
    return true;
  };
  const required = schema.required || [];
  if (!required.length) return Object.keys(props).some((k) => k in value);
  return required.every((k) => k in value && typeOk(value[k], props[k]?.type));
}

// Başarısız oturumun türü: oturum (giriş) sorunu, kullanım limiti, bağlantı sorunu ya da sıradan hata.
function failureKind(errText) {
  if (AUTH_ERROR.test(errText)) return 'auth';
  if (LIMIT_ERROR.test(errText)) return 'limited';
  if (NETWORK_ERROR.test(errText)) return 'offline';
  return 'error';
}

async function runAgent({ agentId, settings, cwd, prompt, resumeId, onLog, signal, mode = 'code', schema, protectEnv = false }) {
  const adapter = ADAPTERS[agentId];
  const bin = resolveBin(agentId, settings);
  if (!bin) {
    return { ok: false, fatal: true, error: `${adapter.label} bulunamadı. Kurulum: ${adapter.install}` };
  }
  // Paralel işlerde çakışmasın diye dosya adı benzersizdir.
  const lastMessageFile = agentId === 'codex' ? path.join(os.tmpdir(), `sonda-codex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`) : null;
  const args = adapter.buildArgs({ settings, resumeId: adapter.supportsResume ? resumeId : null, lastMessageFile, mode, schema, protectEnv });
  if (mode === 'review' && schema && agentId !== 'claude') {
    prompt = `${prompt}\n\nFinish your answer with a single \`\`\`json code block that matches this JSON schema:\n${JSON.stringify(schema)}`;
  }
  const parser = adapter.createParser();
  const stderrLines = [];

  const res = await runner.run({
    command: bin,
    args,
    cwd,
    env: agentRunEnv(agentId, settings, mode),
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
  const kind = failed ? failureKind(errText) : null;
  if (kind === 'limited') {
    return { ok: false, limited: true, resetAt: parseResetAt(errText), error: clip(errText, 500), text: st.text, sessionId: st.sessionId, costUsd: st.costUsd };
  }
  // Bağlantı kesintisi: çağıran (orkestratör) bağlantıyı bekleyip aynı oturumdan devam eder.
  if (kind === 'offline') {
    return { ok: false, offline: true, error: clip(errText, 500), text: st.text, sessionId: st.sessionId, costUsd: st.costUsd };
  }
  if (failed) {
    const fatal = kind === 'auth';
    const hint = fatal ? `\n${adapter.label} oturumu yok veya süresi dolmuş. ${adapter.login}` : '';
    return { ok: false, fatal, error: `${clip(errText || `çıkış kodu ${res.code}`, 1500)}${hint}`, text: st.text, sessionId: st.sessionId, costUsd: st.costUsd };
  }
  let structured = null;
  let transcript = '';
  if (mode === 'review') {
    // Öncelik: araç çağrısı / sonuç alanı → son mesaj → önceki tüm mesajlar (sondan başa).
    // Metinden okunan JSON yalnızca şemaya uyuyorsa sonuç sayılır.
    const fromText = (t) => {
      const v = jsonFromText(t);
      return v && (!schema || conforms(v, schema)) ? v : null;
    };
    structured = st.structured || fromText(st.text);
    for (let i = st.texts.length - 1; !structured && i >= 0; i--) structured = fromText(st.texts[i]);
    transcript = st.texts.join('\n\n').slice(-60000);
  }
  return { ok: true, text: st.text, structured, transcript, sessionId: st.sessionId, costUsd: st.costUsd || 0 };
}

module.exports = { agentRunEnv, jsonFromText, conforms, failureKind, runAgent };
