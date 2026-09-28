# Sohbete Belge Ekleme — Uygulama Planı

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kullanıcı sohbete PDF/Word/metin belgesi ekler; Sonda soruya göre yalnız belgeden ya da belge + webden cevaplar ve belge kaynaklarını 📄 ile ayrı gösterir.

**Architecture:** Yeni `sonda/belge.py` metni sayfa/bölüm bilgisiyle çıkarır, `veri/belgeler/<id>.json`'a yazar ve soruya göre bağlam seçer (kısa belge tamamen, uzun belge `bge-m3` ile en yakın parçalar). `/api/belge` yükleme/silme uç noktalarıdır; `/api/sor` belge kimliklerini alır, `asistan.calistir` belgeleri yükleyip hızlı ve derin modlara geçirir. Belge parçaları mevcut `Kaynaklar` listesine `tur: "belge"` olarak girer; arayüz çip, uyarı ve kaynak çekmecesini gösterir.

**Tech Stack:** Python 3.11, FastAPI (`UploadFile`, `python-multipart` kurulu), `pypdf`, `python-docx` (kurulu 1.2.0, `requirements.txt`'e eklenecek), `numpy` + Ollama `bge-m3` (`sonda/web.py:embed`), tek dosyalık arayüz `static/index.html`, testler pytest + Playwright.

**Spec:** `docs/superpowers/specs/2026-09-28-belge-ekleme-design.md`

## Global Constraints

- Dosya türleri: `.pdf`, `.docx`, `.txt`, `.md` (uzantı ve içerik birlikte kontrol edilir).
- Dosya boyutu en çok 20 MB; sohbet başına en çok 5 belge; belge başına en çok 2.000.000 karakter (fazlası kesilir, `kesildi: true`).
- Bağlam sınırı: model adı `gemini:` ile başlıyorsa 60.000, değilse 15.000 karakter.
- Belge kimliği sunucuda `uuid4().hex` (32 küçük harf onaltılık); dosya yolu yalnızca bu biçimden kurulur.
- Orijinal dosya saklanmaz; yalnız çıkarılan metin `veri/belgeler/<id>.json`'a yazılır.
- Belge metni `hafiza.json`'a ve site hafızasına yazılmaz; görev modunda belge kullanılmaz.
- Kullanıcıya görünen bütün metinler Türkçe. Hata metinleri spec'teki gibi:
  - "Bu dosyayı okuyamadım: …"
  - "PDF şifreli; şifresini kaldırıp yeniden ekle."
  - "Bu PDF taranmış görünüyor; ilk sürümde okuyamıyorum."
- Gemini uyarısı: "Belgenin ilgili kısımları Gemini'ye gönderilir."
- Testler gerçek `veri/belgeler`'e yazmaz (conftest oturum boyu geçici klasöre yönlendirir).
- Komutlar Windows'ta proje kökünden: `.venv/Scripts/python -m pytest ...`.

## Review Focus

- Türkçe karakterli ya da yol içeren dosya adı (`../../x.pdf`, `Sözleşme ğüş.pdf`): ad yalnız gösterim için saklanır, dosya yolu kimlikten kurulur → Task 1 testi.
- Karışık PDF (bazı sayfaları taranmış, bazıları metinli): reddedilmez, metinli sayfalar okunur → Task 1 testi.
- Çok uzun belgede (binlerce parça) embedding'e giden parça sayısı sınırlı kalmalı, cevap dakikalarca beklememeli → Task 2 testi (embed'e en çok 200 parça).
- Takip sorusu: aynı sohbette ikinci soruda da belge kimlikleri gönderilir; önceki cevabın 📄 kaynağı (url `belge:`) yeni Kaynaklar'da numarasını korur → Task 3 ve Task 5 testleri.
- Windows'ta Not Defteri ile kaydedilmiş Türkçe `.txt` (cp1254) bozuk karakterle okunmamalı → Task 1 testi.

---

## Dosya yapısı

| Dosya | Sorumluluk |
|---|---|
| `sonda/belge.py` (yeni) | Metin çıkarma, doğrulama, kayıt/yükleme/silme, bağlam seçimi |
| `sonda/arastirma/kaynaklar.py` | `belge_ekle()`: belge parçasını numaralı kaynak yapar |
| `sonda/arastirma/promptlar.py` | Belge kuralları (sistem istemi), ön karar kuralı |
| `sonda/arastirma/belge_baglami.py` (yeni) | Hızlı/derin mod için ortak: bağlamı kaynaklara ekleyip istem bloğu üretir |
| `sonda/arastirma/hizli.py`, `derin.py` | `belgeler` parametresi |
| `sonda/asistan.py` | Belge kimliklerini yükleme, bulunamayanı bildirme, görev modunda yok sayma |
| `sonda/sunucu.py` | `POST /api/belge`, `DELETE /api/belge/{id}`, `Istek.belgeler` |
| `static/index.html` | Ataç, sürükle-bırak, çipler, uyarı, mesaj etiketi, 📄 kaynaklar, sohbet silinince belge silme |
| `tests/test_belge.py` (yeni), `tests/test_sunucu.py`, `tests/test_arayuz.py`, `tests/conftest.py` | Testler |
| `requirements.txt`, `docs/yol-haritasi.md` | Bağımlılık, durum |

---

### Task 1: Belge okuma ve saklama (`sonda/belge.py`)

**Files:**
- Create: `sonda/belge.py`
- Create: `tests/test_belge.py`
- Modify: `tests/conftest.py` (sona fixture), `requirements.txt` (`python-docx==1.2.0`)

**Interfaces:**
- Produces:
  - `class BelgeHatasi(Exception)`: Kullanıcıya gösterilecek Türkçe mesaj taşır.
  - `oku(ad: str, veri: bytes) -> dict`: Dönen sözlük `{"ad", "tur", "birim", "sayfalar": [{"no": int, "metin": str}], "karakter": int, "kesildi": bool}`. `birim` PDF için `"sayfa"`, diğerleri için `"bölüm"`. Sorun olursa `BelgeHatasi` fırlatır.
  - `kaydet(belge: dict) -> dict`: `id` ve `zaman` ekleyip yazar ve sözlüğü döner.
  - `yukle(kimlik: str) -> dict | None`: Kimlik geçersizse ya da dosya yoksa `None`.
  - `sil(kimlik: str) -> bool`
  - `ozet(belge) -> dict`: `{"id", "ad", "sayfa_sayisi", "karakter", "kesildi", "birim"}`
  - Sabitler: `KLASOR`, `EN_BUYUK_DOSYA`, `EN_FAZLA_KARAKTER`, `BOLUM`, `TURLER`.

- [ ] **Step 1: Test yardımcıları ve başarısız testleri yaz**

`tests/test_belge.py`:

