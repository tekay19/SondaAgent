const { app, BrowserWindow, ipcMain, dialog, shell, Notification, powerSaveBlocker, nativeTheme } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crossSpawn = require('cross-spawn');
const { spawn } = require('child_process');
const { fixPath, findExecutable, agentEnv } = require('./env');
const runner = require('./runner');
const settings = require('./settings');
const anthropic = require('./anthropic');
const claudecli = require('./claudecli');
const localllm = require('./localllm');
const { claudeModelLabel, claudeModelOf, codexModelFor } = require('./models');
const agents = require('./agents');
const docs = require('./docs');
const jobs = require('./jobs');
const verify = require('./verify');
const secrets = require('./secrets');
const envfile = require('./envfile');
const archive = require('./archive');
const { Orchestrator } = require('./orchestrator');
const { jobEventThrottle, folderGuard } = require('./ipcutil');

// Uygulama adı: ayarlar klasörü (~/Library/Application Support/Sonda Agent) ve şifreli anahtarların
// anahtar zinciri kaydı bu ada bağlıdır.
app.setName('Sonda Agent');
// Geliştirme / test: ayrı bir veri klasörüyle ikinci bir kopya çalıştırmak için (tek kopya kilidi userData'ya bağlıdır).
if (process.env.SONDA_USER_DATA) app.setPath('userData', process.env.SONDA_USER_DATA);

// Tek kopya: ikinci bir Sonda aynı işi "yarıda kalmış" görüp sürdürebilir (aynı klasörde iki ajan) ve
// ayar / anahtar dosyalarını ezebilirdi. İkinci açılış var olan pencereyi öne getirir.
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
else fixPath();

const ACTIVE_PHASES = new Set(['planning', 'running', 'verifying', 'testing', 'reviewing', 'fixing', 'reporting']);
const NOTIFY = {
  awaiting_answers: ['Birkaç sorum var', 'Yönetici ürün tanımını çıkardı; planı netleştirmek için cevaplarınızı bekliyor.'],
  awaiting_approval: ['Plan hazır', 'Plan hazırlandı; onayınızı bekliyor.'],
  done: ['Teslime hazır', 'Testler, güvenlik ve son kabul geçti; rapor hazır.'],
  incomplete: ['Teslime hazır değil', 'Son kabulde açık sorunlar kaldı; düzeltmeye devam edebilirsiniz.'],
  failed: ['İş hata ile durdu', 'Ayrıntılar için Sonda Agent\'a bakın.'],
};

let win = null;
let quitting = false;
let processesStopped = false; // çıkışta süreçler kapatıldı (bkz. before-quit)
let sleepBlocker = null;

function send(evt) {
  if (win && !win.isDestroyed()) win.webContents.send('sonda:event', evt);
}
// İş güncellemeleri seyreltilir (bkz. ipcutil): her biri işin tamamını taşır ve görünümü yeniden çizdirir.
const jobEvents = jobEventThrottle(send);
// Bildirimler bir yerde tutulur: macOS'ta çöp toplanan bildirimin tıklama işleyicisi kaybolur.
const notices = new Set();

