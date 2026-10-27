// OpenCode "yönetici" istemcisi: Claude CLI / Claude API / yerel model istemcileriyle aynı sözleşmeyi taşır (`generate`
// metin ya da ayrıştırılmış nesne döner) ama isteği OpenCode CLI'si üzerinden, OpenCode'un kendi sağlayıcı anahtarlarıyla
// (`opencode auth login`: NVIDIA, OpenAI, OpenRouter… ya da ücretsiz opencode/* modelleri) yapar; Sonda anahtar tutmaz.
// Yönetici adımları (ürün tanımı, plan onayı, son kabul, rapor) böylece Claude hiç kurulu olmadan da çalışır.
//
// Oturum: OpenCode'un yerleşik salt okunur "plan" ajanı, geçici bir klasörde (projenin dosyaları ve AGENTS.md'si
// yüklenmez), Sonda'nın veri klasöründe (XDG_DATA_HOME; bkz. agents/run.js). Sistem istemi flag'i yoktur: istemin
// başına eklenir. Şemalı sonuç için CLI'de --json-schema benzeri bir seçenek yoktur: istem sonunda şemaya uyan tek bir
// ```json bloğu istenir, yanıt ayrıştırılıp şemaya uygunluğu denetlenir; uymayan yanıt yeniden denenir. Görüntü / PDF
// ekleri geçici dosyaya yazılıp `--file` ile mesaja eklenir.
const fs = require('fs');
const os = require('os');
const path = require('path');
const core = require('./llmcore');
const runner = require('./runner');
const { resolveBin } = require('./agents/install');
const { agentRunEnv, conforms, failureKind, jsonFromText } = require('./agents/run');
const { clip, parseResetAt, ADAPTERS } = require('./agents/adapters');
const { materialize } = require('./claudecli');

// Bir yönetici çağrısı için üst sınır: büyük bir şartname + plan 30 dakikayı aşmaz; aşarsa kopmuş bir oturumdur.
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
// OpenCode ilk olayı modelden ilk yanıt gelince yazar; bazı sağlayıcılar (NIM) dakikalarca sessiz kalabiliyor.
const FIRST_OUTPUT_MS = 5 * 60 * 1000;

class OpenCodeCliError extends core.ApiError {}

// Yöneticinin OpenCode modeli: ayarı boşsa kodlayıcı OpenCode modeli; o da boşsa OpenCode'un kendi varsayılanı ('').
const managerModelOf = (settings) => String(settings?.opencodeManagerModel || '').trim() || String(settings?.opencodeModel || '').trim();

/**
 * OpenCode'a istek atar. `schema` (standart JSON Schema, üst düzey nesne) verilirse ayrıştırılmış nesne döner;
 * verilmezse metin. parts: [{ text }] veya [{ inlineData: { mimeType, data } }] (tüm yönetici istemcilerinde aynı biçim).
 * `settings`: CLI yolu (opencodePath) ve varsayılan model için. onUsage({ totalTokenCount, costUsd }).
 * Hatalar işaretlidir: `limited` + `resetAt` (kullanım limiti), `network` (bağlantı), `auth` (sağlayıcı anahtarı yok).
 */
