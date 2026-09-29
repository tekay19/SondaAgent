// İş geçmişi: userData/jobs/<id>/{job.json, logs.jsonl, shots/*.jpg}
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const root = () => path.join(app.getPath('userData'), 'jobs');
const dirOf = (id) => path.join(root(), String(id).replace(/[^\w-]/g, ''));

const saveTimers = new Map();

function save(job, { immediate = false } = {}) {
  const write = () => {
    saveTimers.delete(job.id);
    fs.mkdirSync(dirOf(job.id), { recursive: true });
    fs.writeFileSync(path.join(dirOf(job.id), 'job.json'), JSON.stringify(job, null, 1));
  };
  clearTimeout(saveTimers.get(job.id));
  if (immediate) write();
  else saveTimers.set(job.id, setTimeout(write, 400));
}

const logBuffers = new Map();
function appendLog(jobId, entry) {
  let buf = logBuffers.get(jobId);
  if (!buf) {
    buf = [];
    logBuffers.set(jobId, buf);
    setTimeout(() => {
      logBuffers.delete(jobId);
      fs.mkdirSync(dirOf(jobId), { recursive: true });
      fs.appendFile(path.join(dirOf(jobId), 'logs.jsonl'), buf.map((e) => JSON.stringify(e)).join('\n') + '\n', () => {});
    }, 300);
  }
  buf.push(entry);
}

function saveShot(jobId, name, jpeg) {
  const d = path.join(dirOf(jobId), 'shots');
  fs.mkdirSync(d, { recursive: true });
  const file = path.join(d, name);
  fs.writeFileSync(file, jpeg);
  return file;
}

function list() {
  let ids = [];
  try {
    ids = fs.readdirSync(root());
  } catch {
    return [];
  }
  const out = [];
  for (const id of ids) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dirOf(id), 'job.json'), 'utf8'));
      out.push({ id: j.id, idea: j.idea, title: j.plan?.projectName || null, phase: j.phase, createdAt: j.createdAt, projectDir: j.projectDir, agent: j.agent });
    } catch {
      /* bozuk kayıt */
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

function load(id, { maxLogs = 4000 } = {}) {
  const job = JSON.parse(fs.readFileSync(path.join(dirOf(id), 'job.json'), 'utf8'));
  let logs = [];
  try {
    const lines = fs.readFileSync(path.join(dirOf(id), 'logs.jsonl'), 'utf8').trim().split('\n');
    logs = lines.slice(-maxLogs).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    /* log yok */
  }
  const shots = (job.shots || []).map((s) => {
    try {
      return { ...s, dataUrl: `data:image/jpeg;base64,${fs.readFileSync(s.file).toString('base64')}` };
    } catch {
      return s;
    }
  });
  return { job: { ...job, shots }, logs };
}

function remove(id) {
  fs.rmSync(dirOf(id), { recursive: true, force: true });
}

module.exports = { save, appendLog, saveShot, list, load, remove };
