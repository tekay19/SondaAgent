// Ana süreç ↔ arayüz yardımcıları (Electron'dan bağımsız, test edilebilir).
const path = require('path');

/**
 * İş olaylarını seyreltir. Her güncelleme işin tamamını taşır ve arayüz görünümü yeniden çizer; bir görev sırasında
 * saniyede onlarca güncelleme olabilir. Aynı işin kısa aralıktaki güncellemelerinden yalnızca sonuncusu gönderilir.
 * Aşama değişikliği beklemeden gider (bekleyen eski güncelleme atılır: yenisi onu kapsar).
 */
function jobEventThrottle(send, { delayMs = 120 } = {}) {
  const pending = new Map(); // id → { evt, timer }
  const phases = new Map(); // id → son gönderilen aşama
  const drop = (id) => {
    const p = pending.get(id);
    if (p) clearTimeout(p.timer);
    pending.delete(id);
    return p;
  };
  const fire = (id) => {
    const p = drop(id);
    if (p) send(p.evt);
  };
  return {
    push(evt) {
      const id = evt?.job?.id;
      if (!id) return send(evt);
      if (evt.job.phase !== phases.get(id)) {
        phases.set(id, evt.job.phase);
        drop(id);
        return send(evt);
      }
      const p = pending.get(id);
      if (p) p.evt = evt;
      else pending.set(id, { evt, timer: setTimeout(() => fire(id), delayMs) });
    },
    flush() {
      for (const id of [...pending.keys()]) fire(id);
    },
    forget(id) {
      drop(id);
      phases.delete(id);
    },
  };
}

/**
 * Arayüzden gelen klasör yolları için izin listesi: kullanıcının bu oturumda seçtiği klasörler, açılıştaki son klasör
 * ve kayıtlı işlerin klasörleri. Arayüz ele geçirilse bile rastgele bir klasörün .env dosyası okunamaz / yazılamaz,
 * orada iş başlatılamaz.
 */
function folderGuard({ initial = [], known = () => [] } = {}) {
  const valid = (d) => typeof d === 'string' && path.isAbsolute(d);
  const key = (d) => (process.platform === 'win32' ? path.resolve(d).toLowerCase() : path.resolve(d));
  const allowed = new Set(initial.filter(valid).map(key));
  return {
    allow(dir) {
      if (valid(dir)) allowed.add(key(dir));
    },
    check(dir) {
      if (!valid(dir)) throw new Error('Önce proje klasörünü seçin.');
      const k = key(dir);
      if (allowed.has(k) || known().some((d) => valid(d) && key(d) === k)) return path.resolve(dir);
      throw new Error('Bu klasör seçilmemiş; önce "Klasör seç" ile proje klasörünü seçin.');
    },
  };
}

module.exports = { jobEventThrottle, folderGuard };
