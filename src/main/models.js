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
// briefBy: "fable" → Fable 5.1 · "coder" → kodlama modeli (Ayarlar'daki Claude modeli) · "gemini" → Gemini yazar (null).
const briefModelOf = (settings) => (settings?.briefBy === 'gemini' ? null : settings?.briefBy === 'coder' ? claudeModelOf(settings) : BRIEF_MODEL);

// Kullanıcıya gösterilecek ad: "Opus 5.5"; katalogda yoksa kimliğin kendisi.
const claudeModelLabel = (id) => CLAUDE_MODELS.find((m) => m.id === id)?.label || String(id || '');

module.exports = { DEFAULT_CLAUDE_MODEL, CLAUDE_MODELS, BRIEF_MODEL, claudeModelOf, claudeModelLabel, briefModelOf };
