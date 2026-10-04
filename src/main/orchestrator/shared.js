// Orkestratör parçalarının ortak sabitleri ve yardımcıları.
const P = require('../prompts');

const ACTIVE_TASK = new Set(['running', 'verifying', 'reviewing', 'fixing']);
// Model çıktısındaki çift kaçışlı satır sonlarını ("\\n") gerçek satır sonuna çevirir.
const cleanText = (t) => String(t ?? '').replace(/(?:\\r)?\\n/g, '\n').replace(/\\t/g, ' ').trim();
// İstek Türkçe yazıldıysa teşhis ve görev başlıkları da Türkçe yazılır.
const guessLang = (text) => (/[ğüşıöçĞÜŞİÖÇ]/.test(String(text || '')) ? 'Turkish' : null);
const SEVERE = new Set(['critical', 'high']);
// Kalite puanı 1–10 aralığında tam sayıdır; model başka bir şey döndürdüyse (85, 0, "9/10") düzeltilir.
const clampScore = (v) => {
  const n = Math.round(parseFloat(v));
  return Number.isFinite(n) && n > 0 ? Math.max(1, Math.min(10, n)) : null;
};
const PANEL_LABELS = { ...Object.fromEntries(Object.entries(P.SPECIALISTS).map(([k, v]) => [k, v.label])), manager: 'İlk inceleme', audit: 'Bağımsız denetim' };

// Parça sınıfının yöntemlerini (get/set dahil) hedef sınıfın prototipine ekler.
function mixin(target, part) {
  for (const name of Object.getOwnPropertyNames(part.prototype)) {
    if (name !== 'constructor') Object.defineProperty(target.prototype, name, Object.getOwnPropertyDescriptor(part.prototype, name));
  }
}

module.exports = { ACTIVE_TASK, cleanText, guessLang, SEVERE, clampScore, PANEL_LABELS, mixin };
