// İş geçmişi: userData/jobs/<id>/{job.json, logs.jsonl, shots/*.jpg}
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./fsx');

let rootOverride = null; // testler için
const root = () => rootOverride || path.join(app.getPath('userData'), 'jobs');

// İş kimliği: "<zaman>-<rastgele>" (ör. mun446n8-df5a49). Boş ya da biçimsiz bir kimlik asla klasör yoluna
// çevrilmez: aksi halde "" kimliği jobs kökünü gösterir ve silme bütün geçmişi götürür.
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{5,63}$/;
const validId = (id) => typeof id === 'string' && ID_RE.test(id);
function dirOf(id) {
  if (!validId(id)) throw new Error('Geçersiz iş kimliği.');
  return path.join(root(), id);
}

const saveTimers = new Map();
const removed = new Set(); // silinen işler: gecikmeli yazma onları geri getirmesin

// Geçmiş listesi önbelleği: özetler bir kez diskten okunur, sonra her kayıtta ve silmede bellekte güncellenir.
// (Liste her iş olayında istenir; her seferinde tüm job.json dosyalarını okumak ana süreci kilitliyordu.)
let summaries = null; // Map(id → özet)
const summaryOf = (j) => ({ id: j.id, idea: j.idea, title: j.plan?.projectName || null, phase: j.phase, createdAt: j.createdAt, projectDir: j.projectDir, agent: j.agent, kind: j.kind || null });

function writeJob(job) {
  saveTimers.delete(job.id);
  if (removed.has(job.id)) return;
  fs.mkdirSync(dirOf(job.id), { recursive: true });
  writeFileAtomic(path.join(dirOf(job.id), 'job.json'), JSON.stringify(job, null, 1));
  summaries?.set(job.id, summaryOf(job));
}

function save(job, { immediate = false } = {}) {
  clearTimeout(saveTimers.get(job.id)?.timer);
  if (immediate) return writeJob(job);
  const timer = setTimeout(() => {
    // Zamanlayıcıdaki hata (disk dolu, izin) yakalanmazsa ana süreç düşerdi; bir sonraki kayıt yeniden dener.
    try {
      writeJob(job);
    } catch (e) {
      console.error(`[sonda] iş kaydı yazılamadı (${job.id}): ${e.message}`);
    }
  }, 400);
  saveTimers.set(job.id, { job, timer });
}

// Loglar kısa aralıklarla toplu yazılır; yazmalar iş başına sıraya alınır (satır sırası bozulmaz).
const logBuffers = new Map(); // jobId → { buf, timer }
const logQueues = new Map(); // jobId → Promise
const logFile = (id) => path.join(dirOf(id), 'logs.jsonl');
const serialize = (entries) => entries.map((e) => JSON.stringify(e)).join('\n') + '\n';

function appendLog(jobId, entry) {
  if (removed.has(jobId)) return;
  let b = logBuffers.get(jobId);
  if (!b) {
    b = { buf: [], timer: setTimeout(() => flushLogs(jobId), 300) };
    logBuffers.set(jobId, b);
  }
  b.buf.push(entry);
}

function flushLogs(jobId, { sync = false } = {}) {
  const b = logBuffers.get(jobId);
  if (!b) return;
  clearTimeout(b.timer);
  logBuffers.delete(jobId);
  if (!b.buf.length || removed.has(jobId)) return;
  const text = serialize(b.buf);
  try {
    fs.mkdirSync(dirOf(jobId), { recursive: true });
    if (sync) return fs.appendFileSync(logFile(jobId), text);
  } catch {
    return; // log yazılamadıysa iş durmaz
  }
  const prev = logQueues.get(jobId) || Promise.resolve();
  const next = prev.then(() => (removed.has(jobId) ? null : fs.promises.appendFile(logFile(jobId), text))).catch(() => {});
  logQueues.set(jobId, next);
  next.then(() => {
    if (logQueues.get(jobId) === next) logQueues.delete(jobId);
  });
}

// Uygulama kapanırken: bekleyen tüm kayıtları (iş durumu ve loglar) eşzamanlı olarak diske yaz.
function flushAll() {
  for (const { job, timer } of [...saveTimers.values()]) {
    clearTimeout(timer);
    try {
      writeJob(job);
    } catch {
      /* en iyi çaba */
    }
  }
  for (const id of [...logBuffers.keys()]) flushLogs(id, { sync: true });
}

