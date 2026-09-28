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