```python
"""Sohbete eklenen belgeler: metin çıkarma, doğrulama, kayıt."""
import io

import pytest
from docx import Document
from pypdf import PdfReader, PdfWriter

from sonda import belge


def pdf_yap(sayfalar):
    """Her sayfası verilen (ASCII) metni içeren gerçek bir PDF üretir; boş metin = metinsiz (taranmış gibi) sayfa."""
    nesneler = ["<< /Type /Catalog /Pages 2 0 R >>", None,
                "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    kidler = []
    for metin in sayfalar:
        akis = f"BT /F1 12 Tf 72 720 Td ({metin}) Tj ET" if metin else ""
        nesneler.append(f"<< /Length {len(akis)} >>\nstream\n{akis}\nendstream")
        icerik_no = len(nesneler)
        nesneler.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
                        f"/Resources << /Font << /F1 3 0 R >> >> /Contents {icerik_no} 0 R >>")
        kidler.append(f"{len(nesneler)} 0 R")
    nesneler[1] = f"<< /Type /Pages /Kids [{' '.join(kidler)}] /Count {len(kidler)} >>"
    cikti, konumlar = b"%PDF-1.4\n", []
    for i, n in enumerate(nesneler, 1):
        konumlar.append(len(cikti))
        cikti += f"{i} 0 obj\n{n}\nendobj\n".encode("latin-1")
    xref = len(cikti)
    cikti += f"xref\n0 {len(nesneler) + 1}\n0000000000 65535 f \n".encode()
    cikti += "".join(f"{k:010d} 00000 n \n" for k in konumlar).encode()
    cikti += f"trailer\n<< /Size {len(nesneler) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF".encode()
    return cikti


def sifreli_pdf():
    w = PdfWriter()
    for s in PdfReader(io.BytesIO(pdf_yap(["gizli"]))).pages:
        w.add_page(s)
    w.encrypt("parola123")
    b = io.BytesIO()
    w.write(b)
    return b.getvalue()


def docx_yap(paragraflar):
    d = Document()
    for p in paragraflar:
        d.add_paragraph(p)
    b = io.BytesIO()
    d.save(b)
    return b.getvalue()


def test_pdf_sayfa_sayfa_okunur():
    b = belge.oku("sozlesme.pdf", pdf_yap(["Madde 1 kira bedeli aylik 20000 TL", "Madde 4 kira artisi yuzde 25 olarak uygulanir"]))
    assert b["tur"] == "pdf" and b["birim"] == "sayfa"
    assert [s["no"] for s in b["sayfalar"]] == [1, 2]
    assert "kira artisi" in b["sayfalar"][1]["metin"]


def test_karisik_pdf_metinli_sayfalari_okunur():
    b = belge.oku("karisik.pdf", pdf_yap(["Birinci sayfanin metni burada", "", "Ucuncu sayfanin metni burada", "Dorduncu sayfanin metni burada"]))
    assert [s["no"] for s in b["sayfalar"]] == [1, 3, 4]


def test_taranmis_pdf_reddedilir():
    with pytest.raises(belge.BelgeHatasi, match="taranmış"):
        belge.oku("tarama.pdf", pdf_yap(["", "", "", "", "kisa"]))


def test_sifreli_pdf_reddedilir():
    with pytest.raises(belge.BelgeHatasi, match="şifreli"):
        belge.oku("gizli.pdf", sifreli_pdf())


def test_docx_bolum_bolum_okunur():
    paragraflar = [f"Paragraf {i} " + "x" * 400 for i in range(20)]  # ~8000 karakter
    b = belge.oku("cv.docx", docx_yap(paragraflar))
    assert b["tur"] == "docx" and b["birim"] == "bölüm"
    assert len(b["sayfalar"]) >= 2 and all(len(s["metin"]) <= belge.BOLUM + 500 for s in b["sayfalar"])
    assert "Paragraf 0" in b["sayfalar"][0]["metin"]


@pytest.mark.parametrize("kodlama", ["utf-8", "cp1254"])
def test_turkce_txt_okunur(kodlama):
    b = belge.oku("not.txt", "Şişli'de ığdır çğü".encode(kodlama))
    assert b["sayfalar"][0]["metin"] == "Şişli'de ığdır çğü"


def test_md_okunur():
    assert belge.oku("oku.md", b"# Baslik\nmetin")["tur"] == "md"


@pytest.mark.parametrize("ad,veri", [("resim.png", b"\x89PNG...."), ("sahte.pdf", b"bu pdf degil"),
                                     ("sahte.docx", b"PK\x03\x04bozuk"), ("bos.txt", b"   ")])
def test_desteklenmeyen_ya_da_bozuk_dosya(ad, veri):
    with pytest.raises(belge.BelgeHatasi):
        belge.oku(ad, veri)


def test_buyuk_dosya_reddedilir(monkeypatch):
    monkeypatch.setattr(belge, "EN_BUYUK_DOSYA", 100)
    with pytest.raises(belge.BelgeHatasi, match="MB"):
        belge.oku("buyuk.txt", b"a" * 101)


def test_uzun_metin_kesilir(monkeypatch):
    monkeypatch.setattr(belge, "EN_FAZLA_KARAKTER", 1000)
    b = belge.oku("uzun.txt", ("kelime " * 1000).encode())
    assert b["kesildi"] is True and b["karakter"] <= 1000


def test_kaydet_yukle_sil():
    b = belge.kaydet(belge.oku("../../etc/Sözleşme ğüş.txt", "içerik".encode()))
    assert len(b["id"]) == 32 and b["ad"] == "Sözleşme ğüş.txt"  # ad yalnız gösterim; yol parçası atılır
    assert (belge.KLASOR / f"{b['id']}.json").exists()
    assert belge.yukle(b["id"])["sayfalar"][0]["metin"] == "içerik"
    assert belge.ozet(b) == {"id": b["id"], "ad": "Sözleşme ğüş.txt", "sayfa_sayisi": 1, "karakter": 6,
                             "kesildi": False, "birim": "bölüm"}
    assert belge.sil(b["id"]) is True and belge.yukle(b["id"]) is None


@pytest.mark.parametrize("kimlik", ["../ayarlar", "..\\x", "abc", "G" * 32, ""])
def test_gecersiz_kimlik_dosyaya_ulasmaz(kimlik):
    assert belge.yukle(kimlik) is None and belge.sil(kimlik) is False
```

`tests/conftest.py` sonuna:

```python
@pytest.fixture(autouse=True, scope="session")
def _gecici_belgeler(tmp_path_factory):
    """Yüklenen belgeler testlerde geçici klasöre yazılır (gerçek veri/belgeler kirlenmesin)."""
    from sonda import belge
    eski = belge.KLASOR
    belge.KLASOR = tmp_path_factory.mktemp("belgeler")
    yield
    belge.KLASOR = eski
```

- [ ] **Step 2: Testlerin başarısız olduğunu gör**

Run: `.venv/Scripts/python -m pytest tests/test_belge.py -q`
Expected: FAIL / ERROR — `ImportError: cannot import name 'belge' from 'sonda'`

- [ ] **Step 3: `sonda/belge.py` yaz (okuma ve saklama)**

```python
"""Sohbete eklenen belgeler: metni sayfa/bölüm bilgisiyle çıkarır, veri/belgeler/<id>.json'a yazar ve soruya göre
modele gidecek bağlamı seçer. Orijinal dosya saklanmaz. Belge metni kalıcı hafızaya yazılmaz."""
import io
import json
import re
import time
import uuid
from pathlib import Path, PureWindowsPath

from pypdf import PdfReader
from pypdf.errors import PdfReadError

KLASOR = Path(__file__).resolve().parent.parent / "veri" / "belgeler"
EN_BUYUK_DOSYA = 20 * 1024 * 1024
EN_FAZLA_KARAKTER = 2_000_000
BOLUM = 3000  # Word/metin belgelerinde sayfa yok: ~3000 karakterlik bölümler numaralanır
TURLER = {".pdf": "pdf", ".docx": "docx", ".txt": "txt", ".md": "md"}
_KIMLIK = re.compile(r"[0-9a-f]{32}")
_TARANMIS_ORAN = 0.2  # metinli sayfa oranı bunun altındaysa taranmış sayılır
_BOS_SAYFA = 20  # bu kadar karakterden kısa sayfa metinsiz sayılır


class BelgeHatasi(Exception):
    """Kullanıcıya olduğu gibi gösterilecek Türkçe mesaj taşır."""


def _pdf(veri):
    if not veri.startswith(b"%PDF"):
        raise BelgeHatasi("Bu dosyayı okuyamadım: geçerli bir PDF değil.")
    try:
        okuyucu = PdfReader(io.BytesIO(veri))
        if okuyucu.is_encrypted and not okuyucu.decrypt(""):
            raise BelgeHatasi("PDF şifreli; şifresini kaldırıp yeniden ekle.")
        ham = [(i, (s.extract_text() or "").strip()) for i, s in enumerate(okuyucu.pages, 1)]
    except BelgeHatasi:
        raise
    except (PdfReadError, ValueError, KeyError, TypeError) as h:
        raise BelgeHatasi(f"Bu dosyayı okuyamadım: {h}") from h
    dolu = [(i, m) for i, m in ham if len(m) >= _BOS_SAYFA]
    if not ham or len(dolu) < max(1, _TARANMIS_ORAN * len(ham)):
        raise BelgeHatasi("Bu PDF taranmış görünüyor; ilk sürümde okuyamıyorum.")
    return [{"no": i, "metin": m} for i, m in dolu]


def _bolumle(paragraflar):
    """Paragrafları ~BOLUM karakterlik bölümlere toplar (paragraf bölünmez; tek başına uzunsa kendi bölümüdür)."""
    bolumler, tampon = [], ""
    for p in paragraflar:
        if tampon and len(tampon) + len(p) > BOLUM:
            bolumler.append(tampon)
            tampon = ""
        tampon = f"{tampon}\n{p}" if tampon else p
    if tampon:
        bolumler.append(tampon)
    return [{"no": i, "metin": b} for i, b in enumerate(bolumler, 1)]


def _docx(veri):
    from docx import Document
    try:
        belge_ = Document(io.BytesIO(veri))
    except Exception as h:  # BadZipFile, PackageNotFoundError, KeyError...: hepsi "geçerli docx değil"
        raise BelgeHatasi("Bu dosyayı okuyamadım: geçerli bir Word (.docx) belgesi değil.") from h
    paragraflar = [p.text.strip() for p in belge_.paragraphs if p.text.strip()]
    for tablo in belge_.tables:  # sözleşme/CV tabloları da metne girsin
        for satir in tablo.rows:
            hucreler = [h.text.strip() for h in satir.cells if h.text.strip()]
            if hucreler:
                paragraflar.append(" | ".join(hucreler))
    return _bolumle(paragraflar)


def _metin(veri):
    for kodlama in ("utf-8-sig", "cp1254"):
        try:
            metin = veri.decode(kodlama)
            break
        except UnicodeDecodeError:
            continue
    else:
        raise BelgeHatasi("Bu dosyayı okuyamadım: metin kodlaması tanınmadı.")
    return _bolumle([p.strip() for p in re.split(r"\n\s*\n", metin) if p.strip()])


def oku(ad, veri):
    """Dosyadan belge sözlüğü üretir; sorun varsa BelgeHatasi."""
    ad = PureWindowsPath(str(ad or "belge")).name[:120] or "belge"  # yol parçası atılır, ad yalnız gösterim
    if len(veri) > EN_BUYUK_DOSYA:
        raise BelgeHatasi(f"Dosya çok büyük: en çok {EN_BUYUK_DOSYA // (1024 * 1024)} MB eklenebilir.")
    tur = TURLER.get(Path(ad).suffix.lower())
    if tur is None:
        raise BelgeHatasi("Bu dosyayı okuyamadım: yalnızca PDF, Word (.docx), .txt ve .md desteklenir.")
    sayfalar = _pdf(veri) if tur == "pdf" else _docx(veri) if tur == "docx" else _metin(veri)
    if not sayfalar:
        raise BelgeHatasi("Bu dosyayı okuyamadım: belgede metin yok.")
    kalan, kesildi, sinirli = EN_FAZLA_KARAKTER, False, []
    for s in sayfalar:
        if kalan <= 0:
            kesildi = True
            break
        if len(s["metin"]) > kalan:
            s, kesildi = {**s, "metin": s["metin"][:kalan]}, True
        sinirli.append(s)
        kalan -= len(s["metin"])
    return {"ad": ad, "tur": tur, "birim": "sayfa" if tur == "pdf" else "bölüm", "sayfalar": sinirli,
            "karakter": sum(len(s["metin"]) for s in sinirli), "kesildi": kesildi}


def _yol(kimlik):
    return KLASOR / f"{kimlik}.json" if isinstance(kimlik, str) and _KIMLIK.fullmatch(kimlik) else None


def kaydet(belge):
    belge = {**belge, "id": uuid.uuid4().hex, "zaman": int(time.time())}
    KLASOR.mkdir(parents=True, exist_ok=True)
    _yol(belge["id"]).write_text(json.dumps(belge, ensure_ascii=False), encoding="utf-8")
    return belge


def yukle(kimlik):
    yol = _yol(kimlik)
    if yol is None:
        return None
    try:
        return json.loads(yol.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None


def sil(kimlik):
    yol = _yol(kimlik)
    if yol is None or not yol.exists():
        return False
    yol.unlink(missing_ok=True)
    return True


def ozet(belge):
    return {"id": belge["id"], "ad": belge["ad"], "sayfa_sayisi": len(belge["sayfalar"]),
            "karakter": belge["karakter"], "kesildi": belge["kesildi"], "birim": belge["birim"]}
```