function showWindow() {
  if (!win || win.isDestroyed()) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ---------- Orkestratör havuzu: her işin kendi orkestratörü (kendi ajan oturumu) vardır ----------
// Farklı projeler paralel çalışabilir; aynı klasörde aynı anda tek iş çalışır (iki ajan aynı dosyaları ezmesin).
const pool = new Map(); // jobId → Orchestrator
const starting = new Set(); // başlamakta olan (kimliği henüz havuza yazılmamış) orkestratörler
const lastPhase = new Map(); // jobId → son bildirilen aşama
const sameDir = (a, b) => !!a && !!b && path.resolve(a) === path.resolve(b);
const runningOrchs = () => [...new Set([...pool.values(), ...starting])].filter((o) => o.running && o.job);
const runningIds = () => runningOrchs().map((o) => o.job.id);

function makeOrch() {
  const o = new Orchestrator({ emit: (evt) => onOrchEvent(o, evt) });
  // Kullanıcı "Çalıştır" ile bu klasörde sunucu açtıysa ajan temizliği ona dokunmaz.
  o.appRunningFor = (dir) => !!devServer && sameDir(devServer.dir, dir);
  return o;
}

function onOrchEvent(o, evt) {
  if (evt.type === 'busy') {
    // Uzun işlerde bilgisayarın uykuya geçip ajanı yarıda kesmesini engelle.
    const any = runningOrchs().length > 0;
    if (any && sleepBlocker == null) sleepBlocker = powerSaveBlocker.start('prevent-app-suspension');
    if (!any && sleepBlocker != null) {
      powerSaveBlocker.stop(sleepBlocker);
      sleepBlocker = null;
    }
    send({ type: 'busy', jobId: o.job?.id || null, busy: evt.busy, running: runningIds() });
    return;
  }
  if (evt.type === 'job') jobEvents.push(evt);
  else send(evt);
  if (evt.type === 'job' && evt.job.phase !== lastPhase.get(evt.job.id)) {
    lastPhase.set(evt.job.id, evt.job.phase);
    const n = NOTIFY[evt.job.phase];
    if (n && Notification.isSupported() && !win?.isFocused()) {
      const note = new Notification({ title: `Sonda Agent · ${n[0]}`, body: `${evt.job.plan?.projectName || String(evt.job.idea || '').slice(0, 60)} — ${n[1]}` });
      notices.add(note);
      note.on('click', () => {
        notices.delete(note);
        showWindow();
      });
      note.on('close', () => notices.delete(note));
      note.show();
    }
  }
}

// Diskteki işi okur; uygulama kapanırken yarıda kalmışsa "durduruldu" olarak işaretler.
function loadStored(id) {
  const data = jobs.load(id);
  if (ACTIVE_PHASES.has(data.job.phase)) {
    data.job.phase = 'stopped';
    for (const t of data.job.tasks || []) if (!['done', 'skipped', 'failed', 'pending'].includes(t.status)) t.status = 'pending';
  }
  return data;
}

// İşin orkestratörü: havuzda yoksa diskten yüklenip oluşturulur.
function orchFor(id) {
  if (!jobs.validId(id)) throw new Error('İş seçilmedi.');
  let o = pool.get(id);
  if (o?.job) return o;
  const { job } = loadStored(id);
  const { shots, ...rest } = job;
  o = makeOrch();
  o.adopt({ ...rest, shots: (shots || []).map(({ dataUrl, ...sh }) => sh) });
  pool.set(id, o);
  return o;
}

// İşin güncel hali (bellekteki ya da diskteki): klasör, plan gibi alanlar arayüzden değil buradan okunur.
function jobOf(id) {
  if (!jobs.validId(id)) throw new Error('İş seçilmedi.');
  return pool.get(id)?.job || jobs.read(id);
}

// Yeni çalışma başlatmadan önce: paralel iş sınırı ve "aynı klasörde tek iş" kuralı.
function assertCanRun(projectDir, exceptId) {
  const others = runningOrchs().filter((o) => o.job.id !== exceptId);
  const clash = others.find((o) => sameDir(o.job.projectDir, projectDir));
  if (clash) throw new Error(`Bu klasörde zaten çalışan bir iş var (${clash.job.plan?.projectName || path.basename(projectDir)}). Bitmesini bekleyin ya da durdurun.`);
  const max = settings.get().maxParallelJobs || 3;
  if (others.length >= max) throw new Error(`Aynı anda en fazla ${max} iş çalışabilir (Ayarlar → Süreç). Birinin bitmesini bekleyin ya da durdurun.`);
}

// Yeni iş: kendi orkestratörüyle başlar. Orkestratör başlarken "meşgul" olayını kimliği havuza yazılmadan
// önce yayar; `starting` kümesi o anda da çalışan işler arasında sayılmasını sağlar.
function startNew(projectDir, begin) {
  if (typeof projectDir !== 'string' || !path.isAbsolute(projectDir)) throw new Error('Proje klasörü seçin.');
  assertCanRun(projectDir, null);
  const o = makeOrch();
  starting.add(o);
  try {
    const id = begin(o);
    pool.set(id, o);
    return id;
  } finally {
    starting.delete(o);
  }
}

// Var olan işte çalışma başlatan eylemler (onay, sürdür, yeniden planla…).
function act(id, fn) {
  const o = orchFor(id);
  assertCanRun(o.job.projectDir, id);
  return fn(o);
}

// ---------- "Uygulamayı çalıştır" ----------
let devServer = null; // { proc, url, dir }
async function runApp({ dir, command, url }) {
  await stopApp();
  send({ type: 'app', state: 'starting', dir });
  const r = await verify.startDevServer({ dir, command: command || null, url: url || null });
  if (!r.ok) {
    send({ type: 'app', state: 'stopped', dir });
    throw new Error(r.skipped || `${r.error}${r.output ? `\n${r.output.slice(-600)}` : ''}`);
  }
  devServer = { proc: r.proc, url: r.url, dir };
  r.proc.done.then(() => {
    if (devServer?.proc === r.proc) {
      devServer = null;
      send({ type: 'app', state: 'stopped', dir });
    }
  });
  send({ type: 'app', state: 'running', url: r.url, dir });
  shell.openExternal(r.url);
  return { url: r.url };
}
async function stopApp() {
  if (!devServer) return;
  const { proc, dir } = devServer;
  devServer = null;
  proc.kill();
  await Promise.race([proc.done, new Promise((r) => setTimeout(r, 5000))]);
  send({ type: 'app', state: 'stopped', dir });
}

// Windows: başlık çubuğu uygulamanın kendi zeminiyle birleşir; pencere düğmeleri tema renklerini alır.
function titleBarOverlay() {
  return nativeTheme.shouldUseDarkColors ? { color: '#0b1d24', symbolColor: '#e9efee', height: 36 } : { color: '#f7f5ef', symbolColor: '#14213d', height: 36 };
}

// Çalışan iş varken kapatma / çıkma: işler durdurulmadan önce sorulur.
function confirmStopAll() {
  const n = runningOrchs().length;
  const choice = dialog.showMessageBoxSync(win && !win.isDestroyed() ? win : undefined, {
    type: 'question',
    buttons: ['Durdur ve çık', 'Vazgeç'],
    defaultId: 1,
    cancelId: 1,
    message: n > 1 ? `${n} iş hâlâ çalışıyor.` : 'Bir iş hâlâ çalışıyor.',
    detail: 'Çıkarsanız iş durur; Sonda\'yı tekrar açınca "Sürdür" ile kaldığı yerden devam eder.',
  });
  return choice === 0;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 660,
    title: 'Sonda Agent',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b1d24' : '#f7f5ef',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : process.platform === 'win32' ? 'hidden' : 'default',
    ...(process.platform === 'win32' ? { titleBarOverlay: titleBarOverlay() } : {}),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  // Arayüz hiçbir izin (kamera, konum, bildirim…) istemez; istenirse reddedilir.
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

  // İş çalışırken pencere kapatılırsa sor: arka planda sürsün mü, durup kapansın mı?
  win.on('close', (e) => {
    if (!runningOrchs().length || quitting) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Arka planda devam et', 'Durdur ve kapat', 'Vazgeç'],
      defaultId: 0,
      cancelId: 2,
      message: runningOrchs().length > 1 ? `${runningOrchs().length} iş hâlâ çalışıyor.` : 'Bir iş hâlâ çalışıyor.',
      detail: 'Arka planda devam ederse Dock / görev çubuğundan pencereyi tekrar açabilirsiniz. Bilgisayarı kapatırsanız iş durur; açınca "Sürdür" ile kaldığı yerden devam eder.',
    });
    if (choice === 0) {
      e.preventDefault();
      if (process.platform === 'darwin') win.hide();
      else win.minimize();
    } else if (choice === 2) {
      e.preventDefault();
    } else {
      quitting = true;
      setImmediate(() => app.quit());
    }
  });
}

