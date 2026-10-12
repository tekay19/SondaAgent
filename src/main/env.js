// Ortam yardımcıları: PATH düzeltme, çalıştırılabilir dosya bulma, alt süreç ortamı.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { secretName } = require('./envfile');

const IS_WIN = process.platform === 'win32';
const SEP = IS_WIN ? ';' : ':';

// Finder/Dock'tan açılan macOS uygulamaları kabuğun PATH'ini almaz (claude, node, npm bulunamaz).
// Giriş kabuğundan gerçek PATH'i okuyup yaygın kurulum klasörlerini ekliyoruz.
function fixPath() {
  let parts = (process.env.PATH || '').split(SEP);
  const home = os.homedir();

  if (!IS_WIN) {
    try {
      const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
      const out = execFileSync(shell, ['-ilc', 'printf "__ORK__%s__ORK__" "$PATH"'], {
        encoding: 'utf8',
        timeout: 8000,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, DISABLE_AUTO_UPDATE: 'true' },
      });
      const m = out.match(/__ORK__([\s\S]*?)__ORK__/);
      if (m) parts = m[1].split(':').concat(parts);
    } catch {
      /* kabuk okunamadıysa aşağıdaki varsayılanlar yeterli */
    }
    parts.push(
      '/opt/homebrew/bin', '/usr/local/bin',
      path.join(home, '.local/bin'), path.join(home, '.npm-global/bin'),
      path.join(home, '.bun/bin'), path.join(home, '.volta/bin'), path.join(home, '.claude/local'),
      '/usr/bin', '/bin', '/usr/sbin', '/sbin'
    );
  } else {
    if (process.env.APPDATA) parts.push(path.join(process.env.APPDATA, 'npm'));
    parts.push(path.join(home, '.local', 'bin'));
    if (process.env.ProgramFiles) parts.push(path.join(process.env.ProgramFiles, 'nodejs'), path.join(process.env.ProgramFiles, 'Git', 'cmd'));
  }

  process.env.PATH = [...new Set(parts.filter(Boolean))].join(SEP);
}

function findExecutable(name) {
  if (!name) return null;
  if (path.isAbsolute(name)) return fs.existsSync(name) ? name : null;
  const exts = IS_WIN ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').concat(['']) : [''];
  for (const dir of (process.env.PATH || '').split(SEP)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, name + ext.toLowerCase());
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch {
        /* yok */
      }
    }
  }
  return null;
}

// PATH'teki tüm eşleşmeler (aynı dosyaya giden bağlantılar tekilleştirilir), PATH sırasıyla.
function findAllExecutables(name) {
  const exts = IS_WIN ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').concat(['']) : [''];
  const out = [];
  const seen = new Set();
  for (const dir of (process.env.PATH || '').split(SEP)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, name + ext.toLowerCase());
      try {
        if (!fs.statSync(full).isFile()) continue;
        const real = fs.realpathSync(full);
        if (seen.has(real)) continue;
        seen.add(real);
        out.push(full);
      } catch {
        /* yok */
      }
    }
  }
  return out;
}

// Kullanıcının bilinçli olarak ayarlamış olabileceği Claude Code değişkenleri korunur.
const KEEP_CLAUDE_VARS = /^CLAUDE_CODE_(USE_|SKIP_|GIT_BASH_PATH|MAX_OUTPUT_TOKENS|OAUTH_TOKEN$)/;

// Claude, kullanıcının abonelik girişiyle (claude auth login) çalışır. Ortamda bir Anthropic API anahtarı
// varsa Claude Code aboneliği bırakıp API faturalı çalışmaya geçer; bu yüzden anahtar ajanlara aktarılmaz.
const API_BILLING_VARS = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);