`requirements.txt`'e `pypdf==6.19.0` satırının altına ekle: `python-docx==1.2.0` ve `python-multipart==0.0.32`.

- [ ] **Step 4: Testlerin geçtiğini gör**

Run: `.venv/Scripts/python -m pytest tests/test_belge.py -q`
Expected: PASS (hepsi). `test_sifreli_pdf_reddedilir` pypdf şifrelemesinde `cryptography` isterse ve kurulu değilse: `PdfWriter.encrypt(..., algorithm="RC4-40")` kullan (pypdf'in kendi RC4'ü bağımlılıksız).

- [ ] **Step 5: Commit**

```bash
git add sonda/belge.py tests/test_belge.py tests/conftest.py requirements.txt
git commit -m "Belge: PDF/Word/metin okuma, doğrulama ve kayıt (sayfa/bölüm bilgisiyle)"
```

---

### Task 2: Soruya göre bağlam seçimi (`belge.baglam`)

**Files:**
- Modify: `sonda/belge.py` (sona ekle)
- Test: `tests/test_belge.py` (sona ekle)

**Interfaces:**
- Consumes: Task 1'in belge sözlüğü, `sonda.web.embed(metinler) -> np.ndarray` (satırlar normalize).
- Produces:
  - `baglam_siniri(model: str) -> int`: Model `gemini:` ile başlıyorsa 60000, değilse 15000.
  - `baglam(belgeler: list[dict], soru: str, model: str) -> tuple[list[dict], bool]`: Dönen parçaların biçimi `{"belge_id", "ad", "birim", "no", "metin"}`, belge ve sayfa sırasındadır. İkinci değer `tam` ise bütün belgeler sığdıysa `True` olur.

- [ ] **Step 1: Başarısız testleri yaz**

```python
# ---- soruya göre bağlam (kısa belge tamamen, uzun belge en yakın parçalar)
import numpy as np


def _belge(sayfalar, kimlik="a" * 32, ad="b.pdf"):
    return {"id": kimlik, "ad": ad, "birim": "sayfa", "sayfalar": [{"no": i, "metin": m} for i, m in enumerate(sayfalar, 1)]}


def test_baglam_siniri_modele_gore():
    assert belge.baglam_siniri("gemini:gemini-flash-latest") == 60000
    assert belge.baglam_siniri("qwen3.6:35b-a3b") == 15000


def test_kisa_belge_tamamen_gider(monkeypatch):
    monkeypatch.setattr(belge, "embed", lambda m: pytest.fail("kısa belgede embedding gerekmez"))
    parcalar, tam = belge.baglam([_belge(["giris", "kira artisi yuzde 25"])], "kira artışı", "qwen")
    assert tam is True and [p["no"] for p in parcalar] == [1, 2] and parcalar[1]["metin"] == "kira artisi yuzde 25"


def _sahte_embed(anahtar):
    """Parçada anahtar kelime varsa soruya yakın vektör verir."""
    def embed(metinler):
        return np.array([[1.0, 0.0] if (i == 0 or anahtar in m) else [0.0, 1.0] for i, m in enumerate(metinler)])
    return embed


def test_uzun_belgede_en_yakin_parca_secilir(monkeypatch):
    monkeypatch.setattr(belge, "embed", _sahte_embed("depozito"))
    sayfalar = ["dolgu metni " * 300 for _ in range(30)]
    sayfalar[17] = "Madde 9 depozito iki kira bedelidir. " + "dolgu " * 100
    parcalar, tam = belge.baglam([_belge(sayfalar)], "depozito ne kadar", "qwen")
    assert tam is False
    assert parcalar and any(p["no"] == 18 and "depozito" in p["metin"] for p in parcalar)
    assert sum(len(p["metin"]) for p in parcalar) <= belge.baglam_siniri("qwen")


def test_embedding_yoksa_kelime_eslesmesi(monkeypatch):
    def patla(m):
        raise ConnectionError("ollama kapalı")
    monkeypatch.setattr(belge, "embed", patla)
    sayfalar = ["dolgu metni " * 300 for _ in range(30)]
    sayfalar[5] = "Depozito iki kira bedelidir. " + "dolgu " * 100
    parcalar, _ = belge.baglam([_belge(sayfalar)], "depozito ne kadar", "qwen")
    assert any(p["no"] == 6 for p in parcalar)


def test_cok_uzun_belgede_embeddinge_sinirli_parca_gider(monkeypatch):
    gorulen = []

    def embed(metinler):
        gorulen.append(len(metinler))
        return np.ones((len(metinler), 2)) / np.sqrt(2)
    monkeypatch.setattr(belge, "embed", embed)
    belge.baglam([_belge(["kelime " * 500 for _ in range(1000)])], "kelime", "qwen")
    assert gorulen and max(gorulen) <= belge.EMBED_EN_FAZLA + 1  # +1: sorunun kendisi


def test_birden_cok_belge_sirasi_korunur(monkeypatch):
    monkeypatch.setattr(belge, "embed", _sahte_embed("x"))
    parcalar, tam = belge.baglam([_belge(["a1", "a2"], "a" * 32, "a.pdf"), _belge(["b1"], "b" * 32, "b.pdf")], "?", "qwen")
    assert tam and [(p["ad"], p["no"]) for p in parcalar] == [("a.pdf", 1), ("a.pdf", 2), ("b.pdf", 1)]
```

- [ ] **Step 2: Başarısız olduğunu gör**

Run: `.venv/Scripts/python -m pytest tests/test_belge.py -q -k "baglam or parca or embedding or belge_sirasi"`
Expected: FAIL — `AttributeError: module 'sonda.belge' has no attribute 'baglam_siniri'`

- [ ] **Step 3: `sonda/belge.py`'ye bağlam seçimini ekle**

Dosyanın başındaki importlara ekle: `from .web import embed` (ve `import numpy as np`). Sona:

