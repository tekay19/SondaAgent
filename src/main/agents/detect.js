// Ajanların durumu: kurulu mu, giriş yapılmış mı, hangi plan — ve canlı bağlantı denetimi.
const crossSpawn = require('cross-spawn');
const os = require('os');
const runner = require('../runner');
const { agentEnv } = require('../env');
const { claudeModelOf, claudeModelLabel } = require('../models');
const { clip, AUTH_ERROR, ADAPTERS } = require('./adapters');
const { resolveBin, versionOf, semver, cmpVersion, installKind, updateCommand, latestVersion } = require('./install');
const { jsonFromText, agentRunEnv } = require('./run');

const PLAN_LABEL = { max: 'Max', pro: 'Pro', team: 'Team', enterprise: 'Enterprise' };

/**
 * Oturum durumu (ana süreci kilitlemeden): { loggedIn: true | false | null, method, plan, account }.
 * Claude için `claude auth status` JSON çıktısı okunur: giriş türü (claude.ai aboneliği / API) ve abonelik planı.
 */
async function authInfo(id, bin) {
  const out = { loggedIn: null, method: null, plan: null, account: null };
  if (!bin) return out;
  const args = id === 'claude' ? ['auth', 'status'] : ['login', 'status'];
  const r = await runner.run({ command: bin, args, env: agentRunEnv(id), timeoutMs: 15000, tailSize: 20000 });
  const text = `${r.stdout || ''}\n${r.stderr || ''}`;
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
    const auth = await authInfo(id, bin);
    let { loggedIn } = auth;
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
      // Claude: giriş türü ("claude.ai" = abonelik), plan (Pro / Max…), hesap ve kullanılacak model.
      authMethod: auth.method,
      plan: auth.plan,
      account: auth.account,
      subscription: id === 'claude' && loggedIn ? auth.method === 'claude.ai' || !!auth.plan : null,
      model: id === 'claude' ? claudeModelOf(settings) : settings.codexModel || '',
      modelLabel: id === 'claude' ? claudeModelLabel(claudeModelOf(settings)) : settings.codexModel || '',
      canInstall: id === 'claude' && !bin,
      install: a.install,
      login: a.login,
      loginCommand: id === 'claude' ? 'claude auth login' : 'codex login',
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

module.exports = { authInfo, detect, rememberLiveCheck };