// Hata mesajlarını arayüze düzgün taşımak için sarmalayıcı.
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, arg) => {
    try {
      return { ok: true, data: await fn(arg) };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });
}

// Arayüzden gelen klasör yolları yalnızca seçilmiş ya da bilinen klasörler olabilir (bkz. ipcutil.folderGuard).
const folders = folderGuard({ known: () => [...jobs.list().map((j) => j.projectDir), ...[...pool.values()].map((o) => o.job?.projectDir)] });
const needDir = (dir) => folders.check(dir);
const agentOf = (id) => {
  if (!Object.prototype.hasOwnProperty.call(agents.ADAPTERS, id)) throw new Error('Bilinmeyen ajan.');
  return agents.ADAPTERS[id];
};

handle('settings:get', () => settings.getPublic());
// Seçili proje klasörü için hatırlanan kadro (yönetici / kodlayıcı / inceleyici); yoksa boş nesne.
handle('settings:projectStack', (dir) => settings.projectStack(needDir(dir)));
handle('settings:save', (patch) => {
  const s = settings.save(patch);
  applyTheme();
  return s;
});

// Görünüm: sistem / açık / koyu. Arayüz CSS'i prefers-color-scheme ile buna uyar.
function applyTheme() {
  const t = settings.get().theme;
  nativeTheme.themeSource = ['light', 'dark'].includes(t) ? t : 'system';
}
nativeTheme.on('updated', () => {
  if (process.platform === 'win32' && win && !win.isDestroyed()) win.setTitleBarOverlay(titleBarOverlay());
  if (win && !win.isDestroyed()) win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#0b1d24' : '#f7f5ef');
});

