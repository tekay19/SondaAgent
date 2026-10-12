// Projeyi teslim paketi olarak zipler: kaynak kod, testler, dokümanlar ve (temizse) git geçmişi içeride;
// bağımlılıklar, derleme çıktıları ve HER TÜRLÜ gizli dosya dışarıda (yeniden üretilebilir ya da gizli).
// Git deposunda dosya listesi git'ten alınır (.gitignore'a uyar); değilse klasör taranır.
const fs = require('fs');
const os = require('os');
const path = require('path');
const runner = require('./runner');
const { IS_WIN, findExecutable, agentEnv } = require('./env');

// Yeniden üretilebilir klasörler (npm install / build ile geri gelir) — git deposu olmayan projelerde.
const SKIP_DIRS = new Set(['node_modules', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '.parcel-cache', 'dist', 'build', 'out', 'coverage', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', 'target', '.gradle', '.vercel', '.netlify', 'tmp', 'temp']);

// Gizli değer taşıyan dosyalar: her düzeyde ve git'te izleniyor olsalar bile pakete girmez.
const ENV_EXAMPLE = /^\.env\.(example|sample|template|dist)$/i;
const isSecretFile = (name) =>
  (/^\.env([._-].*)?$/i.test(name) && !ENV_EXAMPLE.test(name))
  || /^\.(envrc|npmrc|netrc|pypirc|git-credentials)$/i.test(name)
  || /^credentials$/i.test(name) // AWS
  || /\.(pem|key|p8|p12|pfx|jks|keystore|tfstate|tfvars)$/i.test(name)
  || /^id_(rsa|dsa|ecdsa|ed25519)$/i.test(name)
  || /^(secrets|service-account|credentials)(\.[\w-]+)?\.json$/i.test(name)
  || /firebase-adminsdk.*\.json$/i.test(name);
// İşletim sistemi ve araç artıkları; yerel veritabanları (kullanıcı verisi taşıyabilir, migrate / seed ile geri gelir).
const isJunk = (name) => name === '.DS_Store' || name === 'Thumbs.db' || name.endsWith('.tsbuildinfo') || name.endsWith('.log')
  || /\.(sqlite3?|db)(-journal|-wal|-shm)?$/i.test(name);

const safeName = (s) => String(s || 'proje').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'proje';
const gitBin = () => findExecutable('git');
const git = (root, args, extra = {}) => runner.run({ command: gitBin(), args, cwd: root, env: agentEnv({ GIT_TERMINAL_PROMPT: '0' }), timeoutMs: 60000, tailSize: 4000, ...extra });

/** Klasörü tarayarak pakete girecek dosyaları listeler (git deposu olmayan projeler). */
function walkFiles(root) {
  const files = [];
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name === '.git') continue;
        walk(path.join(dir, e.name), r);
      } else if (e.isFile()) {
        files.push(r);
      }
    }
  };
  walk(root, '');
  return files;
}

/** Git'in izlediği ve yok saymadığı dosyalar (çalışma ağacındaki halleriyle). Depo değilse null. */
async function gitFiles(root, signal) {
  if (!gitBin() || !fs.existsSync(path.join(root, '.git'))) return null;
  const out = [];
  let buf = '';
  const r = await git(root, ['-c', 'core.quotePath=false', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    signal,
    onStdout: (line) => {
      buf += `${line}\n`;
    },
  });
  if (r.code !== 0) return null;
  for (const f of buf.split('\0')) {
    const name = f.replace(/^\n+|\n+$/g, '');
    if (name) out.push(name);
  }
  return [...new Set(out)];
}

/**
 * .git klasörünün dosyaları ve boş klasörleri. Boş klasörler de girer: dallar `packed-refs` içindeyken `refs/heads`
 * boştur, ama git klasörü depo saymak için `refs` ister.
 */
function gitDirFiles(root) {
  const files = [];
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (!entries.length) files.push(rel);
    for (const e of entries) {
      const r = `${rel}/${e.name}`;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (e.isFile()) files.push(r);
    }
  };
  walk(path.join(root, '.git'), '.git');
  return files;
}

/**
 * Pakete girecek git geçmişi. Kullanıcının .git klasörü olduğu gibi kopyalanmaz: reflog'da kalan (amend / reset ile
 * değiştirilmiş) commit'ler ve sahipsiz nesneler (sahnelenip geri alınmış dosyalar, ör. Sonda'nın commit taramasının
 * dışarıda bıraktıkları) eski gizli değerleri taşır. Bunun yerine geçici bir klasöre yalnızca dalların ve etiketlerin
 * ulaştığı nesnelerle temiz bir kopya alınır ve tarama bu kopyada yapılır: taranan = pakete giren. Uzak depo adresleri
 * (kimlik bilgisi taşıyabilir) ve yerel klasör yolu kopyaya girmez.
 * Dönen: { gitRoot } (kopyanın üst klasörü; `.git` onun içinde) ya da { problem } (kullanıcıya gösterilecek neden).
 * Kopya alınamaz ya da taranamazsa geçmiş pakete girmez.
 */