```python
PARCA, ORTUSME = 900, 120
EMBED_EN_FAZLA = 200  # çok uzun belgede embedding'e önce kelime eşleşmesiyle seçilen bu kadar parça gider
_KELIME = re.compile(r"\w{3,}")


def baglam_siniri(model):
    return 60000 if str(model).startswith("gemini:") else 15000


def _parcalar(belgeler):
    for b in belgeler:
        for s in b["sayfalar"]:
            metin = " ".join(s["metin"].split())
            for i in range(0, max(len(metin), 1), PARCA - ORTUSME):
                if parca := metin[i:i + PARCA]:
                    yield {"belge_id": b["id"], "ad": b["ad"], "birim": b["birim"], "no": s["no"], "metin": parca}


def _kelime_puani(soru, parcalar):
    kelimeler = {k[:6] for k in _KELIME.findall(soru.casefold())}  # kaba kök: "depozito"/"depozitoyu"
    return [sum(p["metin"].casefold().count(k) for k in kelimeler) for p in parcalar]


def baglam(belgeler, soru, model):
    """(parçalar, tam): kısa belgeler tamamen; uzunsa soruya en yakın parçalar, sınırı aşmadan, belge/sayfa sırasında."""
    sinir = baglam_siniri(model)
    if sum(len(s["metin"]) for b in belgeler for s in b["sayfalar"]) <= sinir:
        return [{"belge_id": b["id"], "ad": b["ad"], "birim": b["birim"], "no": s["no"], "metin": s["metin"]}
                for b in belgeler for s in b["sayfalar"]], True
    parcalar = list(_parcalar(belgeler))
    kelime = _kelime_puani(soru, parcalar)
    adaylar = sorted(range(len(parcalar)), key=lambda i: -kelime[i])[:EMBED_EN_FAZLA]
    try:
        v = embed([soru] + [parcalar[i]["metin"] for i in adaylar])
        benzerlik = v[1:] @ v[0]
        sira = [adaylar[j] for j in np.argsort(-benzerlik)]
    except Exception:  # Ollama kapalı / bge-m3 yok: kelime eşleşmesi yeter
        sira = adaylar
    secilen, toplam = [], 0
    for i in sira:
        if toplam + len(parcalar[i]["metin"]) > sinir:
            break
        secilen.append(i)
        toplam += len(parcalar[i]["metin"])
    return [parcalar[i] for i in sorted(secilen)], False
```

- [ ] **Step 4: Testlerin geçtiğini gör**

Run: `.venv/Scripts/python -m pytest tests/test_belge.py -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add sonda/belge.py tests/test_belge.py
git commit -m "Belge: soruya göre bağlam seçimi (kısa belge tamamen, uzun belgede en yakın parçalar)"
```

---

### Task 3: Araştırma modlarına belge (kaynaklar, istemler, hızlı ve derin mod)

**Files:**
- Modify: `sonda/arastirma/kaynaklar.py`
- Create: `sonda/arastirma/belge_baglami.py`
- Modify: `sonda/arastirma/promptlar.py` (`ON_KARAR_PROMPTU` ve `RAPOR_PROMPTU` yakınına belge kuralları)
- Modify: `sonda/arastirma/hizli.py:22-56` (`hizli` imzası ve ön karar)
- Modify: `sonda/arastirma/derin.py:41-80` (`derin` imzası)
- Test: `tests/test_belge.py` (sona)

**Interfaces:**
- Consumes: `belge.baglam(belgeler, soru, model) -> (parçalar, tam)`
- Produces:
  - `Kaynaklar.belge_ekle(parca: dict) -> tuple[int, dict | None]`. Kaynak URL'si `belge:<id>#<no>`, başlığı `"<ad> · s. <no>"` (bölüm için `"<ad> · bölüm <no>"`). Olay biçimi `{"tur": "kaynak", "no", "url", "baslik", "alan": <ad>, "belge": True, "metin": <en çok 600 karakter>}`.
  - `belge_blogu(belgeler, soru, model, kaynaklar) -> tuple[str, list[dict]]`. Dönen ikili `(istem metni, kaynak olayları)`; belge yoksa `("", [])`.
  - `belge_ozeti(belgeler) -> str`: Ön karar için belge adı ve ilk 1500 karakter.
  - `hizli(soru, gecmis, model, onceki_kaynaklar=(), diger_sohbetler=(), belgeler=())`
  - `derin(soru, gecmis, model, onceki_kaynaklar=(), diger_sohbetler=(), belgeler=())`

- [ ] **Step 1: Başarısız testleri yaz**

```python
# ---- araştırma modlarında belge
from sonda.arastirma import hizli as hizli_mod
from sonda.arastirma.belge_baglami import belge_blogu, belge_ozeti
from sonda.arastirma.kaynaklar import Kaynaklar
from sonda.model import Parca


def test_belge_parcasi_numarali_kaynak_olur():
    k = Kaynaklar()
    no, olay = k.belge_ekle({"belge_id": "a" * 32, "ad": "s.pdf", "birim": "sayfa", "no": 4, "metin": "Madde 4"})
    assert no == 1 and olay["url"] == f"belge:{'a' * 32}#4" and olay["baslik"] == "s.pdf · s. 4"
    assert olay["belge"] is True and olay["alan"] == "s.pdf" and olay["metin"] == "Madde 4"
    assert k.belge_ekle({"belge_id": "a" * 32, "ad": "s.pdf", "birim": "sayfa", "no": 4, "metin": "x"})[1] is None


def test_takip_sorusunda_belge_kaynagi_numarasini_korur():
    onceki = [{"no": 3, "url": f"belge:{'a' * 32}#4", "baslik": "s.pdf · s. 4"}]
    no, olay = Kaynaklar(onceki).belge_ekle({"belge_id": "a" * 32, "ad": "s.pdf", "birim": "sayfa", "no": 4, "metin": "x"})
    assert no == 3 and olay["belge"] is True


def test_belge_blogu_kaynak_numaralariyla():
    k = Kaynaklar()
    b = {"id": "a" * 32, "ad": "cv.docx", "birim": "bölüm", "sayfalar": [{"no": 1, "metin": "Python 5 yil"}]}
    metin, olaylar = belge_blogu([b], "deneyim?", "qwen", k)
    assert "[1] cv.docx · bölüm 1" in metin and "Python 5 yil" in metin and len(olaylar) == 1
    assert belge_blogu([], "?", "qwen", k) == ("", [])


def test_belge_ozeti_kisa():
    b = {"id": "a" * 32, "ad": "s.pdf", "birim": "sayfa", "sayfalar": [{"no": 1, "metin": "x" * 5000}]}
    ozet = belge_ozeti([b])
    assert "s.pdf" in ozet and len(ozet) < 1700


def test_hizli_modda_belgeden_cevaplanan_soruda_arama_yapilmaz(monkeypatch):
    monkeypatch.setattr(hizli_mod, "json_sor", lambda *a, **k: {"arama": False})
    monkeypatch.setattr(hizli_mod, "arac_calistir", lambda *a, **k: pytest.fail("arama yapılmamalı"))
    istemler = []

    def sohbet(model, mesajlar, **k):
        istemler.append(mesajlar)
        return iter([Parca("Kira artışı %25 [1].")])
    monkeypatch.setattr(hizli_mod.saglayici, "sohbet", sohbet)
    b = {"id": "a" * 32, "ad": "s.pdf", "birim": "sayfa", "sayfalar": [{"no": 4, "metin": "Madde 4 artis yuzde 25"}]}
    olaylar = list(hizli_mod.hizli("kira artışı kaç?", [], "qwen", belgeler=[b]))
    kaynak = [o for o in olaylar if o["tur"] == "kaynak"]
    assert kaynak and kaynak[0]["belge"] is True and kaynak[0]["no"] == 1
    assert "Madde 4 artis yuzde 25" in istemler[0][-1]["content"]
    assert olaylar[-1] == {"tur": "cevap_bitti", "metin": "Kira artışı %25 [1]."}


def test_on_karar_belge_ozetini_gorur(monkeypatch):
    girdiler = []
    monkeypatch.setattr(hizli_mod, "json_sor", lambda model, sistem, girdi: girdiler.append((sistem, girdi)) or {"arama": False})
    monkeypatch.setattr(hizli_mod.saglayici, "sohbet", lambda *a, **k: iter([Parca("tamam")]))
    b = {"id": "a" * 32, "ad": "kira.pdf", "birim": "sayfa", "sayfalar": [{"no": 1, "metin": "kira sozlesmesi"}]}
    list(hizli_mod.hizli("uygun mu?", [], "qwen", belgeler=[b]))
    assert "kira.pdf" in girdiler[0][1] and "kira sozlesmesi" in girdiler[0][1]
    assert "belge" in girdiler[0][0].lower()
```

- [ ] **Step 2: Başarısız olduğunu gör**