// ---------- Anahtarlar (.env) ----------
// Arayüze yalnızca maskeli değerler gider. Kaydedince değerler projenin .env dosyasına yazılır.
handle('env:get', (dir) => secrets.view(needDir(dir)));
handle('env:save', ({ dir: raw, set, remove } = {}) => {
  const dir = needDir(raw);
  secrets.update(dir, { set, remove });
  const written = secrets.sync(dir);
  for (const o of pool.values()) {
    if (!o.job || !sameDir(o.job.projectDir, dir)) continue;
    o.job.env = secrets.summary(dir);
    o.update();
  }
  return { ...secrets.view(dir), written: written.map((f) => path.relative(dir, f) || '.env') };
});
// Yapıştırılan .env metnini dotenv kurallarıyla çözer (tırnaklar, çok satırlı değerler, satır sonu yorumları).
handle('env:parse', (text) => envfile.parseEnv(String(text || '').slice(0, 200000)));

// Sunucu listeleme ve deneme çağrıları Ayarlar penceresindeki HENÜZ KAYDEDİLMEMİŞ değerlerle çalışır (adres, anahtar,
// model): kullanıcı "Vazgeç" derse hiçbir şey kalıcı olmaz. Verilmeyen alan kayıtlı ayardan tamamlanır.
const str = (v) => String(v || '').trim();
const serverArgs = (prefix, o = {}) => {
  const s = settings.get();
  return { baseUrl: str(o.baseUrl) || s[`${prefix}BaseUrl`], apiKey: str(o.apiKey) || s[`${prefix}ApiKey`], model: str(o.model) || s[`${prefix}Model`] };
};
handle('anthropic:models', (o = {}) => anthropic.listModels({ apiKey: str(o.apiKey) || settings.get().anthropicKey }));
// Yerel model sunucusu (Ollama, LM Studio, llama.cpp…): modeller ve metin + şemalı deneme.
handle('local:models', (o) => {
  const { baseUrl, apiKey } = serverArgs('local', o);
  return localllm.listModels({ baseUrl, apiKey });
});
// NVIDIA NIM (harici OpenAI uyumlu API): aynı istemci, adres ve anahtar ayarlardan.
handle('nim:models', (o) => {
  const { baseUrl, apiKey } = serverArgs('nim', o);
  if (!apiKey) throw new Error('Önce NVIDIA NIM API anahtarını girin (build.nvidia.com → API Keys).');
  return localllm.listModels({ baseUrl, apiKey });
});
handle('nim:test', async (o) => {
  const { baseUrl, apiKey, model } = serverArgs('nim', o);
  if (!apiKey) throw new Error('NVIDIA NIM API anahtarı yok.');
  if (!model) throw new Error('NIM modeli seçilmemiş: "Modelleri getir" ile listeyi çekip Modeller → Yönetici\'den seçin.');
  // Deneme isteği uzun beklemez: model yanıt vermiyorsa (NIM'de bazı modeller dakikalarca sessiz kalabiliyor) 60 sn'de bildirilir.
  const args = { baseUrl, apiKey, model, timeoutMs: 60000 };
  const text = await localllm.generate({ ...args, parts: [{ text: 'Reply with exactly: OK' }], temperature: 0, maxOutputTokens: 64 });
  const json = await localllm.generate({ ...args, parts: [{ text: 'Return a JSON object with ok set to true.' }], schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }, temperature: 0, maxOutputTokens: 256 });
  if (json?.ok !== true) throw new Error(`NIM modelinin şemalı yanıtı beklenen gibi değil: ${JSON.stringify(json).slice(0, 120)}.`);
  return { model, reply: `${text.trim().slice(0, 40)} · JSON ✓` };
});
handle('local:test', async (o) => {
  const { baseUrl, apiKey, model } = serverArgs('local', o);
  if (!model) throw new Error('Yerel model seçilmemiş: "Modelleri getir" ile listeyi çekip Modeller → Yönetici\'den seçin.');
  const args = { baseUrl, apiKey, model, timeoutMs: 60000 };
  const text = await localllm.generate({ ...args, parts: [{ text: 'Reply with exactly: OK' }], temperature: 0, maxOutputTokens: 64 });
  const json = await localllm.generate({ ...args, parts: [{ text: 'Return a JSON object with ok set to true.' }], schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }, temperature: 0, maxOutputTokens: 256 });
  if (json?.ok !== true) throw new Error(`Yerel modelin şemalı yanıtı beklenen gibi değil: ${JSON.stringify(json).slice(0, 120)}. Bu model yönetici işleri için uygun olmayabilir.`);
  return { model, reply: `${text.trim().slice(0, 40)} · JSON ✓` };
});
handle('anthropic:test', async (o = {}) => {
  const s = settings.get();
  const apiKey = str(o.apiKey) || s.anthropicKey;
  const model = str(o.model) || s.anthropicModel;
  if (!apiKey) throw new Error('Anthropic API anahtarı yok: alana yapıştırın ya da Ayarlar\'a kaydedin.');
  const text = await anthropic.generate({ apiKey, model, parts: [{ text: 'Reply with exactly: OK' }], maxOutputTokens: 256, effort: 'low' });
  // Yönetici adımlarının çoğu şemalı (JSON) çağrıdır: test o yolu da dener, yoksa ilk planlamada patlar.
  const json = await anthropic.generate({ apiKey, model, parts: [{ text: 'Return ok=true.' }], schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }, maxOutputTokens: 256, effort: 'low' });
  if (json?.ok !== true) throw new Error(`Claude API şemalı yanıtı beklenen gibi değil: ${JSON.stringify(json).slice(0, 120)}`);
  return { model, reply: `${text.trim().slice(0, 40)} · JSON ✓` };
});
// Claude CLI yöneticisi: metin ve şemalı (JSON) yol birlikte denenir (yönetici adımlarının çoğu şemalıdır).
handle('claudecli:test', async () => {
  const s = settings.get();
  const model = settings.managerClaudeModelOf(s);
  const text = await claudecli.generate({ settings: s, model, parts: [{ text: 'Reply with exactly: OK' }], effort: 'low' });
  const json = await claudecli.generate({ settings: s, model, parts: [{ text: 'Return ok=true.' }], schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }, effort: 'low' });
  if (json?.ok !== true) throw new Error(`Claude CLI şemalı yanıtı beklenen gibi değil: ${JSON.stringify(json).slice(0, 120)}`);
  return { model: claudeModelLabel(model), reply: `${text.trim().slice(0, 40)} · JSON ✓` };
});

