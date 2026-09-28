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


# ---- araştırma modlarında belge
import importlib

hizli_mod = importlib.import_module("sonda.arastirma.hizli")  # paket "hizli" adıyla fonksiyonu dışa açar
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


derin_mod = importlib.import_module("sonda.arastirma.derin")


def test_derin_modda_belge_kaynagi_ve_rapor_istemi(monkeypatch):
    monkeypatch.setattr(derin_mod, "json_sor", lambda *a, **k: {})
    monkeypatch.setattr(derin_mod, "web_ara", lambda *a, **k: [])
    monkeypatch.setattr(derin_mod, "sayfalari_oku", lambda *a, **k: [])
    istemler = []

    def sohbet(model, mesajlar, **k):
        istemler.append(mesajlar[0]["content"])
        return iter([Parca("Rapor [1].")])
    monkeypatch.setattr(derin_mod.saglayici, "sohbet", sohbet)
    b = {"id": "a" * 32, "ad": "kira.pdf", "birim": "sayfa", "sayfalar": [{"no": 2, "metin": "Madde 2 depozito"}]}
    olaylar = list(derin_mod.derin("depozito yasal mı?", [], "qwen", belgeler=[b]))
    assert any(o["tur"] == "kaynak" and o.get("belge") and o["no"] == 1 for o in olaylar)
    assert "Madde 2 depozito" in istemler[0]


# ---- Ollama'sız çalışma: web sayfası parçaları da embedding olmadan seçilir (kullanıcı Ollama'yı kaldırdı)
def test_web_sayfa_parcalari_embedding_yoksa_kelimeyle_secilir(monkeypatch):
    from sonda import web

    def patla(m):
        raise ConnectionError('model "bge-m3" not found')
    monkeypatch.setattr(web, "embed", patla)
    metin = " ".join(["dolgu metni burada uzun uzun devam ediyor."] * 200) + " Kira artış sınırı TÜFE ortalamasıdır. " \
        + " ".join(["dolgu metni burada uzun uzun devam ediyor."] * 200)
    parcalar = web.alakali_parcalar(metin, "kira artış sınırı", adet=3)
    assert len(parcalar) == 3 and any("TÜFE" in p for p in parcalar)


# ---- son inceleme bulguları
def _cok_sayfali(n=5):
    return {"id": "a" * 32, "ad": "uzun.pdf", "birim": "sayfa",
            "sayfalar": [{"no": i, "metin": f"Sayfa {i} madde metni"} for i in range(1, n + 1)]}


def _sahte_araclar(okunan, web_sonucu=True):
    def arac(ad, arg, soru, kaynaklar, **k):
        if ad == "web_ara":
            if web_sonucu:
                for i in range(5):
                    kaynaklar.ekle(f"https://site{i}.com/yasa", f"Site {i}")
            return ("arama sonuçları" if web_sonucu else "(sonuç yok)"), []
        okunan.append(list(arg["urller"]))
        return "okunan sayfalar", []
    return arac


def test_hizli_modda_belge_varken_web_sayfalari_da_okunur(monkeypatch):
    """İnceleme: belge sayfaları kaynak listesinin başını doldurunca hiçbir web sayfası okunmuyordu."""
    okunan = []
    monkeypatch.setattr(hizli_mod, "json_sor", lambda *a, **k: {"arama": True, "sorgular": ["yasa"]})
    monkeypatch.setattr(hizli_mod, "arac_calistir", _sahte_araclar(okunan))
    monkeypatch.setattr(hizli_mod.saglayici, "sohbet", lambda *a, **k: iter([Parca("tamam")]))
    list(hizli_mod.hizli("yasaya uygun mu?", [], "qwen", belgeler=[_cok_sayfali()]))
    assert okunan and okunan[0] and all(u.startswith("https://") for u in okunan[0])


def test_hizli_modda_web_bossa_belgeyle_devam_eder_ve_modele_soylenir(monkeypatch):
    """İnceleme: web boşken modele boş sayfa_oku çağrısı gidiyordu; web kısmını uydurmasın diye açıkça söylenmeli."""
    okunan, mesajlar_ = [], []
    monkeypatch.setattr(hizli_mod, "json_sor", lambda *a, **k: {"arama": True, "sorgular": ["yasa"]})
    monkeypatch.setattr(hizli_mod, "arac_calistir", _sahte_araclar(okunan, web_sonucu=False))

    def sohbet(model, mesajlar, **k):
        mesajlar_.append(mesajlar)
        return iter([Parca("belgeye göre")])
    monkeypatch.setattr(hizli_mod.saglayici, "sohbet", sohbet)
    olaylar = list(hizli_mod.hizli("yasaya uygun mu?", [], "qwen", belgeler=[_cok_sayfali(1)]))
    assert okunan == [] and olaylar[-1]["metin"] == "belgeye göre"
    gonderilen = mesajlar_[0]
    assert not any(c["function"]["name"] == "sayfa_oku" for m in gonderilen for c in m.get("tool_calls", []))
    assert any("web araması sonuç vermedi" in str(m.get("content", "")).lower() for m in gonderilen)


def test_derin_modda_uzun_belge_web_bulgularini_silmez(monkeypatch):
    """İnceleme: Gemini sınırında belge 60 bin karakteri doldurunca web bulguları rapor isteminden düşüyordu."""
    monkeypatch.setattr(derin_mod, "json_sor", lambda *a, **k: {"alt_sorular": [{"soru": "yasa", "sorgu": "yasa"}]})
    monkeypatch.setattr(derin_mod, "web_ara", lambda *a, **k: [{"url": "https://yasa.gov.tr/a", "baslik": "Yasa",
                                                                "ozet": "WEBBULGUSU konut kira artis tavani 12 aylik TUFE ortalamasidir"}])
    monkeypatch.setattr(derin_mod, "sayfalari_oku", lambda *a, **k: [])
    istemler = []
    monkeypatch.setattr(derin_mod.saglayici, "sohbet", lambda m, mesajlar, **k: istemler.append(mesajlar[0]["content"]) or iter([Parca("r")]))
    uzun = {"id": "a" * 32, "ad": "uzun.pdf", "birim": "sayfa",
            "sayfalar": [{"no": i, "metin": "belge " * 2000} for i in range(1, 7)]}  # ~72 bin karakter
    list(derin_mod.derin("yasal mı?", [], "gemini:gemini-flash-latest", belgeler=[uzun]))
    assert "WEBBULGUSU" in istemler[0]


def test_onceki_belge_kaynagina_yeniden_atif_belge_olarak_kalir():
    """İnceleme: takip cevabında önceki [2] belge kaynağına atıf, kırık bir web bağlantısına dönüşüyordu."""
    onceki = [{"no": 2, "url": f"belge:{'a' * 32}#3", "baslik": "s.pdf · s. 3"}]
    olaylar = list(Kaynaklar(onceki).atiflari_ekle("Artış %25 [2]."))
    assert olaylar and olaylar[0]["belge"] is True and olaylar[0]["alan"] == "s.pdf"


def test_bozuk_pdf_her_hatada_turkce_mesaj(monkeypatch):
    """İnceleme: pypdf'in AttributeError/IndexError gibi hataları 500 ve yanlış mesaj veriyordu."""
    class Bozuk:
        def __init__(self, *a, **k):
            raise AttributeError("'NoneType' object has no attribute 'get_object'")
    monkeypatch.setattr(belge, "PdfReader", Bozuk)
    with pytest.raises(belge.BelgeHatasi, match="okuyamadım"):
        belge.oku("bozuk.pdf", b"%PDF-1.4 bozuk")
