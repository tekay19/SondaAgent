const { app, BrowserWindow, ipcMain, dialog, shell, Notification, powerSaveBlocker, nativeTheme } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { fixPath, findExecutable } = require('./env');
const settings = require('./settings');
const gemini = require('./gemini');
const agents = require('./agents');
const docs = require('./docs');
const jobs = require('./jobs');
const verify = require('./verify');
const secrets = require('./secrets');
const { Orchestrator } = require('./orchestrator');

// Uygulama adı: ayarlar klasörü (~/Library/Application Support/Sonda Agent) ve şifreli anahtarın
// anahtar zinciri kaydı bu ada bağlıdır. İlk sürümün ("Orkestra") verileri bir kez taşınır;
// eski şifreli anahtar yeni adla çözülemeyeceği için Gemini anahtarı yeniden istenir.
app.setName('Sonda Agent');
(() => {
  const current = app.getPath('userData');
  const legacy = path.join(app.getPath('appData'), 'Orkestra');
  if (!fs.existsSync(current) && fs.existsSync(legacy)) {
    try {
      fs.cpSync(legacy, current, { recursive: true });
      // Eski adla şifrelenmiş anahtar yeni adla çözülemez; taşıma.
      const file = path.join(current, 'settings.json');
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      delete data.geminiKeyEnc;
      fs.writeFileSync(file, JSON.stringify(data, null, 2));
    } catch {
      /* taşınamazsa temiz başla */
    }
  }
})();
fixPath();

const ACTIVE_PHASES = new Set(['planning', 'running', 'verifying', 'testing', 'reviewing', 'fixing', 'reporting']);
const NOTIFY = {
  awaiting_answers: ['Birkaç sorum var', 'Gemini ürün tanımını çıkardı; planı netleştirmek için cevaplarınızı bekliyor.'],
  awaiting_approval: ['Plan hazır', 'Gemini planı hazırladı; onayınızı bekliyor.'],
  done: ['Teslime hazır', 'Testler, güvenlik ve son kabul geçti; rapor hazır.'],
  incomplete: ['Teslime hazır değil', 'Son kabulde açık sorunlar kaldı; düzeltmeye devam edebilirsiniz.'],
  failed: ['İş hata ile durdu', 'Ayrıntılar için Sonda Agent\'a bakın.'],
};

let win = null;
let lastPhase = null;
let quitting = false;
let sleepBlocker = null;

function send(evt) {
  if (win && !win.isDestroyed()) win.webContents.send('sonda:event', evt);
}

const orch = new Orchestrator({
  emit: (evt) => {
    send(evt);
    if (evt.type === 'job' && evt.job.phase !== lastPhase) {
      lastPhase = evt.job.phase;
      const n = NOTIFY[lastPhase];
      if (n && Notification.isSupported() && !win?.isFocused()) {
        const note = new Notification({ title: `Sonda Agent · ${n[0]}`, body: `${evt.job.plan?.projectName || evt.job.idea.slice(0, 60)} — ${n[1]}` });
        note.on('click', () => win?.show());
        note.show();
      }
    }
    // Uzun işlerde bilgisayarın uykuya geçip ajanı yarıda kesmesini engelle.
    if (evt.type === 'busy') {
      if (evt.busy && sleepBlocker == null) sleepBlocker = powerSaveBlocker.start('prevent-app-suspension');
      if (!evt.busy && sleepBlocker != null) {
        powerSaveBlocker.stop(sleepBlocker);
        sleepBlocker = null;
      }
    }
  },
});

