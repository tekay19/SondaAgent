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
