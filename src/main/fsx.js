// Dosya yardımcıları (Electron'dan bağımsız, test edilebilir).
const fs = require('fs');
const path = require('path');

/**
 * Dosyayı atomik yazar: önce aynı klasörde geçici dosyaya, sonra yeniden adlandırma.
 * Yazma yarıda kesilirse (çökme, elektrik kesintisi, uygulamanın kapatılması) eski dosya bozulmadan kalır;
 * yarım yazılmış bir job.json / settings.json / secrets.json yüzünden kayıt kaybolmaz.
 */
const LOCKED = new Set(['EPERM', 'EBUSY', 'EACCES']);
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function writeFileAtomic(file, data, options) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now().toString(36)}.tmp`);
  try {
    fs.writeFileSync(tmp, data, options);
    // Windows: hedef başka bir süreçte kısa süre açıkken (ör. antivirüs taraması) yeniden adlandırma reddedilebilir;
    // birkaç kez beklenip yeniden denenir. Yerinde yazmak son çaredir: yarıda kalırsa dosya bozulur.
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, file);
        return;
      } catch (err) {
        if (!LOCKED.has(err.code) || attempt >= 4) throw err;
        pause(25 * 2 ** attempt);
      }
    }
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* geçici dosya hiç oluşmamış olabilir */
    }
    if (LOCKED.has(err.code)) return fs.writeFileSync(file, data, options);
    throw err;
  }
}

/** JSON dosyasını okur; yoksa ya da bozuksa `fallback` döner. */
function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * Kayıt dosyasını okur. Dosya yoksa `null`. Okunamıyor ya da JSON bozuksa dosya `<ad>.bozuk-<zaman>` olarak kenara alınır
 * ve `null` döner: bir sonraki kayıt bozuk dosyanın üzerine yazıp içindeki (ör. diğer projelerin) değerleri silmesin.
 */
function readStore(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    const data = JSON.parse(text);
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  } catch {
    /* aşağıda kenara alınır */
  }
  const backup = `${file}.bozuk-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.renameSync(file, backup);
  console.error(`[sonda] ${path.basename(file)} okunamadı; ${path.basename(backup)} olarak kenara alındı.`);
  return null;
}

// `child`, `root` klasörünün içinde mi (ya da kendisi mi)? Sembolik bağlar çözülmez.
function isInside(child, root) {
  const r = path.resolve(root);
  const c = path.resolve(child);
  return c === r || c.startsWith(r + path.sep);
}

module.exports = { writeFileAtomic, readJson, readStore, isInside };