// ---------- "Uygulamayı çalıştır" ----------
let devServer = null; // { proc, url, dir }
orch.appRunningFor = (dir) => !!devServer && path.resolve(devServer.dir) === path.resolve(dir);
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

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 660,
    title: 'Sonda Agent',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b0d12' : '#f6f7f9',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
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

  // İş çalışırken pencere kapatılırsa sor: arka planda sürsün mü, durup kapansın mı?
  win.on('close', (e) => {
    if (!orch.running || quitting) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Arka planda devam et', 'Durdur ve kapat', 'Vazgeç'],
      defaultId: 0,
      cancelId: 2,
      message: 'Bir iş hâlâ çalışıyor.',
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

handle('settings:get', () => settings.getPublic());
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

// ---------- Anahtarlar (.env) ----------
// Arayüze yalnızca maskeli değerler gider. Kaydedince değerler projenin .env dosyasına yazılır.
handle('env:get', (dir) => secrets.view(dir));
handle('env:save', ({ dir, set, remove }) => {
  secrets.update(dir, { set, remove });
  const written = secrets.sync(dir);
  if (orch.job && path.resolve(orch.job.projectDir) === path.resolve(dir)) {
    orch.job.env = secrets.summary(dir);
    orch.update();
  }
  return { ...secrets.view(dir), written: written.map((f) => path.relative(dir, f) || '.env') };
});
handle('gemini:models', () => gemini.listModels({ apiKey: settings.get().geminiKey }));
handle('gemini:test', async () => {
  const s = settings.get();
  const text = await gemini.generate({ apiKey: s.geminiKey, model: s.geminiModel, parts: [{ text: 'Reply with exactly: OK' }], temperature: 0 });
  return { model: s.geminiModel, reply: text.trim().slice(0, 50) };
});
handle('agents:detect', (opts) => agents.detect(settings.get(), opts || {}));
// CLI güncelleme (Homebrew / resmi yükleyici / npm). Çalışan bir ajan oturumu yarıda kalmasın diye iş sürerken yapılmaz.
handle('agents:update', (agentId) => {
  if (orch.running) throw new Error('Şu anda çalışan bir iş var. Güncellemeyi iş bitince ya da durdurunca yapın.');
  return agents.update(agentId, settings.get());
});
// Ajanın kurulu VE oturum açmış olduğunu küçük bir istemle doğrular.
handle('agents:test', async (agentId) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonda-test-'));
  const s = { ...settings.get(), claudeEffort: '', agentTimeoutMin: 3 };
  const logs = [];
  try {
    const r = await agents.runAgent({ agentId, settings: s, cwd: dir, prompt: 'Reply with exactly the word OK and nothing else. Do not use any tools.', onLog: (l) => logs.push(l.text) });
    agents.rememberLiveCheck(agentId, s, r.ok);
    if (!r.ok) throw new Error(r.error);
    return { reply: (r.text || '').trim().slice(0, 80) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Ajanın giriş akışını kullanıcının terminalinde açar (tarayıcıda giriş yapılır).
// Claude için abonelik ya da Anthropic Console (API faturalı) girişi sorulur.
handle('agents:login', (agentId) => {
  const adapter = agents.ADAPTERS[agentId];
  const bin = agents.resolveBin(agentId, settings.get());
  if (!bin) throw new Error(`${adapter.label} bulunamadı. Kurulum: ${adapter.install}`);
  const tmp = os.tmpdir();
  if (process.platform === 'win32') {
    const q = `"${bin}"`;
    const script = agentId === 'claude'
      ? `@echo off\r\necho Sonda Agent - Claude Code girisi\r\necho 1) Claude aboneligi (Pro/Max)\r\necho 2) Anthropic Console (API faturali)\r\nset /p c=Seciminiz [1/2]: \r\nif "%c%"=="2" (${q} auth login --console) else (${q} auth login --claudeai)\r\n${q} auth status\r\necho Giris tamamlandiysa Sonda Agent'ta "Tekrar kontrol et"e basin.\r\npause\r\n`
      : `@echo off\r\n${q} login\r\npause\r\n`;
    const file = path.join(tmp, `sonda-${agentId}-login.cmd`);
    fs.writeFileSync(file, script);
    spawn('cmd.exe', ['/c', 'start', '""', 'cmd', '/k', file], { detached: true, stdio: 'ignore' }).unref();
    return true;
  }
  const q = `'${bin.replace(/'/g, `'\\''`)}'`;
  const body = agentId === 'claude'
    ? `echo "Sonda Agent · Claude Code girişi"\necho "  1) Claude aboneliği (Pro/Max)"\necho "  2) Anthropic Console (API faturalı)"\nread "c?Seçiminiz [1/2]: "\nif [ "$c" = "2" ]; then ${q} auth login --console; else ${q} auth login --claudeai; fi\necho\n${q} auth status\necho\necho "Giriş tamamlandıysa bu pencereyi kapatıp Sonda Agent'ta 'Tekrar kontrol et'e basın."\n`
    : `${q} login\n`;
  const file = path.join(tmp, `sonda-${agentId}-login.command`);
  fs.writeFileSync(file, `#!/bin/zsh -l\ncd ~\n${body}`, { mode: 0o755 });
  if (process.platform === 'darwin') return shell.openPath(file);
  spawn('x-terminal-emulator', ['-e', file], { detached: true, stdio: 'ignore' }).unref();
  return true;
});

handle('dialog:folder', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Proje klasörü seçin',
    properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
    defaultPath: settings.get().lastProjectDir || app.getPath('documents'),
  });
  return r.canceled ? null : r.filePaths[0];
});
handle('dialog:docs', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Teknik doküman ekle', properties: ['openFile', 'multiSelections'], filters: docs.FILTERS });
  return r.canceled ? [] : r.filePaths.map(docs.inspect);
});
handle('docs:inspect', (paths) => (paths || []).filter((p) => fs.existsSync(p) && fs.statSync(p).isFile()).map(docs.inspect));
handle('shell:open', (p) => shell.openPath(p));
handle('shell:external', (url) => (/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(url) ? shell.openExternal(url) : null));
handle('shell:editor', (dir) => {
  const code = findExecutable('code') || findExecutable('cursor');
  if (!code) return shell.openPath(dir);
  spawn(code, [dir], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' }).unref();
  return true;
});
handle('app:run', (args) => runApp(typeof args === 'string' ? { dir: args } : args));
handle('app:stop', () => stopApp());
handle('app:status', () => (devServer ? { state: 'running', url: devServer.url, dir: devServer.dir } : { state: 'stopped' }));

handle('job:plan', (args) => orch.startPlanning(args));
handle('job:replan', ({ feedback }) => orch.replan(feedback));
handle('job:answer', (answers) => orch.answerQuestions(answers));
handle('job:approve', (args) => orch.approve(args));
handle('job:resume', () => orch.resume());
handle('job:continueFinal', () => orch.continueFinal());
handle('job:stop', () => orch.stop());
handle('job:note', (text) => orch.addNote(text));
handle('job:current', () => ({ job: orch.snapshot(), busy: orch.running }));
handle('jobs:list', () =>
  jobs.list().map((j) =>
    ACTIVE_PHASES.has(j.phase) && !(orch.running && orch.job?.id === j.id) ? { ...j, phase: 'stopped', interrupted: true } : j
  )
);
handle('jobs:load', (id) => {
  if (orch.job?.id === id && orch.running) return { job: orch.snapshot(), logs: jobs.load(id).logs, live: true };
  const data = jobs.load(id);
  // Uygulama kapanırken yarıda kalmış iş: "durduruldu" olarak işaretle ki sürdürülebilsin.
  if (ACTIVE_PHASES.has(data.job.phase)) {
    data.job.phase = 'stopped';
    for (const t of data.job.tasks || []) if (!['done', 'skipped', 'failed', 'pending'].includes(t.status)) t.status = 'pending';
  }
  if (!orch.running) {
    const { shots, ...rest } = data.job;
    orch.adopt({ ...rest, shots: (shots || []).map(({ dataUrl, ...s }) => s) });
    jobs.save(orch.job, { immediate: true });
  }
  return data;
});
handle('jobs:delete', (id) => {
  if (orch.job?.id === id && orch.running) throw new Error('Çalışan iş silinemez.');
  jobs.remove(id);
  if (orch.job?.id === id) orch.job = null;
  return true;
});

app.whenReady().then(() => {
  if (process.platform === 'win32') app.setAppUserModelId('com.semih.sonda-agent');
  applyTheme();
  createWindow();
  app.on('activate', () => {
    if (win && !win.isDestroyed()) win.show();
    else createWindow();
  });
});

// macOS geleneği: pencere kapanınca uygulama çalışmaya devam eder (Dock'tan açılır).
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || !orch.running) app.quit();
});

app.on('before-quit', () => {
  quitting = true;
  // Çalışan ajan / dev sunucusu süreçlerini geride bırakma; işi "durduruldu" olarak hemen kaydet
  // ki bir sonraki açılışta "Sürdür" ile kaldığı yerden devam edilebilsin.
  orch.interrupt();
  devServer?.proc.kill();
});