function saveShot(jobId, name, jpeg) {
  const d = path.join(dirOf(jobId), 'shots');
  fs.mkdirSync(d, { recursive: true });
  const file = path.join(d, path.basename(String(name)));
  fs.writeFileSync(file, jpeg);
  return file;
}

function readJob(id) {
  return JSON.parse(fs.readFileSync(path.join(dirOf(id), 'job.json'), 'utf8'));
}

function list() {
  if (!summaries) {
    let ids;
    try {
      ids = fs.readdirSync(root());
    } catch {
      return []; // kök henüz yok: bir sonraki çağrıda yeniden bakılır
    }
    summaries = new Map();
    for (const id of ids) {
      if (!validId(id)) continue;
      try {
        const j = readJob(id);
        if (j?.id === id) summaries.set(id, summaryOf(j));
      } catch {
        /* bozuk kayıt */
      }
    }
  }
  return [...summaries.values()].sort((a, b) => b.createdAt - a.createdAt);
}

// Dosyanın sonundaki en çok `maxLines` satır: dosya sondan parça parça okunur (en çok `maxBytes`), tamamı belleğe
// alınmaz. Baştaki yarım satır (ve bölünmüş olabilecek UTF-8 karakteri) atılır.
function tailLines(file, maxLines, maxBytes = 16 * 1024 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return [];
  }
  try {
    const parts = [];
    let pos = fs.fstatSync(fd).size;
    let newlines = 0;
    let read = 0;
    while (pos > 0 && newlines <= maxLines && read < maxBytes) {
      const len = Math.min(256 * 1024, pos);
      pos -= len;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, pos);
      parts.unshift(buf);
      read += len;
      for (let i = 0; i < len; i++) if (buf[i] === 10) newlines++;
    }
    let text = Buffer.concat(parts).toString('utf8');
    if (pos > 0) text = text.slice(text.indexOf('\n') + 1);
    return text.split('\n').filter(Boolean).slice(-maxLines);
  } finally {
    fs.closeSync(fd);
  }
}

// Diske yazılmış loglar (dosyanın sonu) + henüz yazılmamış (bellekteki) satırlar.
function readLogs(id, maxLogs = 4000) {
  const logs = tailLines(logFile(id), maxLogs)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const pending = logBuffers.get(id)?.buf || [];
  return pending.length ? [...logs, ...pending].slice(-maxLogs) : logs;
}

// Ekran görüntüleri arayüze veri adresi olarak gider; yalnızca işin kendi klasöründeki dosyalar okunur.
function withShotData(id, shots) {
  const dir = path.join(dirOf(id), 'shots');
  return (shots || []).map((s) => {
    try {
      const file = path.join(dir, path.basename(String(s.file || '')));
      return { ...s, dataUrl: `data:image/jpeg;base64,${fs.readFileSync(file).toString('base64')}` };
    } catch {
      return s;
    }
  });
}

function load(id, { maxLogs = 4000 } = {}) {
  const job = readJob(id);
  return { job: { ...job, shots: withShotData(id, job.shots) }, logs: readLogs(id, maxLogs) };
}

// Aynı klasörde planı olan en son iş (bakım işleri bu planı ve gereksinimleri devralır).
// Önce gerçekten uygulanmış işler (en az bir görevi bitmiş): onaylanmadan iptal edilen bir planın
// gereksinimleri koda girmediği için devralınmaz. Hiçbiri yoksa planı olan en son iş.
function latestWithPlan(projectDir, exceptId) {
  const target = path.resolve(String(projectDir || ''));
  let fallback = null;
  for (const j of list()) {
    if (j.id === exceptId || !j.projectDir || path.resolve(j.projectDir) !== target) continue;
    try {
      const job = readJob(j.id);
      if (!job.plan || !(job.tasks || []).length) continue;
      if (job.tasks.some((t) => t.status === 'done')) return job;
      if (!fallback && !job.kind) fallback = job;
    } catch {
      /* bozuk kayıt */
    }
  }
  return fallback;
}

function remove(id) {
  const dir = dirOf(id);
  removed.add(id);
  clearTimeout(saveTimers.get(id)?.timer);
  saveTimers.delete(id);
  clearTimeout(logBuffers.get(id)?.timer);
  logBuffers.delete(id);
  summaries?.delete(id);
  fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = { save, appendLog, saveShot, list, load, read: readJob, readLogs, withShotData, latestWithPlan, remove, flushAll, validId, _setRoot: (dir) => {
  rootOverride = dir;
  summaries = null;
} };
