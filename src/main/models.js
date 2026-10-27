// Claude model kataloğu: varsayılan model ve Ayarlar'da sunulan seçenekler.
// Kullanıcı Ayarlar'da başka bir model seçmediyse planlama, kodlama ve incelemelerin hepsi Opus 5.5 ile çalışır.
const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';

const CLAUDE_MODELS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5', note: 'en güçlü; planlama, kodlama ve inceleme için önerilen' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1', note: 'en yeni üst seviye model' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', note: 'daha hızlı, daha zayıf' },
];

// Ayarlardaki değer boşsa (ya da yalnızca boşluksa) varsayılan model kullanılır.
const claudeModelOf = (settings) => String(settings?.claudeModel || '').trim() || DEFAULT_CLAUDE_MODEL;

// Teknik brifleri yazan model. Brif, görevden önce kodu gezerek yazılır; kullanıcı tercihi: Claude Fable 5.1.
const BRIEF_MODEL = 'claude-fable-5-1';
// briefModel ayarı doluysa o; yoksa briefBy: "fable" → Fable 5.1, "coder" → kodlama modeli. Claude kurulu değilse brifi
// yönetici yazar (bkz. orchestrator/task.js).
const briefModelOf = (settings) => String(settings?.briefModel || '').trim() || (settings?.briefBy === 'coder' ? claudeModelOf(settings) : BRIEF_MODEL);

// Rol başına Claude modeli: planlayıcı (şartname + görev planı + plan eleştirisi), kodlayıcı (görev, düzeltme, TDD),
// inceleyici (ilk inceleme, derin inceleme, uzmanlar, doğrulama, hafıza, denetim), brif. Rolün ayarı boşsa genel model.
const ROLES = ['planner', 'coder', 'reviewer', 'brief'];
const roleModelOf = (settings, role) => {
  if (role === 'brief') return briefModelOf(settings);
  const own = ROLES.includes(role) ? String(settings?.[`${role}Model`] || '').trim() : '';
  return own || claudeModelOf(settings);
};

// Kullanıcıya gösterilecek ad: "Opus 5.5"; katalogda yoksa kimliğin kendisi.
const claudeModelLabel = (id) => CLAUDE_MODELS.find((m) => m.id === id)?.label || String(id || '');

// Codex'in bu rolde kullanacağı model. NIM sağlayıcısında rol başına NIM modeli (brif inceleyici modelini alır), boşsa
// yöneticinin NIM modeli; Codex model alanı (OpenAI / yerel model adı) NIM'de HİÇ kullanılmaz: sağlayıcı değiştirilince
// orada kalan eski ad NIM'e gönderilmesin. Diğer sağlayıcılarda Codex model alanı (boş = Codex varsayılanı).
const NIM_ROLE_KEY = { planner: 'nimPlannerModel', coder: 'nimCoderModel', reviewer: 'nimReviewerModel', brief: 'nimReviewerModel' };
const codexModelFor = (settings, role) => {
  if (settings?.codexProvider !== 'nim') return String(settings?.codexModel || '').trim();
  const key = NIM_ROLE_KEY[role];
  return String((key && settings?.[key]) || '').trim() || String(settings?.nimModel || '').trim();
};

module.exports = { DEFAULT_CLAUDE_MODEL, CLAUDE_MODELS, BRIEF_MODEL, ROLES, claudeModelOf, claudeModelLabel, briefModelOf, roleModelOf, codexModelFor };