async function cleanHistory(root, needles, signal) {
  if ((await git(root, ['rev-parse', '--verify', '-q', 'HEAD'], { signal })).code !== 0) return { problem: 'depoda henüz commit yok' };
  const gitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sonda-zip-git-'));
  const gitDir = path.join(gitRoot, '.git');
  const fail = (problem) => {
    removeDir(gitRoot);
    return { problem };
  };
  const inClone = (args, extra = {}) => git(gitRoot, ['--git-dir', gitDir, ...args], { signal, ...extra });
  try {
    // --no-local: yerel kopyalama kısayolu yerine git aktarımı; yalnızca referansların ulaştığı nesneler paketlenir.
    if ((await git(root, ['clone', '--quiet', '--bare', '--no-local', '--', root, gitDir], { signal, timeoutMs: 10 * 60000 })).code !== 0) {
      return fail('geçmiş kopyalanamadı');
    }
    const remotes = await inClone(['remote']);
    if (remotes.code !== 0) return fail('geçmiş kopyalanamadı');
    // Açılan paket normal bir çalışma deposu olsun: çıplak değil, uzak depo kaydı yok, dizini (index) HEAD'e göre kurulu.
    const setup = [['config', 'core.bare', 'false'], ...remotes.stdout.split('\n').filter(Boolean).map((r) => ['remote', 'remove', r.trim()]), ['read-tree', 'HEAD']];
    for (const args of setup) if ((await inClone(args)).code !== 0) return fail('geçmiş kopyalanamadı');
    let secretFile = null;
    const names = await inClone(['-c', 'core.quotePath=false', 'log', '--all', '--diff-merges=first-parent', '--pretty=format:', '--name-only'], {
      onStdout: (line) => {
        if (!secretFile && line && isSecretFile(path.posix.basename(line.trim()))) secretFile = line.trim();
      },
    });
    if (secretFile) return fail(`geçmişte gizli dosya commit'lenmiş (${secretFile})`);
    if (names.code !== 0) return fail('geçmiş taranamadı');
    if (!needles?.length) return { gitRoot };
    let leaked = false;
    const scan = runner.start({
      command: gitBin(),
      args: ['--git-dir', gitDir, 'log', '--all', '--diff-merges=first-parent', '-p', '--no-color', '--no-ext-diff', '--no-textconv', '-U0'],
      cwd: gitRoot,
      env: agentEnv({ GIT_TERMINAL_PROMPT: '0' }),
      signal,
      timeoutMs: 90000,
      tailSize: 1000,
      onStdout: (line) => {
        if (leaked || line[0] !== '+') return;
        if (needles.some((n) => line.includes(n))) {
          leaked = true;
          scan.kill();
        }
      },
    });
    const res = await scan.done;
    if (leaked) return fail('geçmişte gizli bir değer commit\'lenmiş');
    if (res.timedOut) return fail('geçmiş taranamadı (çok büyük)');
    if (res.code !== 0) return fail('geçmiş taranamadı');
    return { gitRoot };
  } catch (err) {
    removeDir(gitRoot);
    throw err;
  }
}

function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* geçici klasör: işletim sistemi temizler */
  }
}

// Dosyanın içinde kullanıcının gizli değerlerinden biri (herhangi bir biçimiyle) geçiyor mu? Dosya parça parça okunur:
// boyut sınırı yok ve parça sınırına denk gelen değer de bulunur (her parçaya bir öncekinin sonu eklenir).
const CHUNK = 1024 * 1024;
async function containsNeedle(file, needles) {
  if (!needles?.length) return false;
  const bufs = needles.map((n) => Buffer.from(n, 'utf8'));
  const overlap = Math.max(...bufs.map((b) => b.length)) - 1;
  const buf = Buffer.alloc(CHUNK + overlap);
  let fh;
  try {
    fh = await fs.promises.open(file, 'r');
    let carry = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, carry, CHUNK, null);
      if (!bytesRead) return false;
      const filled = carry + bytesRead;
      const view = buf.subarray(0, filled);
      if (bufs.some((b) => view.includes(b))) return true;
      carry = Math.min(overlap, filled);
      buf.copy(buf, 0, filled - carry, filled);
    }
  } catch {
    return false;
  } finally {
    await fh?.close();
  }
}

/**
 * Pakete girecek dosyalar ve dışarıda bırakılanların dökümü. `files`: proje köküne göre göreli yollar; geçmiş girerse
 * sonlarında `.git/…` yolları (bunlar `gitRoot` klasörüne göredir — temiz kopya, bkz. cleanHistory). `gitRoot` geçici
 * klasördür: zipProject işi bitince siler.
 * needles: kullanıcının gizli değerleri (tüm biçimleriyle) — içinde geçen dosyalar pakete girmez.
 */