async function generate({ settings = {}, model, system, parts, schema, signal, onUsage, onProgress, timeoutMs = DEFAULT_TIMEOUT_MS, retryDelays }) {
  const bin = resolveBin('opencode', settings);
  if (!bin) throw new OpenCodeCliError(`OpenCode bulunamadı. Kurulum: ${ADAPTERS.opencode.install}`);
  const id = String(model || '').trim() || managerModelOf(settings);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonda-yonetici-'));
  try {
    const { text, files } = materialize(parts, dir);
    if (!text.trim()) throw new OpenCodeCliError('OpenCode isteği boş: gönderilecek metin ya da görüntü yok.', 0);
    // --print-logs: JSON hata olayı çoğu zaman geneldir ("Unexpected server error"); asıl neden (model yok, anahtar
    // geçersiz…) stderr günlüğündedir ve hata iletisine eklenir.
    const args = ['run', '--format', 'json', '--agent', 'plan', '--print-logs', '--log-level', 'ERROR'];
    if (id) args.push('-m', id);
    for (const f of files) args.push('--file', f);
    // Sistem istemi flag'i yok: istemin başına. Şema: metin sonunda tek bir ```json bloğu (kodlayan ajanların salt okunur
    // oturumlarındaki yöntemle aynı, bkz. agents/run.js).
    const head = system ? `${system}\n\n---\n\n` : '';
    let prompt = `${head}${text}`;
    if (files.length) prompt += '\n\nThe attachments above are included with this message; use them before answering.';
    if (schema) prompt += `\n\nFinish your answer with a single \`\`\`json code block that matches this JSON schema (no prose after it):\n${JSON.stringify(schema)}`;

    return await core.withRetries(
      async () => {
        const parser = ADAPTERS.opencode.createParser();
        const st = parser.state;
        const stderr = [];
        let lastReport = 0;
        const r = await runner.run({
          command: bin,
          args,
          cwd: dir,
          env: agentRunEnv('opencode', settings, 'review'),
          input: prompt,
          signal,
          timeoutMs,
          firstOutputMs: FIRST_OUTPUT_MS,
          tailSize: 20000,
          onStdout: (line) => {
            parser.onLine(line);
            const chars = st.texts.reduce((n, t) => n + t.length, 0);
            if (onProgress && chars - lastReport > 4000) {
              lastReport = chars;
              onProgress(chars);
            }
          },
          onStderr: (line) => {
            if (!line.trim()) return;
            stderr.push(line);
            if (stderr.length > 100) stderr.shift();
          },
        });
        if (signal?.aborted) throw new Error('İptal edildi');
        if (r.error) throw new OpenCodeCliError(`OpenCode başlatılamadı: ${r.error}`, 0);
        if (r.noOutput) throw new OpenCodeCliError(`OpenCode ${Math.round(FIRST_OUTPUT_MS / 60000)} dakika boyunca hiç çıktı vermedi: seçili model ya da sağlayıcı yanıt vermiyor olabilir (Ayarlar → Modeller → Yönetici'den başka bir model seçin)`, 0, { timeout: true, network: true });
        if (r.timedOut) throw new OpenCodeCliError(`OpenCode zaman aşımı (${Math.max(1, Math.round(timeoutMs / 60000))} dk)`, 0, { timeout: true, network: true });
        if (st.tokens || st.costUsd) onUsage?.({ totalTokenCount: st.tokens || 0, costUsd: st.costUsd || 0 });
        // Günlükteki asıl neden: `error="ProviderModelNotFoundError: Model not found: …"` biçimindeki son kayıt.
        const logCause = stderr.map((l) => l.match(/\berror="([^"]+)"/)?.[1]).filter(Boolean).pop() || '';
        const errText = [st.errorText || (r.code !== 0 ? stderr.slice(-15).join('\n') : ''), logCause].filter(Boolean).join(' — ');
        if (st.isError || (r.code !== 0 && !st.gotResult)) {
          const kind = failureKind(errText);
          const msg = clip(errText || `çıkış kodu ${r.code}`, 600);
          if (kind === 'limited') throw new OpenCodeCliError(`OpenCode sağlayıcı limiti: ${msg}`, 429, { limited: true, resetAt: parseResetAt(errText) });
          if (kind === 'offline') throw new OpenCodeCliError(`OpenCode bağlantı hatası: ${msg}`, 0, { network: true });
          if (kind === 'auth') throw new OpenCodeCliError(`OpenCode sağlayıcı anahtarı yok ya da geçersiz: ${msg}. Ayarlar → Bağlantılar → OpenCode → Giriş yap (opencode auth login).`, 401, { auth: true });
          throw new OpenCodeCliError(`OpenCode hatası: ${msg}`, 0);
        }
        if (!st.gotResult) throw new OpenCodeCliError('OpenCode adım bitiş olayı göndermeden kapandı (yarım yanıt)', 0, { truncated: true });
        const textOut = st.texts.join('\n\n');
        if (!schema) {
          if (!textOut.trim()) throw new OpenCodeCliError('OpenCode yanıt üretmedi', 0);
          return textOut;
        }
        // Yapılandırılmış sonuç: son mesajdan başa doğru, şemaya uyan ilk JSON.
        for (const t of [st.text, ...st.texts.slice().reverse()]) {
          const v = t && jsonFromText(t);
          if (v && conforms(v, schema)) return v;
        }
        throw new SyntaxError('OpenCode şemaya uyan bir sonuç vermedi');
      },
      // Yalnızca yarım yanıt ve bozuk JSON yeniden denenir (iki kez); limit, anahtar ve bağlantı hataları çağırana gider.
      { signal, delays: retryDelays || [3000, 10000] }
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
}

module.exports = { OpenCodeCliError, generate, managerModelOf, isNetworkError: (e) => e?.network === true };