Run: `.venv/Scripts/python -m pytest tests/test_belge.py -q -k "kaynak or blogu or ozeti or hizli or on_karar"`
Expected: FAIL — `ModuleNotFoundError: No module named 'sonda.arastirma.belge_baglami'`

- [ ] **Step 3: `Kaynaklar.belge_ekle` ekle** (`sonda/arastirma/kaynaklar.py`, sınıfın sonuna)

```python
    def belge_ekle(self, parca):
        """Belge parçasını numaralı kaynak yapar (adresi yok: url 'belge:<id>#<no>'). Aynı sayfa bir kez eklenir."""
        url = f"belge:{parca['belge_id']}#{parca['no']}"
        birim = "s." if parca["birim"] == "sayfa" else "bölüm"
        baslik = f"{parca['ad']} · {birim} {parca['no']}"
        if url in self._no and any(k["no"] == self._no[url] for k in self.liste):
            return self._no[url], None
        no = self._no.get(url) or self._sonraki
        if url not in self._no:
            self._no[url] = no
            self._sonraki += 1
        kayit = {"no": no, "url": url, "baslik": baslik, "alan": parca["ad"], "belge": True,
                 "metin": parca["metin"][:600]}
        self.liste.append(kayit)
        return no, {"tur": "kaynak", **kayit}
```

- [ ] **Step 4: `sonda/arastirma/belge_baglami.py` oluştur**

```python
"""Hızlı ve derin modun ortak belge adımı: seçilen belge parçalarını numaralı kaynak yapar, modele gidecek bloğu yazar."""
from .. import belge as belge_

OZET = 1500


def belge_blogu(belgeler, soru, model, kaynaklar):
    """(istem metni, kaynak olayları). Aynı sayfanın parçaları tek kaynak numarası altında birleşir."""
    if not belgeler:
        return "", []
    parcalar, tam = belge_.baglam(belgeler, soru, model)
    olaylar, bloklar = [], {}
    for p in parcalar:
        no, olay = kaynaklar.belge_ekle(p)
        if olay:
            olaylar.append(olay)
        baslik = f"[{no}] {p['ad']} · {'s.' if p['birim'] == 'sayfa' else 'bölüm'} {p['no']}"
        bloklar.setdefault(baslik, []).append(p["metin"])
    kapsam = "belgelerin tamamı" if tam else "belgelerin soruyla en ilgili kısımları"
    metin = (f"KULLANICININ EKLEDİĞİ BELGELER ({kapsam}; atıf yaparken köşeli parantezdeki numarayı kullan):\n\n"
             + "\n\n".join(f"{b}\n" + "\n...\n".join(m) for b, m in bloklar.items()))
    return metin, olaylar


def belge_ozeti(belgeler):
    """Ön karar için: belgelerin adı ve başından kısa bir kesit."""
    satirlar = []
    for b in belgeler:
        bas = " ".join(" ".join(s["metin"] for s in b["sayfalar"]).split())[:OZET // max(1, len(belgeler))]
        satirlar.append(f"- {b['ad']}: {bas}")
    return "EKLİ BELGELER:\n" + "\n".join(satirlar)
```

- [ ] **Step 5: İstem kuralları** (`sonda/arastirma/promptlar.py`)

`sistem_promptu` içindeki `BİÇİM:` maddelerinin sonuna şu satırı ekle (üçlü tırnak içinde, `- Önceki konuşmayı dikkate al...` satırından sonra):

```
- Kullanıcı belge eklediyse: belgedeki bilgiyi belgenin kaynak numarasıyla, webden gelen bilgiyi web kaynağının
  numarasıyla göster; hangi bilginin belgeden, hangisinin webden geldiği okurken anlaşılsın. Belgede yazmayanı
  belgeye atfetme. Belge ile güncel bilgi çelişiyorsa bunu açıkça söyle.
```

`ON_KARAR_PROMPTU`'nda `- arama:` maddesinin sonuna ekle:

```
  Kullanıcı belge eklediyse (EKLİ BELGELER verilir) ve soru yalnızca belgenin içeriğiyle cevaplanabiliyorsa
  ("bu sözleşmede kira artışı kaç?", "belgeyi özetle") false; güncel yasa, fiyat, piyasa ya da belgede olmayan dış
  bilgi gerekiyorsa ("yeni yasaya uygun mu?", "bu maaş piyasaya göre nasıl?") true.
```

- [ ] **Step 6: Hızlı moda bağla** (`sonda/arastirma/hizli.py`)

Import ekle: `from .belge_baglami import belge_blogu, belge_ozeti`. `hizli` fonksiyonunu şöyle değiştir (yalnız işaretli kısımlar yeni):

```python
def hizli(soru, gecmis, model, onceki_kaynaklar=(), diger_sohbetler=(), belgeler=()):
    kaynaklar = Kaynaklar(onceki_kaynaklar)
    gecmis = gecmisi_hazirla(gecmis, onceki_kaynaklar)
    blok, olaylar = belge_blogu(belgeler, soru, model, kaynaklar)            # yeni
    yield from olaylar                                                       # yeni
    icerik = f"{blok}\n\nSORU: {soru}" if blok else soru                     # yeni
    mesajlar = [{"role": "system", "content": sistem_promptu(diger_sohbetler)}, *gecmis,
                {"role": "user", "content": icerik}]                         # soru -> icerik

    son = "\n".join(f"{m['role']}: {m['content'][:400]}" for m in gecmis[-4:])
    ek = f"\n\n{belge_ozeti(belgeler)}" if belgeler else ""                  # yeni
    karar = json_sor(model, ON_KARAR_PROMPTU.format(tarih=bugun()),
                      f"Önceki konuşma:\n{son or '(yok)'}{ek}\n\nSon mesaj: {soru}")
```

Geri kalan (arama dalı ve `_dongu`) aynı kalır. Arama dalındaki boş sonuç erken dönüşü (`ARAMA_CALISMIYOR`) belge varken tetiklenmesin: `if not en_iyiler:` koşulunu `if not en_iyiler and not belgeler:` yap, `okuma_sonucu` çağrısını `if en_iyiler:` altına al.

- [ ] **Step 7: Derin moda bağla** (`sonda/arastirma/derin.py`)

Import ekle: `from .belge_baglami import belge_blogu, belge_ozeti`. `derin` imzasına `belgeler=()` ekle ve:

```python
    istek = f"Önceki konuşma:\n{baglam}\n\nAraştırma sorusu: {soru}" if baglam else soru
    if belgeler:
        istek = f"{belge_ozeti(belgeler)}\n\n{istek}"   # plan belgeyi bilsin: belgede olanı webde arama
    belge_metni, olaylar = belge_blogu(belgeler, soru, model, kaynaklar)
    yield from olaylar
```

(`kaynaklar` satırından sonra, `yield {"tur": "adim", "tip": "plan", ...}` satırından önce.) Rapor aşamasında `metin` hesaplandıktan sonra:

```python
    if belge_metni:
        metin = f"{belge_metni}\n\n{metin}"
```

- [ ] **Step 8: Testlerin geçtiğini gör**

Run: `.venv/Scripts/python -m pytest tests/test_belge.py tests/test_model.py -q`
Expected: PASS. Sonra tüm araştırma testleri: `.venv/Scripts/python -m pytest -q -k "hizli or derin or kaynak"` → PASS

- [ ] **Step 9: Commit**

```bash
git add sonda/arastirma tests/test_belge.py
git commit -m "Araştırma: ekli belge parçaları numaralı kaynak; ön karar belgeden cevaplanabilen soruda aramaz"
```

---

### Task 4: Sunucu ve asistan (`/api/belge`, `Istek.belgeler`)

**Files:**
- Modify: `sonda/sunucu.py` (import, `Istek`, yeni uç noktalar, `sor`)
- Modify: `sonda/asistan.py:62-103` (`calistir`)
- Test: `tests/test_sunucu.py` (sona)

**Interfaces:**
- Consumes: `belge.oku/kaydet/yukle/sil/ozet`, `BelgeHatasi`, `hizli(..., belgeler=)`, `derin(..., belgeler=)`
- Produces:
  - `POST /api/belge` (multipart alan adı `dosya`) → 200 ile `belge.ozet(...)`; hata olursa 400 ve `{"detail": "<Türkçe mesaj>"}`
  - `DELETE /api/belge/{kimlik}` → `{"tamam": bool}`
  - `/api/sor` gövdesinde `belgeler: list[str]` (en çok 5 kimlik)
  - `calistir(..., belgeler=())`: Yeni olaylar şunlar:
    - `{"tur": "belge_yok", "id": <kimlik>}`
    - `{"tur": "adim", "tip": "belge", "metin": ...}`

- [ ] **Step 1: Başarısız testleri yaz** (`tests/test_sunucu.py` sonuna)

