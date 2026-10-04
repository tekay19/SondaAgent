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
  || /^\.(envrc|npmrc|netrc|pypirc)$/i.test(name)
  || /\.(pem|key|p12|pfx|jks|keystore|tfstate|tfvars)$/i.test(name)
  || /^id_(rsa|dsa|ecdsa|ed25519)$/i.test(name)
  || /^(secrets|service-account|credentials)(\.[\w-]+)?\.json$/i.test(name);
// İşletim sistemi ve araç artıkları.
const isJunk = (name) => name === '.DS_Store' || name === 'Thumbs.db' || name.endsWith('.tsbuildinfo') || name.endsWith('.log');

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

/** .git klasörünün dosyaları (geçmişi pakete katmak için aynen alınır). */
function gitDirFiles(root) {
  const files = [];
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
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
 * Git geçmişi pakete girebilir mi? Girmemesi gereken durumlar: uzak depo adresinde kimlik bilgisi,
 * geçmişte commit'lenmiş gizli dosya (.env vb.) ya da geçmişte kullanıcının gizli bir değeri.
 * Dönen: null (temiz) ya da kullanıcıya gösterilecek neden.
 */
async function historyProblem(root, needles, signal) {
  try {
    const cfg = fs.readFileSync(path.join(root, '.git', 'config'), 'utf8');
    if (/:\/\/[^/\s@]+@/.test(cfg)) return 'uzak depo adresinde kimlik bilgisi var';
  } catch {
    return 'git yapılandırması okunamadı';
  }
  let secretFile = null;
  const names = await git(root, ['-c', 'core.quotePath=false', 'log', '--all', '--pretty=format:', '--name-only'], {
    signal,
    onStdout: (line) => {
      if (!secretFile && line && isSecretFile(path.posix.basename(line.trim()))) secretFile = line.trim();
    },
  });
  // Henüz commit yoksa (boş depo) `git log` hata verir: geçmiş yok, sorun da yok.
  if (secretFile) return `geçmişte gizli dosya commit'lenmiş (${secretFile})`;
  if (names.code !== 0 || !needles?.length) return null;
  let leaked = false;
  const scan = runner.start({
    command: gitBin(),
    args: ['log', '--all', '-p', '--no-color', '--no-ext-diff', '-U0'],
    cwd: root,
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
  if (leaked) return 'geçmişte gizli bir değer commit\'lenmiş';
  if (res.timedOut) return 'geçmiş taranamadı (çok büyük)';
  return null;
}

// Dosyanın içinde kullanıcının gizli değerlerinden biri geçiyor mu? (İkili ve çok büyük dosyalar taranmaz.)
function containsNeedle(file, needles) {
  if (!needles?.length) return false;
  try {
    if (fs.statSync(file).size > 5 * 1024 * 1024) return false;
    const text = fs.readFileSync(file, 'utf8');
    return needles.some((n) => text.includes(n));
  } catch {
    return false;
  }
}

/**
 * Pakete girecek dosyalar (proje köküne göre göreli yollar) ve dışarıda bırakılanların dökümü.
 * needles: kullanıcının gizli değerleri — içinde geçen dosyalar pakete girmez.
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
    if (containsNeedle(full, needles)) {
      leaked.push(rel);
      continue;
    }
    files.push(rel);
  }
  let gitExcluded = null;
  if (includeGit && tracked) {
    gitExcluded = await historyProblem(root, needles, signal);
    if (!gitExcluded) files.push(...gitDirFiles(root));
  }
  return { files, skippedSecrets, leaked, gitIncluded: !!(includeGit && tracked && !gitExcluded), gitExcluded };
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
  if (!found.files.length) throw new Error('Paketlenecek dosya bulunamadı.');
  try {
    fs.unlinkSync(target);
  } catch {
    /* yoktu */
  }

  let r;
  if (IS_WIN) {
    // Windows 10+ ile gelen bsdtar: -a uzantıya göre zip üretir, -T dosya listesini okur; yollar korunur.
    const listFile = path.join(os.tmpdir(), `sonda-zip-${process.pid}-${Date.now()}.txt`);
    fs.writeFileSync(listFile, found.files.join('\n'), 'utf8');
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    r = await runner.run({ command: fs.existsSync(tar) ? tar : 'tar.exe', args: ['-a', '-c', '-f', target, '-C', root, '-T', listFile], cwd: root, signal, timeoutMs: 20 * 60 * 1000, tailSize: 4000 });
    try {
      fs.unlinkSync(listFile);
    } catch {
      /* geçici */
    }
  } else {
    const zipBin = findExecutable('zip');
    if (!zipBin) throw new Error('`zip` komutu bulunamadı.');
    // Dosya adları stdin'den (-@): boşluk/özel karakterler güvenli, komut satırı uzunluk sınırı yok.
    r = await runner.run({ command: zipBin, args: ['-q', '-X', '-@', target], cwd: root, input: found.files.join('\n'), signal, timeoutMs: 20 * 60 * 1000, tailSize: 4000 });
  }
  if (r.code !== 0) throw new Error(`Zip oluşturulamadı: ${(r.stderr || r.stdout || r.error || '').slice(-500)}`);
  const size = fs.statSync(target).size;
  return { file: target, size, count: found.files.length, skippedSecrets: found.skippedSecrets, leaked: found.leaked, gitIncluded: found.gitIncluded, gitExcluded: found.gitExcluded };
}

module.exports = { zipProject, collect, safeName };
