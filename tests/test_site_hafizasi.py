"""Görevler arası site hafızası: nerede ne yapıldığı kaydedilir, dersler birleşir, istemde görünür."""
import json

import pytest

from sonda.gorev import site_hafizasi as sh
from sonda.model import Yanit


@pytest.fixture(autouse=True)
def _dersler_acik(monkeypatch):
    monkeypatch.setattr(sh, "DERS_CIKAR", True)


def _sayfalar():
    return {
        "about:blank": {"baslik": "", "eylemler": [], "notlar": []},
        "https://www.kariyer.net/is-ilanlari?kw=python": {
            "baslik": "Python iş ilanları", "eylemler": ["“İzmir” tıklandı"], "notlar": ["gizli kişisel not"]},
        "https://www.kariyer.net/is-ilanlari/izmir?kw=python": {
            "baslik": "", "eylemler": ["robot doğrulaması çıktı, çözülemedi; site atlandı"], "notlar": []},
        "https://tr.indeed.com/jobs?q=python": {"baslik": "Indeed", "eylemler": [], "notlar": []},
    }


def test_ziyaretler_site_basina_kaydedilir_notlar_yazilmaz():
    sh.kaydet("Python ilanlarını ara, şifre: Gizli1234", _sayfalar(), [], "Görev tamamlandı.", gizliler={"Gizli1234"})
    veri = sh.yukle()
    assert set(veri) == {"kariyer.net", "tr.indeed.com"}
    k = veri["kariyer.net"]
    assert k["ziyaret"] == 1 and len(k["kayitlar"]) == 1
    metin = json.dumps(veri, ensure_ascii=False)
    assert "robot doğrulaması çıktı" in metin and "1 not alındı" in metin
    assert "gizli kişisel not" not in metin and "Gizli1234" not in metin


def test_ziyaret_sayisi_artar_kayitlar_sinirlanir():
    for _ in range(sh.KAYIT_SAYISI + 2):
        sh.kaydet("görev", _sayfalar(), [], "bitti")
    k = sh.yukle()["kariyer.net"]
    assert k["ziyaret"] == sh.KAYIT_SAYISI + 2 and len(k["kayitlar"]) == sh.KAYIT_SAYISI


def test_model_dersleri_birlesir(monkeypatch):
    istemler = []

    def sahte_sohbet(model, mesajlar, **k):
        istemler.append(mesajlar[-1]["content"])
        return Yanit(json.dumps({"siteler": {"kariyer.net": ["Şehir filtresi sayfası basılı tut doğrulaması çıkarıyor."],
                                             "bilinmeyen.com": ["yok sayılmalı"]}}), [])
    monkeypatch.setattr(sh.saglayici, "sohbet", sahte_sohbet)
    sh.kaydet("görev", _sayfalar(), ["1. kariyer.net açıldı"], "bitti", model="m", arka_planda=False)
    veri = sh.yukle()
    assert veri["kariyer.net"]["dersler"] == ["Şehir filtresi sayfası basılı tut doğrulaması çıkarıyor."]
    assert "bilinmeyen.com" not in veri
    assert "kariyer.net açıldı" in istemler[0]


def test_model_hatasi_hafizayi_bozmaz(monkeypatch):
    def patla(*a, **k):
        raise RuntimeError("model yok")
    monkeypatch.setattr(sh.saglayici, "sohbet", patla)
    sh.kaydet("görev", _sayfalar(), [], "bitti", model="m", arka_planda=False)
    assert sh.yukle()["kariyer.net"]["ziyaret"] == 1


def test_istem_su_anki_siteyi_ve_gorevde_gecenleri_gosterir():
    sh.kaydet("görev", _sayfalar(), [], "bitti")
    assert sh.istem_metni("https://www.kariyer.net/x").count("kariyer.net (1 kez") == 1
    metin = sh.istem_metni("https://google.com", "Kariyer.net ve Indeed'de ilan ara")
    assert "SİTE HAFIZAN" in metin and "kariyer.net" in metin and "tr.indeed.com" in metin
    assert sh.istem_metni("https://example.com", "hava durumu") == ""


def test_gorev_sonunda_site_hafizasi_yazilir_ve_sonraki_gorevde_istemde_gorunur(yerel_tarayici_ac, site, monkeypatch):
    from sonda import gorev
    from test_gorev import DERINLIK, SahteModel
    monkeypatch.setattr(gorev.karar, "derinlik_belirle", lambda *a: dict(DERINLIK))
    monkeypatch.setattr(gorev.karar, "ilerleme_degerlendir", lambda *a: {})
    monkeypatch.setattr(gorev.karar, "gorev_kontrolu", lambda *a: [])
    monkeypatch.setattr(gorev.dongu, "sonuc_yaz", lambda *a, **k: iter([{"tur": "cevap_bitti", "metin": "ÖZET"}]))
    monkeypatch.setattr(sh.saglayici, "sohbet", lambda *a, **k: Yanit('{"siteler": {}}', []))
    for _ in range(2):
        m = SahteModel([{"eylem": "git", "url": f"{site}/uzun.html"}, {"eylem": "kaydir", "yon": "asagi"}])
        monkeypatch.setattr(gorev.karar, "karar_al", m)
        list(gorev.calistir("uzun sayfayı incele", "sahte", tarayici_ac=yerel_tarayici_ac))
        gorev.tarayici_isinde(lambda: None)
    assert sh.yukle()["127.0.0.1:" + site.rsplit(":", 1)[1]]["ziyaret"] == 2
    assert any("SİTE HAFIZAN" in i and "kaydırıldı" in i for i in m.istemler[1:])