```python
# ---- belge ekleme
from sonda import belge


def test_belge_yukle_ve_sil():
    y = istemci.post("/api/belge", files={"dosya": ("not.txt", "Kira artışı yüzde 25".encode(), "text/plain")})
    assert y.status_code == 200
    ozet = y.json()
    assert ozet["ad"] == "not.txt" and ozet["sayfa_sayisi"] == 1 and len(ozet["id"]) == 32
    assert belge.yukle(ozet["id"]) is not None
    assert istemci.delete(f"/api/belge/{ozet['id']}").json() == {"tamam": True}
    assert belge.yukle(ozet["id"]) is None


def test_belge_hatasi_turkce_400():
    y = istemci.post("/api/belge", files={"dosya": ("resim.png", b"\x89PNG", "image/png")})
    assert y.status_code == 400 and "yalnızca PDF" in y.json()["detail"]


def test_buyuk_belge_400(monkeypatch):
    monkeypatch.setattr(belge, "EN_BUYUK_DOSYA", 10)
    y = istemci.post("/api/belge", files={"dosya": ("a.txt", b"x" * 11, "text/plain")})
    assert y.status_code == 400 and "MB" in y.json()["detail"]


def test_gecersiz_kimlikle_silme():
    assert istemci.delete("/api/belge/..%2Fayarlar").json() == {"tamam": False}


def _belgeli_calistir(monkeypatch, mod, kimlikler):
    cagri = {}

    def sahte(soru, gecmis, model, onceki=(), diger=(), belgeler=()):
        cagri["belgeler"] = belgeler
        yield {"tur": "cevap_bitti", "metin": "ok"}
    monkeypatch.setattr(asistan, "hizli", sahte)
    monkeypatch.setattr(asistan, "derin", sahte)
    monkeypatch.setattr(asistan, "hafizayi_guncelle", lambda *a: None)
    olaylar = list(asistan.calistir("soru", [], "m", mod, oneri=False, belgeler=kimlikler))
    return cagri, olaylar


def test_calistir_belgeleri_yukleyip_moda_gecirir(monkeypatch):
    b = belge.kaydet(belge.oku("a.txt", b"metin"))
    cagri, olaylar = _belgeli_calistir(monkeypatch, "hizli", [b["id"], "f" * 32])
    assert [x["id"] for x in cagri["belgeler"]] == [b["id"]]
    assert {"tur": "belge_yok", "id": "f" * 32} in olaylar
    cagri, _ = _belgeli_calistir(monkeypatch, "derin", [b["id"]])
    assert [x["id"] for x in cagri["belgeler"]] == [b["id"]]


def test_calistir_en_fazla_bes_belge(monkeypatch):
    kimlikler = [belge.kaydet(belge.oku(f"{i}.txt", b"m"))["id"] for i in range(7)]
    cagri, _ = _belgeli_calistir(monkeypatch, "hizli", kimlikler)
    assert len(cagri["belgeler"]) == 5


def test_gorev_modunda_belge_kullanilmaz_ve_soylenir(monkeypatch):
    b = belge.kaydet(belge.oku("a.txt", b"metin"))
    monkeypatch.setattr(gorev, "calistir", lambda *a, **k: iter([{"tur": "cevap_bitti", "metin": ""}]))
    monkeypatch.setattr(asistan, "yon_belirle", lambda *a: "gorev")
    olaylar = list(asistan.calistir("ssd bul", [], "m", "gorev", belgeler=[b["id"]]))
    assert any(o["tur"] == "adim" and o.get("tip") == "belge" and "Görev modunda" in o["metin"] for o in olaylar)


def test_sor_istegi_belgeleri_iletir(monkeypatch):
    gelen = {}

    def sahte(*a, **k):
        gelen.update(k)
        yield {"tur": "bitti", "sure": 0}
    monkeypatch.setattr(sunucu, "calistir", sahte)
    istemci.post("/api/sor", json={"soru": "s", "model": "m", "belgeler": ["a" * 32]}).read()
    assert gelen["belgeler"] == ["a" * 32]
```

- [ ] **Step 2: Başarısız olduğunu gör**

Run: `.venv/Scripts/python -m pytest tests/test_sunucu.py -q -k belge`
Expected: FAIL — 404/405 for `/api/belge`, `TypeError: calistir() got an unexpected keyword argument 'belgeler'`

- [ ] **Step 3: `sonda/asistan.py`**

Import: `from . import belge, gorev, hafiza, koruma` ve `from .arastirma import derin, hizli, sohbet` (zaten var). Sabit: `EN_FAZLA_BELGE = 5`. `calistir` imzası: `def calistir(soru, gecmis, model, mod, onceki_kaynaklar=(), diger_sohbetler=(), oneri=True, serbest=False, belgeler=()):`. `try:` bloğunun başına:

```python
        yuklu = []
        for kimlik in list(belgeler)[:EN_FAZLA_BELGE]:
            if b := belge.yukle(kimlik):
                yuklu.append(b)
            else:
                yield {"tur": "belge_yok", "id": kimlik}
        if yuklu and mod == "gorev":
            yield {"tur": "adim", "tip": "belge", "metin": "Görev modunda ekli belgeler kullanılmaz"}
```

Hızlı/derin çağrılarına `belgeler=yuklu` ver:

```python
            elif hedef == "sohbet":
                uretec = sohbet(temiz_soru, temiz_gecmis, model, onceki_kaynaklar, diger_sohbetler)
            else:
                uretec = hizli(temiz_soru, temiz_gecmis, model, onceki_kaynaklar, diger_sohbetler)
        else:
            uretec = (derin if mod == "derin" else hizli)(temiz_soru, temiz_gecmis, model, onceki_kaynaklar,
                                                          diger_sohbetler, belgeler=yuklu)
```

(Görev modu dalları değişmez: belge yok sayılır.)

- [ ] **Step 4: `sonda/sunucu.py`**

Importlara `UploadFile, File` (`from fastapi import FastAPI, File, HTTPException, UploadFile`) ve `from . import ayarlar, belge, gorev, hafiza` ekle. `Istek`'e alan: `belgeler: list[str] = []            # sohbete eklenen belge kimlikleri`. Uç noktalar (`sor`'dan önce):

```python
@app.post("/api/belge")
async def belge_yukle(dosya: UploadFile = File(...)):
    veri = await dosya.read(belge.EN_BUYUK_DOSYA + 1)  # sınırdan fazlası okunmaz
    try:
        return belge.ozet(belge.kaydet(belge.oku(dosya.filename, veri)))
    except belge.BelgeHatasi as h:
        raise HTTPException(400, str(h))


@app.delete("/api/belge/{kimlik}")
def belge_sil(kimlik: str):
    return {"tamam": belge.sil(kimlik)}
```

`sor` içinde çağrıya ekle: `serbest=istek.serbest, belgeler=istek.belgeler`.

- [ ] **Step 5: Testlerin geçtiğini gör**

Run: `.venv/Scripts/python -m pytest tests/test_sunucu.py tests/test_belge.py -q`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add sonda/asistan.py sonda/sunucu.py tests/test_sunucu.py
git commit -m "Sunucu: /api/belge yükleme/silme; sorulara ekli belgeler (en çok 5), görev modunda yok sayılır"
```

---

### Task 5: Arayüz (ataç, sürükle-bırak, çipler, uyarı, 📄 kaynaklar)

**Files:**
- Modify: `static/index.html` (CSS, `#form` içeriği, `kullaniciEl`, `kaynakSeridi`, `cekmeceAc`, `gonder`, sohbet silme, `rozetGuncelle`, `sohbetAc`/`yeniSohbet`)
- Test: `tests/test_arayuz.py` (sona)

**Interfaces:**
- Consumes: `POST /api/belge`, `DELETE /api/belge/{id}`, `/api/sor` `belgeler`, olaylar `kaynak` (`belge: true`, `metin`), `belge_yok`.
- Produces: Sohbet nesnesinde `s.belgeler: [{id, ad, sayfa_sayisi, birim}]`. Mesaj nesnesinde `m.belgeler: [ad]` (kullanıcı mesajı etiketi için). Yeni sohbette henüz sohbet yokken çipler `S.bekleyenBelgeler` dizisinde tutulur.

- [ ] **Step 1: Başarısız arayüz testlerini yaz** (`tests/test_arayuz.py` sonuna)

