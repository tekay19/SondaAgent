// Ajanların durumu: kurulu mu, giriş yapılmış mı, hangi plan — ve canlı bağlantı denetimi.
const os = require('os');
const runner = require('../runner');
const { claudeModelOf, claudeModelLabel } = require('../models');
const { clip, AUTH_ERROR, ADAPTERS } = require('./adapters');
const { resolveBin, versionOf, semver, cmpVersion, installKind, updateCommand, latestVersion } = require('./install');
const { jsonFromText, agentRunEnv } = require('./run');

const PLAN_LABEL = { max: 'Max', pro: 'Pro', team: 'Team', enterprise: 'Enterprise' };

// `opencode auth list` çıktısı: "N credentials" ve sağlayıcı satırları (ör. "● Nvidia api"). Renk kodları ayıklanır.
function opencodeCredentials(text) {
  const plain = String(text || '').replace(/\x1b\[[0-9;]*m/g, '');
  const n = Number(plain.match(/(\d+)\s+credentials?/i)?.[1] || 0);
  const providers = [...plain.matchAll(/^[\s│]*[●○•]\s+(\S[^\n]*?)\s+(api|oauth|[a-z-]+)\s*$/gim)].map((m) => m[1].trim());
  return { count: n, providers };
}

const LOGIN_COMMAND = { claude: 'claude auth login', codex: 'codex login', opencode: 'opencode auth login' };

/**
 * Oturum durumu (ana süreci kilitlemeden): { loggedIn: true | false | null, method, plan, account }.
 * Claude için `claude auth status` JSON çıktısı okunur: giriş türü (claude.ai aboneliği / API) ve abonelik planı.
 */
async function authInfo(id, bin) {
  const out = { loggedIn: null, method: null, plan: null, account: null };
  if (!bin) return out;
  const args = id === 'claude' ? ['auth', 'status'] : id === 'opencode' ? ['auth', 'list'] : ['login', 'status'];
  const r = await runner.run({ command: bin, args, env: agentRunEnv(id), timeoutMs: 15000, tailSize: 20000 });
  const text = `${r.stdout || ''}\n${r.stderr || ''}`;
  if (id === 'opencode') {
    // Sağlayıcı anahtarı yoksa da OpenCode'un ücretsiz modelleri (opencode/*-free) çalışabilir: "giriş yok" sayılmaz.
    const c = opencodeCredentials(text);
    out.loggedIn = c.count > 0 ? true : null;
    out.plan = c.count > 0 ? `${c.providers.join(', ') || c.count} sağlayıcı` : null;
    return out;
  }
  if (id === 'claude') {
    const info = jsonFromText(text);
    if (info && typeof info.loggedIn === 'boolean') {
      out.loggedIn = info.loggedIn;
      out.method = info.authMethod || null;
      out.plan = info.subscriptionType ? PLAN_LABEL[String(info.subscriptionType).toLowerCase()] || String(info.subscriptionType) : null;
      out.account = info.email || null;
      return out;
    }
    const m = text.match(/"loggedIn"\s*:\s*(true|false)/);
    if (m) out.loggedIn = m[1] === 'true';
  } else if (/not logged in/i.test(text)) out.loggedIn = false;
  else if (/logged in/i.test(text)) out.loggedIn = true;
  return out;
}

// `claude auth status` bazı giriş türlerinde (ör. Console / API Usage Billing ya da süresi
// dolmuş ama yenilenebilir jeton) yanlış "giriş yok" diyebiliyor. Olumsuz sonucu gerçek bir
// mini istekle doğrularız. Başarılı sonuç 10 dk, başarısız sonuç 1 dk önbellekte tutulur (giriş akışı ve "yeniden
// denetle" önbelleği atlar: `force`).
const liveCheckCache = new Map();
const LIVE_OK_TTL = 10 * 60000;
const LIVE_FAIL_TTL = 60000;

// Süreç ağacıyla birlikte kapatılabilen çalıştırıcıyla; MCP sunucuları yüklenmez (yalnızca giriş yoklanır).
async function liveCheck(bin) {
  const r = await runner.run({
    command: bin,
    args: ['-p', '--output-format', 'json', '--model', 'haiku', '--no-session-persistence', '--strict-mcp-config'],
    cwd: os.tmpdir(),
    env: agentRunEnv('claude', {}, 'review'),
    input: 'Reply with exactly: OK',
    timeoutMs: 90000,
    tailSize: 20000,
  });
  if (r.error) return { ok: false, error: 'başlatılamadı' };
  let res = null;
  try {
    res = JSON.parse(String(r.stdout || '').trim().split('\n').pop());
  } catch {
    /* JSON değil */
  }
  if (res && !res.is_error) return { ok: true };
  // Kimlik doğrulama dışı bir hata (ör. model erişimi) girişin çalıştığını gösterir.
  const text = res?.result || r.stderr || r.stdout || '';
  return { ok: !AUTH_ERROR.test(text), error: clip(String(text).trim(), 300) };
}

async function detect(settings, { force = false } = {}) {
  const out = {};
  for (const id of Object.keys(ADAPTERS)) {
    const a = ADAPTERS[id];
    const bin = resolveBin(id, settings);
    const auth = await authInfo(id, bin);
    let { loggedIn } = auth;
    let authError = null;
    // Codex yerel modelle (--oss) ya da NVIDIA NIM ile çalışıyorsa OpenAI girişi gerekmez: kurulu olması (NIM'de anahtar) yeter.
    if (bin && id === 'codex' && settings.codexProvider === 'local') {
      loggedIn = true;
      auth.plan = `yerel model · ${settings.codexLocalProvider === 'lmstudio' ? 'LM Studio' : 'Ollama'}`;
    } else if (bin && id === 'codex' && settings.codexProvider === 'nim') {
      loggedIn = !!settings.nimApiKey;
      auth.plan = loggedIn ? 'NVIDIA NIM' : null;
      if (!loggedIn) authError = 'NVIDIA NIM API anahtarı girilmemiş (Ayarlar → Bağlantılar → NVIDIA NIM).';
    }
    if (bin && id === 'claude' && loggedIn !== true) {
      const cached = liveCheckCache.get(bin);
      const fresh = cached && Date.now() - cached.at < (cached.r.ok ? LIVE_OK_TTL : LIVE_FAIL_TTL) && !force;
      const r = fresh ? cached.r : await liveCheck(bin);
      if (!fresh) liveCheckCache.set(bin, { at: Date.now(), r });
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
      // Claude: giriş türü ("claude.ai" = abonelik), plan (Pro / Max…), hesap ve kullanılacak model.
      authMethod: auth.method,
      plan: auth.plan,
      account: auth.account,
      subscription: id === 'claude' && loggedIn ? auth.method === 'claude.ai' || !!auth.plan : null,
      model: id === 'claude' ? claudeModelOf(settings) : id === 'opencode' ? settings.opencodeModel || '' : settings.codexModel || '',
      modelLabel: id === 'claude' ? claudeModelLabel(claudeModelOf(settings)) : id === 'opencode' ? settings.opencodeModel || '' : settings.codexModel || '',
      canInstall: id === 'claude' && !bin,
      install: a.install,
      login: a.login,
      loginCommand: LOGIN_COMMAND[id] || `${id} login`,
    };
  }
  return out;
}

// "Bağlantıyı test et" sonucunu durum önbelleğine yansıtır.
function rememberLiveCheck(agentId, settings, ok) {
  const bin = resolveBin(agentId, settings);
  if (!bin) return;
  if (ok) liveCheckCache.set(bin, { at: Date.now(), r: { ok: true } });
  else liveCheckCache.delete(bin);
}

module.exports = { authInfo, detect, rememberLiveCheck, opencodeCredentials };
