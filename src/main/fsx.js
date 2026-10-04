// Dosya yardımcıları (Electron'dan bağımsız, test edilebilir).
const fs = require('fs');
const path = require('path');

/**
 * Dosyayı atomik yazar: önce aynı klasörde geçici dosyaya, sonra yeniden adlandırma.
 * Yazma yarıda kesilirse (çökme, elektrik kesintisi, uygulamanın kapatılması) eski dosya bozulmadan kalır;
 * yarım yazılmış bir job.json / settings.json / secrets.json yüzünden kayıt kaybolmaz.
 */
function writeFileAtomic(file, data, options) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now().toString(36)}.tmp`);
  try {
    fs.writeFileSync(tmp, data, options);
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* geçici dosya hiç oluşmamış olabilir */
    }
    // Windows: hedef başka bir süreçte açıkken (ör. antivirüs taraması) yeniden adlandırma reddedilebilir.
    if (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES') return fs.writeFileSync(file, data, options);
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

// `child`, `root` klasörünün içinde mi (ya da kendisi mi)? Sembolik bağlar çözülmez.
function isInside(child, root) {
  const r = path.resolve(root);
  const c = path.resolve(child);
  return c === r || c.startsWith(r + path.sep);
}

module.exports = { writeFileAtomic, readJson, isInside };