```python
# ---- belge ekleme
BELGE_ISTEKLERI = []


def _belge_dosyasi(tmp_path, ad="kira.txt", metin="Kira artışı yüzde 25"):
    yol = tmp_path / ad
    yol.write_text(metin, encoding="utf-8")
    return str(yol)


def test_belge_eklenir_cip_gorunur_ve_istekle_gider(arayuz, tmp_path, monkeypatch):
    s = _sayfa(arayuz)
    s.click("[data-mod=hizli]")
    s.set_input_files("#dosya", _belge_dosyasi(tmp_path))
    s.wait_for_selector(".belge-cip:not(.yukleniyor)")
    assert "kira.txt" in s.inner_text(".belge-cip") and "1 bölüm" in s.inner_text(".belge-cip")
    with s.expect_request("**/api/sor") as istek:
        _gonder(s, "artış kaç?")
    govde = istek.value.post_data_json
    assert len(govde["belgeler"]) == 1 and len(govde["belgeler"][0]) == 32
    s.wait_for_selector(".m-kullanici .belge-etiket")
    assert "kira.txt" in s.inner_text(".m-kullanici .belge-etiket")
    with s.expect_request("**/api/sor") as istek2:  # takip sorusu da aynı belgeyle gider
        s.wait_for_selector("#gonder:not([aria-label=Durdur])")
        _gonder(s, "peki depozito?")
    assert istek2.value.post_data_json["belgeler"] == govde["belgeler"]
    s.close()


def test_belge_cipi_silinince_sunucudan_silinir(arayuz, tmp_path):
    s = _sayfa(arayuz)
    s.set_input_files("#dosya", _belge_dosyasi(tmp_path))
    s.wait_for_selector(".belge-cip:not(.yukleniyor)")
    with s.expect_request(lambda r: r.method == "DELETE" and "/api/belge/" in r.url):
        s.click(".belge-cip [data-belge-sil]")
    assert s.locator(".belge-cip").count() == 0
    s.close()


def test_okunamayan_belge_kirmizi_cip(arayuz, tmp_path):
    s = _sayfa(arayuz)
    yol = tmp_path / "resim.png"
    yol.write_bytes(b"\x89PNG")
    s.set_input_files("#dosya", str(yol))
    s.wait_for_selector(".belge-cip.hata")
    assert "yalnızca PDF" in s.inner_text(".belge-cip.hata")
    s.close()


def test_gemini_seciliyken_belge_uyarisi(arayuz, tmp_path):
    s = _sayfa(arayuz)
    s.set_input_files("#dosya", _belge_dosyasi(tmp_path))
    s.wait_for_selector(".belge-cip:not(.yukleniyor)")
    s.evaluate("""() => { const m = document.querySelector('#model');
        m.insertAdjacentHTML('beforeend', '<option value="gemini:x">G</option>'); m.value = 'gemini:x';
        m.dispatchEvent(new Event('change')); }""")
    assert "Gemini'ye gönderilir" in s.inner_text("#belge-uyari")
    s.close()
```

`_gorev_senaryosu`'nun hızlı mod dalı için `_sahte_akis` tüm modlarda aynı senaryoyu kullandığından ek bir şey gerekmez; belge kaynağı gösterimi için senaryonun başına şu dalı ekle ve testini yaz:

```python
    if "belgeli" in soru:
        yield {"tur": "kaynak", "no": 1, "url": "belge:" + "a" * 32 + "#4", "baslik": "kira.pdf · s. 4",
               "alan": "kira.pdf", "belge": True, "metin": "Madde 4: kira artışı yüzde 25"}
        yield {"tur": "token", "metin": "Artış %25 [1]."}
        yield {"tur": "bitti", "sure": 1.0}
        return
```

```python
def test_belge_kaynagi_cekmecede_metniyle_acilir(arayuz):
    s = _sayfa(arayuz)
    _gonder(s, "belgeli soru")
    s.wait_for_selector(".kaynak-kart.belge")
    assert s.get_attribute(".kaynak-kart.belge", "href") is None  # belgenin adresi yok
    s.click(".atif")
    s.wait_for_selector(".ck-kaynak.belge")
    assert "Madde 4: kira artışı yüzde 25" in s.inner_text(".ck-kaynak.belge")
    s.close()
```

- [ ] **Step 2: Başarısız olduğunu gör**

Run: `.venv/Scripts/python -m pytest tests/test_arayuz.py -q -k belge`
Expected: FAIL — `#dosya` bulunamadı (zaman aşımı)

- [ ] **Step 3: HTML ve CSS**

`#form` içinde `<textarea id="soru" ...>` satırından önce:

```html
        <div class="belgeler" id="belgeler"></div>
        <div class="belge-uyari" id="belge-uyari" hidden>Belgenin ilgili kısımları Gemini'ye gönderilir.</div>
```

`.kutu-alt` içinde `mod-sec` div'inden önce:

```html
          <button type="button" class="atac" id="ekle" title="Belge ekle (PDF, Word, .txt, .md)" aria-label="Belge ekle"><svg class="ik"><use href="#i-atac"/></svg></button>
          <input type="file" id="dosya" accept=".pdf,.docx,.txt,.md" multiple hidden>
```

SVG sembol tanımlarının yanına (`<symbol id="i-yukari"` benzerlerinin olduğu `<svg>` içinde):

```html
<symbol id="i-atac" viewBox="0 0 24 24"><path d="M21 12.5l-8.5 8.5a5 5 0 01-7-7L14 5.5a3.3 3.3 0 014.7 4.7L10.2 18.7a1.7 1.7 0 01-2.4-2.4L15.5 8.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></symbol>
```

CSS (`.gonder` kurallarının yanına):

```css
.atac { width: 32px; height: 32px; border: 0; background: none; color: var(--soluk); border-radius: 8px; display: grid; place-items: center; cursor: pointer; }
.atac:hover { color: var(--metin); background: var(--yuzey2, rgba(127,127,127,.12)); }
.atac svg { width: 18px; height: 18px; }
.belgeler { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 2px; }
.belgeler:empty { display: none; }
.belge-cip { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; padding: 4px 6px 4px 10px; border: 1px solid var(--kenar); border-radius: 999px; max-width: 100%; }
.belge-cip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.belge-cip button { border: 0; background: none; color: var(--soluk); cursor: pointer; font-size: 14px; line-height: 1; padding: 2px 4px; }
.belge-cip.yukleniyor { opacity: .6; }
.belge-cip.hata { border-color: var(--hata); color: var(--hata); }
.belge-uyari { font-size: 12px; color: var(--soluk); padding: 0 4px; }
.kutu.surukle { outline: 2px dashed var(--vurgu); outline-offset: 2px; }
.belge-etiket { font-size: 12px; color: var(--soluk); margin-bottom: 4px; }
.ck-metin { display: block; font-size: 12.5px; color: var(--soluk); margin-top: 4px; white-space: pre-wrap; }
```

- [ ] **Step 4: JavaScript**

`kaydet`/`aktifSohbet` tanımlarının altına:

```js
// ---------- belgeler: sohbete eklenen dosyalar (metni sunucuda, sohbette yalnız kimlik ve ad)
S.bekleyenBelgeler = [];
const belgeListesi = () => aktifSohbet()?.belgeler || S.bekleyenBelgeler;
function belgeleriCiz() {
  const liste = belgeListesi();
  $("#belgeler").innerHTML = liste.map((b, i) => `<span class="belge-cip${b.yukleniyor ? " yukleniyor" : ""}${b.hata ? " hata" : ""}"
    title="${kacis(b.hata || b.ad)}"><span>📄 ${kacis(b.ad)}${b.yukleniyor ? " · okunuyor…" : b.hata ? ` · ${kacis(b.hata)}`
    : ` · ${b.sayfa_sayisi} ${b.birim}`}</span><button type="button" data-belge-sil="${i}" aria-label="Belgeyi çıkar">✕</button></span>`).join("");
  const bulut = $("#model").value.startsWith("gemini:");
  $("#belge-uyari").hidden = !(bulut && liste.some(b => b.id));
}
async function belgeYukle(dosya) {
  const liste = belgeListesi();
  if (liste.filter(b => !b.hata).length >= 5) { bildir("Bir sohbete en çok 5 belge eklenebilir"); return; }
  const kayit = { ad: dosya.name, yukleniyor: true };
  liste.push(kayit); belgeleriCiz();
  if (dosya.size > 20 * 1024 * 1024) { kayit.yukleniyor = false; kayit.hata = "Dosya çok büyük: en çok 20 MB eklenebilir."; belgeleriCiz(); return; }
  const form = new FormData(); form.append("dosya", dosya);
  try {
    const y = await fetch("/api/belge", { method: "POST", body: form });
    const veri = await y.json();
    delete kayit.yukleniyor;
    if (!y.ok) kayit.hata = veri.detail || "Belge okunamadı";
    else { Object.assign(kayit, veri); if (veri.kesildi) bildir("Belge çok uzun; ilk kısmı kullanılacak"); }
  } catch { delete kayit.yukleniyor; kayit.hata = "Sunucuya ulaşılamadı"; }
  kaydet(); belgeleriCiz();
}
function belgeSil(i) {
  const liste = belgeListesi(); const b = liste[i];
  if (!b) return;
  if (b.id) fetch(`/api/belge/${b.id}`, { method: "DELETE" }).catch(() => {});
  liste.splice(i, 1); kaydet(); belgeleriCiz();
}
$("#ekle").onclick = () => $("#dosya").click();
$("#dosya").onchange = e => { [...e.target.files].forEach(belgeYukle); e.target.value = ""; };
$("#belgeler").onclick = e => { const b = e.target.closest("[data-belge-sil]"); if (b) belgeSil(Number(b.dataset.belgeSil)); };
const kutuEl = $("#form");
["dragenter", "dragover"].forEach(t => document.addEventListener(t, e => { if (e.dataTransfer?.types?.includes("Files")) { e.preventDefault(); kutuEl.classList.add("surukle"); } }));
["dragleave", "drop"].forEach(t => document.addEventListener(t, e => { if (t === "drop" || !e.relatedTarget) kutuEl.classList.remove("surukle"); }));
document.addEventListener("drop", e => { if (e.dataTransfer?.files?.length) { e.preventDefault(); [...e.dataTransfer.files].forEach(belgeYukle); } });
```