// Bilgisayardaki gizli değişkenler (GEMINI_API_KEY, OPENAI_API_KEY, GITHUB_TOKEN, AWS_SECRET_ACCESS_KEY…) ajanlara ve
// projenin komutlarına (ajanın yazdığı testler, kurulum betikleri) aktarılmaz: bir istem enjeksiyonu ya da özensiz bir
// betik onları dışarı sızdırabilirdi. Ad parçalarına bakılır (bkz. envfile.secretName); jeton/sır sözcüğü adın ortasında
// da olabilir (AWS_BEARER_TOKEN_BEDROCK).
const SECRET_PART = /(^|_)(TOKEN|SECRET|SECRETS|PASSWORD|PASSWD|CREDENTIAL|CREDENTIALS|APIKEY)(_|$)/;
const isSecretVar = (k) => secretName(k) || SECRET_PART.test(k.toUpperCase());
// Özel npm kayıtlarından paket kurulumu bunları ister (.npmrc'de `${NPM_TOKEN}`).
const REGISTRY_TOKENS = new Set(['NPM_TOKEN', 'NODE_AUTH_TOKEN', 'YARN_NPM_AUTH_TOKEN', 'BUN_AUTH_TOKEN']);
// Claude Code bir bulut sağlayıcısı üzerinden çalışıyorsa (CLAUDE_CODE_USE_BEDROCK / _VERTEX / _FOUNDRY) o sağlayıcının
// kimliğine ihtiyaç duyar; bu durumda yalnızca ajana gider, proje komutlarına gitmez.
const PROVIDER_VARS = /^(AWS_|GOOGLE_APPLICATION_CREDENTIALS$|CLOUDSDK_|ANTHROPIC_VERTEX_|ANTHROPIC_BEDROCK_|ANTHROPIC_FOUNDRY_|AZURE_)/i;
const usesCloudProvider = (env) => ['BEDROCK', 'VERTEX', 'FOUNDRY'].some((p) => /^(1|true|yes)$/i.test(env[`CLAUDE_CODE_USE_${p}`] || ''));

// Süreç ortamının temizlenmiş kopyası. `keep(ad)`: gizli adlı olduğu halde kalacak değişkenler.
// Sonda başka bir Claude Code oturumunun içinden başlatılmışsa (ör. geliştirme sırasında) o oturumun işaretleri de
// temizlenir ki iç içe oturum sanılmasın.
function cleanEnv(keep) {
  const env = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' };
  for (const k of Object.keys(env)) {
    const sessionMarker =
      k === 'CLAUDECODE' || k === 'CLAUDE_PID' || k === 'CLAUDE_AGENT_SDK_VERSION' ||
      (k.startsWith('CLAUDE_CODE_') && !KEEP_CLAUDE_VARS.test(k));
    if (sessionMarker || k === 'ELECTRON_RUN_AS_NODE' || API_BILLING_VARS.has(k) || (isSecretVar(k) && !keep(k))) delete env[k];
  }
  return env;
}

// Ajanlar (Claude Code, Codex) ve git için ortam. `extra` temizlikten sonra eklenir.
function agentEnv(extra = {}) {
  const cloud = usesCloudProvider(process.env);
  const env = cleanEnv((k) => REGISTRY_TOKENS.has(k) || KEEP_CLAUDE_VARS.test(k) || (cloud && PROVIDER_VARS.test(k)));
  return { ...env, ...extra };
}

// Doğrulama komutları (kurulum, build, test, dev sunucusu) için etkileşimsiz ortam: projenin kendi kodu çalışır, ajanın
// oturum jetonu ve bulut kimlikleri de gitmez. Uygulamanın gizli değerleri .env dosyasından okunur.
function verifyEnv(extra = {}) {
  const env = cleanEnv((k) => REGISTRY_TOKENS.has(k));
  return { ...env, CI: 'true', NEXT_TELEMETRY_DISABLED: '1', BROWSER: 'none', ...extra };
}

module.exports = { IS_WIN, fixPath, findExecutable, findAllExecutables, agentEnv, verifyEnv };
