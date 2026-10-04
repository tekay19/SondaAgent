// Doğrulama: kurulum/lint/test/build komutları, geliştirme sunucusu ile canlı test
// ve gizli bir tarayıcı penceresiyle ekran görüntüsü + konsol hatası toplama.
// Konularına göre bölünmüştür; bu dosya modülün dış arayüzünü (dışa aktarılan adları) korur:
//   checks.js — Doğrulama komutları: kurulum, lint, tip kontrolü, test, derleme; bağımlılık güvenlik taraması.
//   browser.js — Tarayıcı testi: geliştirme sunucusu, yalıtılmış gizli pencere, ekran görüntüsü, sayfa denetimleri.
//   fresh-clone.js — Temiz klon denetimi: commit'li proje sıfırdan kurulup test edilebiliyor mu.
const checks = require('./checks');
const browser = require('./browser');
const freshClone = require('./fresh-clone');

module.exports = {
  runChecks: checks.runChecks,
  runSmoke: browser.runSmoke,
  planChecks: checks.planChecks,
  startDevServer: browser.startDevServer,
  dependencyAudit: checks.dependencyAudit,
  captureFile: browser.captureFile,
  freshCloneCheck: freshClone.freshCloneCheck,
  frozenInstall: freshClone.frozenInstall,
  probeProblems: browser.probeProblems,
  PROBE_JS: browser.PROBE_JS,
};
