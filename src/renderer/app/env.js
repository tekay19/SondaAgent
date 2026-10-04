// Anahtarlar (.env) penceresi.
import { stIcon, api, $, esc, state, toast, attempt, ico } from './core.js';
import { refreshJobEnv } from './history.js';
import { refreshComposeEnv } from './compose.js';

// ---------- Anahtarlar (.env) ----------
// Değerler yalnızca kullanıcı yazarken arayüzde bulunur; kayıtlı değerler maskeli gelir.
const envDlg = $('#envDialog');

async function openEnv(dir) {
  const v = await attempt(() => api.getEnv(dir));
  if (!v) return;
  state.envDir = dir;
  state.env = v;
  state.envPending = { set: {}, remove: new Set() };
  $('#envDir').textContent = dir;
  $('#envDir').title = dir;
  $('#envNewName').value = '';
  $('#envNewValue').value = '';
  $('#envPaste').value = '';
  renderEnv();
  envDlg.showModal();
  // İlk eksik değerin kutusuna odaklan; yoksa hiçbir düğme odakta başlamasın.
  const first = v.required.find((r) => r.needs && !r.set);
  if (first) $(`[data-env-input="${CSS.escape(first.name)}"]`, envDlg)?.focus();
  else document.activeElement?.blur();
}

function envRow(item) {
  const pend = state.envPending;
  const removed = pend.remove.has(item.name);
  const changed = item.name in pend.set;
  const chip = removed
    ? '<span class="env-state">silinecek</span>'
    : changed
      ? '<span class="env-state changed">değişti</span>'
      : item.set
        ? `<span class="env-state set">${stIcon('done')} kayıtlı</span>`
        : item.needs
          ? '<span class="env-state missing">gerekli</span>'
          : item.optional
            ? '<span class="env-state">isteğe bağlı</span>'
            : '<span class="env-state" title="Girmezsen projenin varsayılanı kullanılır">varsayılan</span>';
  const ph = item.set
    ? `kayıtlı: ${item.masked} — değiştirmek için yazın`
    : item.example && !item.needs && !item.optional
      ? `varsayılan: ${item.example}`
      : item.example
        ? `örn. ${item.example}`
        : 'değer girin';
  return `<div class="env-row ${removed ? 'removed' : ''}">
      <div class="env-name">${esc(item.name)}</div>
      <input type="password" data-env-input="${esc(item.name)}" value="${esc(changed ? pend.set[item.name] : '')}" placeholder="${esc(ph)}" spellcheck="false" autocomplete="off" ${removed ? 'disabled' : ''} />
      <div class="env-actions">${chip}
        <button type="button" class="icon-btn" data-env-eye="${esc(item.name)}" title="Göster / gizle" aria-label="Değeri göster">${ico('eye')}</button>
        ${item.set || changed ? `<button type="button" class="icon-btn" data-env-del="${esc(item.name)}" title="${removed ? 'Geri al' : 'Sil'}" aria-label="${removed ? 'Geri al' : 'Sil'}">${removed ? ico('undo') : ico('x')}</button>` : ''}
      </div>
      ${item.hint ? `<div class="env-hint" title="${esc(item.hint)}">${esc(item.hint)}</div>` : ''}</div>`;
}

// Projenin istedikleri, .env.example'daki bölümlere göre gruplanır ("Database", "Telephony"…).
function envGroups(items) {
  let last = null;
  return items
    .map((it) => {
      const head = it.section && it.section !== last ? `<div class="env-group">${esc(it.section)}</div>` : '';
      last = it.section;
      return head + envRow(it);
    })
    .join('');
}

function renderEnv() {
  const v = state.env;
  const pend = state.envPending;
  const reqNames = new Set(v.required.map((r) => r.name));
  const extraNames = new Set(v.extra.map((e) => e.name));
  const added = Object.keys(pend.set)
    .filter((n) => !reqNames.has(n) && !extraNames.has(n))
    .map((n) => ({ name: n, set: false, masked: '' }));
  const extra = [...v.extra, ...added];
  const missing = v.required.filter((r) => r.needs && !r.set && !(r.name in pend.set)).length;
  const notes = [];
  if (!v.projectReady) notes.push('Proje henüz kurulmadı; değerler ilk görevden sonra <code>.env</code> dosyasına yazılır.');
  if (!v.encrypted) notes.push('Bu sistemde işletim sistemi şifrelemesi yok; değerler Sonda ayar klasöründe düz metin saklanır.');
  $('#envNotice').innerHTML = notes.join('<br>');
  $('#envNotice').hidden = !notes.length;
  $('#envRequired').innerHTML = v.required.length
    ? `<div class="env-section"><div class="sec-title">Projenin istedikleri <span class="count">${esc(v.exampleFile)} · ${missing ? `${missing} gerekli değer eksik` : 'gerekenlerin hepsi girildi'}</span></div><div class="env-list">${envGroups(v.required)}</div></div>`
    : `<div class="env-section"><div class="sec-title">Projenin istedikleri</div><div class="hint">${v.projectReady ? 'Projede henüz <code>.env.example</code> yok.' : 'Proje kurulunca <code>.env.example</code> anahtarları burada listelenir.'}</div></div>`;
  $('#envExtra').innerHTML = extra.length ? `<div class="env-section"><div class="sec-title">Eklediklerin</div><div class="env-list">${extra.map(envRow).join('')}</div></div>` : '';
  const n = Object.keys(pend.set).length + pend.remove.size;
  $('#envPending').textContent = n ? `${n} değişiklik kaydedilmedi` : '';
}

