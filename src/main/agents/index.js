// Kodlama ajanı adaptörleri: Claude Code ve OpenAI Codex CLI.
// Her adaptör komut satırı argümanlarını kurar ve JSON olay akışını
// arayüz için normalleştirilmiş log satırlarına çevirir.
// Konularına göre bölünmüştür; bu dosya modülün dış arayüzünü (dışa aktarılan adları) korur:
//   adapters.js — Ajan adaptörleri: araç izinleri, çıktı ayrıştırıcıları (stream-json → günlük) ve komut satırı.
//   install.js — Ajan CLI'sinin bulunması, sürümü, kurulumu ve güncellenmesi.
//   detect.js — Ajanların durumu: kurulu mu, giriş yapılmış mı, hangi plan — ve canlı bağlantı denetimi.
//   run.js — Ajan oturumu: ortam, çalıştırma, yapılandırılmış çıktı ve şemaya uygunluk.
const { DEFAULT_CLAUDE_MODEL } = require('../models');
const adapters = require('./adapters');
const install = require('./install');
const detect = require('./detect');
const run = require('./run');

module.exports = {
  agentRunEnv: run.agentRunEnv,
  ADAPTERS: adapters.ADAPTERS,
  CODE_TOOLS: adapters.CODE_TOOLS,
  DEFAULT_CLAUDE_MODEL,
  detect: detect.detect,
  authInfo: detect.authInfo,
  runAgent: run.runAgent,
  resolveBin: install.resolveBin,
  install: install.install,
  update: install.update,
  installKind: install.installKind,
  cmpVersion: install.cmpVersion,
  parseResetAt: adapters.parseResetAt,
  rememberLiveCheck: detect.rememberLiveCheck,
  jsonFromText: run.jsonFromText,
  conforms: run.conforms,
  failureKind: run.failureKind,
  REVIEW_ALLOWED: adapters.REVIEW_ALLOWED,
  ENV_DENY: adapters.ENV_DENY,
  AUTH_ERROR: adapters.AUTH_ERROR,
  NETWORK_ERROR: adapters.NETWORK_ERROR,
};