// ---------- Ajan bağlantıları: kurulum → giriş → test ----------
handle('agents:detect', (opts) => agents.detect(settings.get(), opts || {}));
// OpenCode'un gördüğü modeller ("sağlayıcı/model"): yapılandırılmış sağlayıcılar + ücretsiz modeller.
handle('opencode:models', async () => {
  const bin = agents.resolveBin('opencode', settings.get());
  if (!bin) throw new Error('OpenCode bulunamadı. Kurulum: npm install -g opencode-ai');
  const r = await runner.run({ command: bin, args: ['models'], env: agents.agentRunEnv('opencode'), timeoutMs: 60000, tailSize: 200000 });
  const ids = String(r.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[\w.-]+\/\S+$/.test(l));
  if (!ids.length) throw new Error(`OpenCode model listesi alınamadı: ${(r.stderr || r.stdout || '').trim().slice(-300)}`);
  return ids.map((id) => ({ id, label: id }));
});
// Yalnızca oturum durumu (hızlı): giriş penceresi açıkken arayüz bununla yoklar.
handle('agents:auth', (agentId) => {
  agentOf(agentId);
  return agents.authInfo(agentId, agents.resolveBin(agentId, settings.get()));
});
// Claude Code'u resmi yükleyiciyle kurar; çıktı satırları arayüze akar.
handle('agents:install', (agentId) => {
  agentOf(agentId);
  return agents.install(agentId, settings.get(), { onLine: (line) => send({ type: 'setup', agentId, line: line.slice(0, 300) }) });
});
// CLI güncelleme (Homebrew / resmi yükleyici / npm). Çalışan bir ajan oturumu yarıda kalmasın diye iş sürerken yapılmaz.
handle('agents:update', (agentId) => {
  agentOf(agentId);
  if (runningOrchs().length) throw new Error('Şu anda çalışan iş var. Güncellemeyi işler bitince ya da durdurunca yapın.');
  return agents.update(agentId, settings.get());
});
// Ajanın kurulu VE oturum açmış olduğunu, seçili modelle küçük bir istek atarak doğrular.
handle('agents:test', async (agentId) => {
  agentOf(agentId);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonda-test-'));
  const saved = settings.get();
  // Codex modeli rolüne göre çözülür (NIM'de rol başına NIM modeli; OpenAI alanındaki eski ad NIM'e gitmez), orkestratördeki gibi.
  const s = { ...saved, claudeEffort: '', agentTimeoutMin: 2, codexModel: codexModelFor(saved, 'coder') };
  // Deneme isteğinde 90 sn içinde tek satır çıktı yoksa model / sağlayıcı yanıt vermiyordur: 2 dakikalık zaman aşımı beklenmez.
  const model = agentId === 'claude' ? claudeModelLabel(claudeModelOf(s)) : agentId === 'opencode' ? s.opencodeModel || 'OpenCode\'un varsayılan modeli' : s.codexModel || 'Codex\'in varsayılan modeli';
  try {
    const r = await agents.runAgent({ agentId, settings: s, cwd: dir, prompt: 'Reply with exactly the word OK and nothing else. Do not use any tools.', onLog: () => {}, firstOutputMs: 90000 });
    agents.rememberLiveCheck(agentId, s, r.ok);
    if (!r.ok) {
      if (r.noOutput || /zaman aşımı/.test(r.error || '')) throw new Error(`${model} yanıt vermedi (${r.noOutput ? '90 saniye' : '2 dakika'}). Model ya da sağlayıcı takılmış olabilir; Ayarlar → Modeller\'den başka bir model seç${agentId === 'opencode' ? ' (ör. ücretsiz opencode/big-pickle)' : ''}.`);
      throw new Error(r.error);
    }
    return { reply: (r.text || '').trim().slice(0, 80) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Terminalde çalışan giriş komutu (Claude kendi akışını kullanır): Codex OpenAI girişi, OpenCode sağlayıcı anahtarı.
const LOGIN_ARGS = { codex: 'login', opencode: 'auth login' };

// Giriş akışını kullanıcının terminalinde açar: tarayıcıda Claude hesabıyla (abonelik) giriş yapılır.
// Sonda oturumu kendiliğinden algılar (arayüz `agents:auth` ile yoklar).
handle('agents:login', (agentId) => {
  const adapter = agentOf(agentId);
  const bin = agents.resolveBin(agentId, settings.get());
  if (!bin) throw new Error(`${adapter.label} bulunamadı. Önce kurun.`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonda-login-'));
  if (process.platform === 'win32') {
    const q = `"${bin}"`;
    const script = agentId === 'claude'
      ? `@echo off\r\necho Sonda Agent - Claude hesabina giris\r\necho Tarayicida giris sayfasi acilacak. Claude (Pro / Max) hesabinizla giris yapip izin verin.\r\necho.\r\n${q} auth login --claudeai\r\necho.\r\necho Giris tamamlandiysa bu pencereyi kapatabilirsiniz; Sonda baglantiyi kendiliginden algilar.\r\npause\r\n`
      : `@echo off\r\n${agentId === 'opencode' ? `set "XDG_DATA_HOME=${agents.opencodeDataHome()}"\r\n` : ''}${q} ${LOGIN_ARGS[agentId]}\r\npause\r\n`;
    const file = path.join(dir, `sonda-${agentId}-giris.cmd`);
    fs.writeFileSync(file, script);
    spawn('cmd.exe', ['/c', 'start', '""', 'cmd', '/k', file], { detached: true, stdio: 'ignore' }).unref();
    return true;
  }
  const q = `'${bin.replace(/'/g, `'\\''`)}'`;
  const body = agentId === 'claude'
    ? `clear\necho "Sonda Agent · Claude hesabına giriş"\necho "Tarayıcıda giriş sayfası açılacak. Claude (Pro / Max) hesabınla giriş yapıp izin ver."\necho\n${q} auth login --claudeai\nrc=$?\necho\nif [ $rc -eq 0 ]; then echo "✓ Giriş tamamlandı. Bu pencereyi kapatabilirsin; Sonda bağlantıyı kendiliğinden algılar."; else echo "Giriş tamamlanamadı (kod $rc). Sonda'da \\"Giriş yap\\"a tekrar basabilirsin."; fi\n`
    : `${agentId === 'opencode' ? `export XDG_DATA_HOME='${agents.opencodeDataHome().replace(/'/g, `'\\''`)}'\n` : ''}${q} ${LOGIN_ARGS[agentId]}\n`;
  const file = path.join(dir, `sonda-${agentId}-giris.command`);
  fs.writeFileSync(file, `#!/bin/zsh -l\ncd ~\n${body}`, { mode: 0o755 });
  if (process.platform === 'darwin') return shell.openPath(file).then((err) => {
    if (err) throw new Error(`Terminal açılamadı: ${err}`);
    return true;
  });
  spawn('x-terminal-emulator', ['-e', file], { detached: true, stdio: 'ignore' }).unref();
  return true;
});
// Hesaptan çıkış (hesap değiştirmek için). Çalışan iş varken yapılmaz: ajan oturumları yarıda kalır.
handle('agents:logout', async (agentId) => {
  agentOf(agentId);
  if (runningOrchs().length) throw new Error('Şu anda çalışan iş var. Önce işleri durdurun ya da bitmesini bekleyin.');
  const bin = agents.resolveBin(agentId, settings.get());
  if (!bin) throw new Error('CLI bulunamadı.');
  const r = await runner.run({ command: bin, args: agentId === 'codex' ? ['logout'] : ['auth', 'logout'], env: agentEnv(), timeoutMs: 30000, tailSize: 4000 });
  agents.rememberLiveCheck(agentId, settings.get(), false);
  if (r.code !== 0) throw new Error(`Çıkış yapılamadı: ${(r.stderr || r.stdout || r.error || '').trim().slice(-300)}`);
  return true;
});

handle('dialog:folder', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Proje klasörü seçin',
    properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
    defaultPath: settings.get().lastProjectDir || app.getPath('documents'),
  });
  if (r.canceled) return null;
  folders.allow(r.filePaths[0]);
  return r.filePaths[0];
});
handle('dialog:docs', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Teknik doküman ekle', properties: ['openFile', 'multiSelections'], filters: docs.FILTERS });
  return r.canceled ? [] : r.filePaths.map(docs.inspect);
});
// Tasarım dosyaları / klasörü: HTML-CSS şablonu, görseller, fontlar ya da bütün bir tasarım klasörü.
handle('dialog:design', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Tasarım dosyası ya da klasörü ekle', properties: ['openFile', 'openDirectory', 'multiSelections', 'treatPackageAsDirectory'], filters: docs.DESIGN_FILTERS });
  return r.canceled ? [] : r.filePaths.map((p) => docs.inspect(p, 'design'));
});
// Sürükle-bırak: klasörler ve yalnızca tasarımda anlamlı dosyalar (css, font…) tasarım; diğerleri doküman (arayüzden değiştirilebilir).
handle('docs:inspect', (paths) =>
  (Array.isArray(paths) ? paths : [])
    .filter((p) => typeof p === 'string' && fs.existsSync(p))
    .map((p) => {
      const dir = fs.statSync(p).isDirectory();
      const asDesign = dir || (!docs.inspect(p).kind && docs.isDesignFile(p));
      return docs.inspect(p, asDesign ? 'design' : 'doc');
    })
);

// Proje klasörüne dokunan eylemler işin kimliğiyle çağrılır; klasör ve komutlar kayıtlı işten okunur
// (arayüzden gelen serbest bir yol ya da komut çalıştırılmaz).
handle('project:open', async (id) => {
  const err = await shell.openPath(jobOf(id).projectDir);
  if (err) throw new Error(`Klasör açılamadı: ${err}`);
  return true;
});
handle('project:editor', (id) => {
  const dir = jobOf(id).projectDir;
  const code = findExecutable('code') || findExecutable('cursor');
  if (!code) return shell.openPath(dir);
  crossSpawn(code, [dir], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  return true;
});
// Teslim paketi: kaynak + docs (+ temizse git geçmişi) içeride; node_modules, derleme çıktıları ve gizli dosyalar dışarıda.
handle('project:zip', async (id) => {
  const job = jobOf(id);
  const dir = job.projectDir;
  if (!dir || !fs.existsSync(dir)) throw new Error('Proje klasörü bulunamadı.');
  const name = job.plan?.projectName || path.basename(dir);
  const r = await dialog.showSaveDialog(win, {
    title: 'Projeyi zip olarak kaydet',
    defaultPath: path.join(app.getPath('desktop'), `${archive.safeName(name)}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.zip`),
    filters: [{ name: 'Zip arşivi', extensions: ['zip'] }],
  });
  if (r.canceled || !r.filePath) return null;
  const out = await archive.zipProject(dir, { target: r.filePath.endsWith('.zip') ? r.filePath : `${r.filePath}.zip`, needles: secrets.needles(dir) });
  shell.showItemInFolder(out.file);
  return out;
});
handle('shell:external', (url) => (typeof url === 'string' && /^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(url) ? shell.openExternal(url) : null));
handle('app:run', (id) => {
  const job = jobOf(id);
  const v = job.plan?.verify || {};
  return runApp({ dir: job.projectDir, command: v.devCommand, url: v.devUrl });
});
handle('app:stop', () => stopApp());
handle('app:status', () => (devServer ? { state: 'running', url: devServer.url, dir: devServer.dir } : { state: 'stopped' }));

handle('job:plan', (args) => {
  const projectDir = needDir(args?.projectDir);
  return startNew(projectDir, (o) => o.startPlanning({ ...args, projectDir }));
});
// Bitmiş / mevcut projede devam: özellik ekleme, hata düzeltme ya da refactor.
handle('job:maintain', (args) => {
  const projectDir = needDir(args?.projectDir);
  return startNew(projectDir, (o) => o.startMaintenance({ ...args, projectDir }));
});
handle('job:replan', ({ id, feedback } = {}) => act(id, (o) => o.replan(feedback)));
handle('job:answer', ({ id, answers } = {}) => act(id, (o) => o.answerQuestions(answers)));
handle('job:approve', ({ id, ...args } = {}) => act(id, (o) => o.approve(args)));
handle('job:resume', (id) => act(id, (o) => o.resume()));
handle('job:continueFinal', (id) => act(id, (o) => o.continueFinal()));
handle('job:stop', (id) => orchFor(id).stop());
// İptal edilen plan / sorular geri getirilir (çalışma başlatmaz; onay ya da cevap yine kullanıcıdan beklenir).
handle('job:reopen', (id) => orchFor(id).reopen());
handle('job:note', ({ id, text } = {}) => orchFor(id).addNote(text));
// Çalışan işler (en son başlayan önce). `job` ve `busy` eski arayüz sözleşmesiyle uyumludur.
handle('job:current', () => {
  const live = runningOrchs().sort((a, b) => (b.job.createdAt || 0) - (a.job.createdAt || 0));
  return { job: live[0]?.snapshot() || null, busy: live.length > 0, running: live.map((o) => o.job.id), max: settings.get().maxParallelJobs || 3 };
});
handle('jobs:list', () =>
  jobs.list().map((j) => {
    const o = pool.get(j.id);
    // Havuzdaki işin belleği diskten yenidir (kayıt gecikmeli yazılır).
    if (o?.job) return { ...j, phase: o.job.phase, title: o.job.plan?.projectName || j.title, running: o.running };
    return ACTIVE_PHASES.has(j.phase) ? { ...j, phase: 'stopped', interrupted: true } : j;
  })
);
handle('jobs:load', (id) => {
  if (!jobs.validId(id)) throw new Error('İş seçilmedi.');
  const o = pool.get(id);
  // Havuzdaki işin belleği esastır; loglar diskten ve henüz yazılmamış tampondan birlikte okunur.
  if (o?.job) return { job: { ...o.snapshot(), shots: jobs.withShotData(id, o.job.shots) }, logs: jobs.readLogs(id), live: o.running };
  return loadStored(id);
});
handle('jobs:delete', (id) => {
  if (!jobs.validId(id)) throw new Error('İş seçilmedi.');
  if (pool.get(id)?.running) throw new Error('Çalışan iş silinemez.');
  jobs.remove(id);
  pool.delete(id);
  lastPhase.delete(id);
  jobEvents.forget(id);
  return true;
});

if (primary) {
  app.on('second-instance', showWindow);

  app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('com.semih.sonda-agent');
    // Şifreleme ancak uygulama hazır olunca kullanılabilir (Windows / Linux): o zamana kadar düz saklanmış anahtarlar şifrelenir.
    try {
      settings.migratePlain();
      secrets.migratePlain();
    } catch (e) {
      console.error('[sonda] anahtarlar şifrelenemedi:', e.message);
    }
    // Açılıştaki son proje klasörü (yeni iş ekranında seçili gelir) izinli klasörlerdendir.
    folders.allow(settings.get().lastProjectDir);
    applyTheme();
    createWindow();
    app.on('activate', showWindow);
  });

  // Pencere kapanınca uygulama çıkar. (Çalışan iş varken pencereyi kapatmak onu yalnızca gizler — bkz. createWindow —
  // bu yüzden buraya çalışan işle gelinmez; macOS'ta yine de iş sürüyorsa uygulama açık kalır.)
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' || !runningOrchs().length) app.quit();
  });

  app.on('before-quit', (e) => {
    // ⌘Q / menüden çıkış pencerenin "kapat" sorusunu atlar: çalışan iş varsa burada sorulur.
    if (!quitting && runningOrchs().length && !confirmStopAll()) {
      e.preventDefault();
      return;
    }
    quitting = true;
    if (processesStopped) return;
    // Çalışan ajan / dev sunucusu süreçlerini geride bırakma; işi "durduruldu" olarak hemen kaydet ki bir sonraki
    // açılışta "Sürdür" ile kaldığı yerden devam edilebilsin. Çıkış, süreçler kapanana kadar (en fazla 2 sn) bekletilir;
    // SIGTERM'i yok sayanlar sonra SIGKILL ile kapatılır.
    e.preventDefault();
    for (const o of pool.values()) o.interrupt();
    devServer?.proc.kill();
    jobs.flushAll();
    runner.terminateAll(2000).finally(() => {
      processesStopped = true;
      jobs.flushAll();
      app.quit();
    });
  });
}