`$("#model").onchange` satırını şuna çevir: `$("#model").onchange = e => { depo.yaz("sonda-model", e.target.value); rozetGuncelle(); belgeleriCiz(); };`

`sohbetAc` ve `yeniSohbet` fonksiyonlarının sonuna `belgeleriCiz();` ekle (`yeniSohbet`'te önce `S.bekleyenBelgeler = [];`).

`gonder()` içinde yeni sohbet oluşturulurken bekleyen belgeler sohbete geçsin:

```js
    s = { id: crypto.randomUUID?.() || String(Date.now()), baslik: soru.slice(0, 60), zaman: Date.now(), mesajlar: [],
          belgeler: S.bekleyenBelgeler.filter(b => b.id) };
    S.bekleyenBelgeler = [];
```

Mesaj eklenirken:

```js
  const belgeler = (s.belgeler || []).filter(b => b.id);
  s.mesajlar.push({ role: "user", content: soru, belgeler: belgeler.map(b => b.ad) });
```

`/api/sor` gövdesine `belgeler: belgeler.map(b => b.id),` ekle. `kullaniciEl(soru, ...)` çağrısını `kullaniciEl(soru, s.mesajlar.length - 2, belgeler.map(b => b.ad))` yap. Olay döngüsüne:

```js
        else if (o.tur === "belge_yok") { const b = (s.belgeler || []).find(x => x.id === o.id); if (b) { b.hata = "belge bulunamadı"; delete b.id; belgeleriCiz(); } }
```

`kullaniciEl`:

```js
function kullaniciEl(metin, indeks, belgeler = []) {
  const d = document.createElement("div"); d.className = "m-kullanici"; d.dataset.indeks = indeks;
  d.innerHTML = `<div>${belgeler.length ? `<div class="belge-etiket">📄 ${belgeler.map(kacis).join(", ")}</div>` : ""}${kacis(metin)}</div><button class="duzenle-btn" data-duzenle-mesaj aria-label="Mesajı düzenle" title="Mesajı düzenle">${ik("kalem")}</button>`;
  return d;
}
```

Sohbet yeniden çizilirken `kullaniciEl` çağrılan yerde (`sohbetAc` içindeki mesaj döngüsü) üçüncü argüman olarak `m.belgeler || []` ver.

`kaynakSeridi` içindeki kart: belge kaynağında bağlantı yerine buton:

```js
  return `<div class="kaynak-seridi">${gorunen.map(k => k.belge ? `
    <button type="button" class="kaynak-kart belge" data-kaynaklar>
      <div class="kk-ust"><span>📄 ${kacis(k.alan)}</span></div><div class="kk-ad">${kacis(k.baslik)}</div></button>` : `
    <a class="kaynak-kart" href="${kacis(k.url)}" target="_blank" rel="noopener">
      <div class="kk-ust">${favImg(k.alan)}<span>${kacis(k.alan)}</span></div><div class="kk-ad">${kacis(k.baslik)}</div></a>`).join("")}
    ${kalan.length ? `<button class="kaynak-kart tumu" data-kaynaklar><span class="favler">${kalan.slice(0, 3).map(k => k.belge ? "📄" : favImg(k.alan, "")).join("")}</span>+${kalan.length} kaynak</button>` : ""}</div>`;
```

`cekmeceAc` içindeki eşleme:

```js
  $("#cekmece-govde").innerHTML = iz.kaynaklar.map(k => k.belge ? `
    <div class="ck-kaynak belge${String(k.no) === String(vurgu) ? " vurgu" : ""}" data-no="${k.no}">
      <span class="ck-no">${k.no}</span>
      <span><span class="ck-alan">📄 ${kacis(k.alan)}</span><span class="ck-ad">${kacis(k.baslik)}</span>
      <span class="ck-metin">${kacis(k.metin || "")}</span></span></div>` : `
    <a class="ck-kaynak${String(k.no) === String(vurgu) ? " vurgu" : ""}" data-no="${k.no}" href="${kacis(k.url)}" target="_blank" rel="noopener">
      <span class="ck-no">${k.no}</span>
      <span><span class="ck-alan">${favImg(k.alan)}${kacis(k.alan)}</span><span class="ck-ad">${kacis(k.baslik)}</span></span></a>`).join("");
```

Atıf tıklamasında Ctrl ile yeni sekme belge için açılmasın: `if ((e.ctrlKey || e.metaKey) && !k.belge) return window.open(...)`. Sohbet silme (`h.dataset.silEvet`) dalında, silmeden önce: `(S.sohbetler.find(s => s.id === h.dataset.silEvet)?.belgeler || []).forEach(b => b.id && fetch(`/api/belge/${b.id}`, { method: "DELETE" }).catch(() => {}));`. Markdown dışa aktarmada (`### Kaynaklar`) belge kaynağı için bağlantı yerine `${k.no}. 📄 ${k.baslik}` yaz.

- [ ] **Step 5: Testlerin geçtiğini gör**

Run: `.venv/Scripts/python -m pytest tests/test_arayuz.py -q`
Expected: PASS (yeni belge testleri ve eski arayüz testleri)

- [ ] **Step 6: Commit**

```bash
git add static/index.html tests/test_arayuz.py
git commit -m "Arayüz: belge ekleme (ataç, sürükle-bırak, çipler, Gemini uyarısı, 📄 kaynaklar)"
```

---

### Task 6: Tüm testler, canlı deneme ve yol haritası

**Files:**
- Modify: `docs/yol-haritasi.md` (en üste yeni bölüm; "Açık soru 1" kapanır)

- [ ] **Step 1: Tüm test takımı**

Run: `.venv/Scripts/python -m pytest -q`
Expected: tümü PASS (öncesinde 613; yeni testlerle artmış olmalı)

- [ ] **Step 2: Canlı deneme (sunucu açık, Gemini Flash)**

`baslat.bat` ile aç, hızlı modda:
1. Metinli bir PDF ekle, "bu belgeyi 3 maddede özetle" sor → web araması yapılmamalı (adımlarda arama yok), 📄 kaynaklar sayfa numarasıyla.
2. Aynı sohbette "bu maddeler güncel mevzuata uygun mu?" sor → web araması yapılmalı; cevapta 📄 ve 🌐 kaynaklar ayrı.
3. Yerel modele geç, aynı soruyu sor → Gemini uyarısı kaybolmalı.
Sonuçları (süre, arama yapıldı mı, kaynak doğruluğu) not et.

- [ ] **Step 3: Yol haritası**

`docs/yol-haritasi.md` başına (`## 00.` bölümünden önce) ekle:

```markdown
## 000. Sohbete belge ekleme (A) — tamamlandı

PDF (metinli), Word, .txt, .md sohbete eklenir (ataç ya da sürükle-bırak; en çok 5 belge, 20 MB). Kısa belge modele
tamamen, uzun belge `bge-m3` ile soruya en yakın parçalarla gider (Gemini 60 bin, yerel 15 bin karakter). Ön karar
belgeden cevaplanabilen soruda web araması yapmaz; belge kaynakları 📄 "ad · s. N" olarak numaralı kaynak listesine
girer. Yerel modelde belge bilgisayardan çıkmaz; Gemini seçiliyse arayüz uyarır. Tasarım:
`docs/superpowers/specs/2026-09-28-belge-ekleme-design.md`.
Canlı deneme: <Step 2 sonuçları>.
Sıradaki: oturumu açık sitelerden okuma ve analiz (Upwork, e-Devlet, banka ekstresi).
```

"### Açık soru 1" başlığının altına tek satır ekle: `**Karar (28 Eylül):** A teslim edildi; B sonra.`

- [ ] **Step 4: Commit**

```bash
git add docs/yol-haritasi.md
git commit -m "Yol haritası: belge ekleme tamamlandı"
```