const envForm = $('#envForm');
envForm.addEventListener('input', (e) => {
  const inp = e.target.closest('[data-env-input]');
  if (!inp) return;
  const name = inp.dataset.envInput;
  if (inp.value) state.envPending.set[name] = inp.value;
  else delete state.envPending.set[name];
  const n = Object.keys(state.envPending.set).length + state.envPending.remove.size;
  $('#envPending').textContent = n ? `${n} değişiklik kaydedilmedi` : '';
});
envForm.addEventListener('change', (e) => {
  if (e.target.closest('[data-env-input]')) renderEnv();
});
envForm.addEventListener('click', (e) => {
  const eye = e.target.closest('[data-env-eye]');
  if (eye) {
    const inp = eye.closest('.env-row').querySelector('input');
    inp.type = inp.type === 'password' ? 'text' : 'password';
    return;
  }
  const del = e.target.closest('[data-env-del]');
  if (del) {
    const name = del.dataset.envDel;
    const pend = state.envPending;
    const stored = state.env.required.some((r) => r.name === name && r.set) || state.env.extra.some((x) => x.name === name);
    if (name in pend.set && !stored) delete pend.set[name];
    else if (pend.remove.has(name)) pend.remove.delete(name);
    else {
      delete pend.set[name];
      pend.remove.add(name);
    }
    renderEnv();
  }
});
// Enter formu (ve pencereyi) kapatmasın; ekleme alanında "Ekle" gibi davranır.
envForm.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
  e.preventDefault();
  if (e.target.id === 'envNewName' || e.target.id === 'envNewValue') $('#envAddBtn').click();
});

function addEnvPending(name, value) {
  const n = String(name || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) {
    toast(`Geçersiz ad: "${n}". Harf, rakam ve _ kullanın; rakamla başlamasın.`, true);
    return false;
  }
  state.envPending.set[n] = value;
  state.envPending.remove.delete(n);
  return true;
}
$('#envAddBtn').addEventListener('click', () => {
  const name = $('#envNewName').value;
  const value = $('#envNewValue').value;
  if (!name.trim()) return toast('Anahtarın adını yazın (ör. STRIPE_SECRET_KEY).', true);
  if (!value) return toast('Değeri yazın.', true);
  if (!addEnvPending(name, value)) return;
  $('#envNewName').value = '';
  $('#envNewValue').value = '';
  renderEnv();
  $('#envNewName').focus();
});
$('#envPasteBtn').addEventListener('click', async () => {
  // Ana süreç metni dotenv kurallarıyla çözer: tırnaklar, çok satırlı değerler (ör. PEM anahtarı), yorumlar.
  const parsed = (await attempt(() => api.parseEnv($('#envPaste').value))) || {};
  let added = 0;
  for (const [name, v] of Object.entries(parsed)) if (v && addEnvPending(name, v)) added++;
  if (!added) return toast('Satırlar ADI=değer biçiminde olmalı.', true);
  $('#envPaste').value = '';
  renderEnv();
  toast(`${added} anahtar eklendi. Kaydetmeyi unutmayın.`);
});
$('#envSaveBtn').addEventListener('click', async (e) => {
  e.preventDefault();
  const pend = state.envPending;
  if (!Object.keys(pend.set).length && !pend.remove.size) return envDlg.close();
  const r = await attempt(() => api.saveEnv({ dir: state.envDir, set: pend.set, remove: [...pend.remove] }));
  if (!r) return;
  state.envPending = { set: {}, remove: new Set() };
  envDlg.close();
  toast(r.written?.length ? `Kaydedildi · ${r.written.join(', ')} güncellendi` : r.projectReady ? 'Kaydedildi' : 'Kaydedildi · proje kurulunca .env dosyasına yazılacak');
  if (state.envDir === state.compose.projectDir) refreshComposeEnv();
  if (state.job && state.envDir === state.job.projectDir) refreshJobEnv();
});
envDlg.addEventListener('close', () => {
  state.envPending = { set: {}, remove: new Set() };
});

export { openEnv };