async function collect(root, { includeGit = true, needles = [], signal } = {}) {
  const tracked = await gitFiles(root, signal);
  const candidates = tracked || walkFiles(root);
  const files = [];
  const leaked = [];
  let skippedSecrets = 0;
  for (const rel of candidates) {
    const name = path.posix.basename(rel);
    const full = path.join(root, rel);
    let st;
    try {
      st = fs.lstatSync(full);
    } catch {
      continue; // depoda kayıtlı ama diskte yok
    }
    if (!st.isFile()) continue; // sembolik bağlar proje dışını gösterebilir
    if (isSecretFile(name)) {
      skippedSecrets++;
      continue;
    }
    if (isJunk(name)) continue;
    if (await containsNeedle(full, needles)) {
      leaked.push(rel);
      continue;
    }
    files.push(rel);
  }
  let gitExcluded = null;
  let gitRoot = null;
  if (includeGit && tracked) {
    const h = await cleanHistory(root, needles, signal);
    if (h.problem) gitExcluded = h.problem;
    else {
      gitRoot = h.gitRoot;
      files.push(...gitDirFiles(gitRoot));
    }
  }
  return { files, skippedSecrets, leaked, gitIncluded: !!gitRoot, gitExcluded, gitRoot };
}

/**
 * Projeyi zipler. Dönen: { file, size, count, skippedSecrets, leaked, gitIncluded, gitExcluded }.
 * macOS/Linux: `zip` (dosya listesi stdin'den); Windows: sistemle gelen `tar.exe` (klasör yapısını korur).
 */
async function zipProject(projectDir, { outDir, name, target: targetPath, includeGit = true, needles = [], signal } = {}) {
  const root = path.resolve(projectDir);
  if (!fs.existsSync(root)) throw new Error('Proje klasörü bulunamadı.');
  const base = safeName(name || path.basename(root));
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const target = targetPath ? path.resolve(targetPath) : path.join(outDir || path.dirname(root), `${base}-${stamp}.zip`);
  if (target.startsWith(root + path.sep)) throw new Error('Zip dosyası projenin kendi klasörüne kaydedilemez; başka bir yer seçin.');
  const found = await collect(root, { includeGit, needles, signal });
  try {
    if (!found.files.length) throw new Error('Paketlenecek dosya bulunamadı.');
    try {
      fs.unlinkSync(target);
    } catch {
      /* yoktu */
    }
    // Proje dosyaları proje klasöründen, geçmiş (`.git/…`) temiz kopyanın klasöründen (bkz. cleanHistory) alınır.
    const own = found.files.filter((f) => !f.startsWith('.git/'));
    const history = found.gitRoot ? found.files.filter((f) => f.startsWith('.git/')) : [];
    const opts = { signal, timeoutMs: 20 * 60 * 1000, tailSize: 4000 };
    let r;
    if (IS_WIN) {
      // Windows 10+ ile gelen bsdtar: -a uzantıya göre zip üretir, -T dosya listesini okur; yollar korunur. Listede tek
      // başına "-C" satırı, sonraki satırdaki klasöre geçer (geçmiş başka klasörden gelir).
      const listFile = path.join(os.tmpdir(), `sonda-zip-${process.pid}-${Date.now()}.txt`);
      const list = [...own.filter((f) => f !== '-C'), ...(history.length ? ['-C', found.gitRoot, ...history] : [])];
      fs.writeFileSync(listFile, list.join('\n'), 'utf8');
      const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
      try {
        r = await runner.run({ command: fs.existsSync(tar) ? tar : 'tar.exe', args: ['-a', '-c', '-f', target, '-C', root, '-T', listFile], cwd: root, ...opts });
      } finally {
        try {
          fs.unlinkSync(listFile);
        } catch {
          /* geçici */
        }
      }
    } else {
      const zipBin = findExecutable('zip');
      if (!zipBin) throw new Error('`zip` komutu bulunamadı.');
      // Dosya adları stdin'den (-@): boşluk/özel karakterler güvenli, komut satırı uzunluk sınırı yok. İkinci çağrı
      // geçmişi aynı arşive ekler.
      r = await runner.run({ command: zipBin, args: ['-q', '-X', '-@', target], cwd: root, input: own.join('\n'), ...opts });
      if (r.code === 0 && history.length) r = await runner.run({ command: zipBin, args: ['-q', '-X', '-@', target], cwd: found.gitRoot, input: history.join('\n'), ...opts });
    }
    if (r.code !== 0) throw new Error(`Zip oluşturulamadı: ${(r.stderr || r.stdout || r.error || '').slice(-500)}`);
    const size = fs.statSync(target).size;
    return { file: target, size, count: found.files.length, skippedSecrets: found.skippedSecrets, leaked: found.leaked, gitIncluded: found.gitIncluded, gitExcluded: found.gitExcluded };
  } finally {
    if (found.gitRoot) removeDir(found.gitRoot);
  }
}

module.exports = { zipProject, collect, safeName };
