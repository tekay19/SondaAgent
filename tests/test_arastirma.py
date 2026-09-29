"""Araştırma modunun derinleşmesi: bütçeyle okuma, çok turlu eksik tamamlama, doğrulama, yapılı rapor."""
import importlib

from sonda import web
from sonda.model import Parca

araclar = importlib.import_module("sonda.arastirma.araclar")
hizli_mod = importlib.import_module("sonda.arastirma.hizli")
derin_mod = importlib.import_module("sonda.arastirma.derin")
promptlar = importlib.import_module("sonda.arastirma.promptlar")


def _embed_yok(monkeypatch):
    def patla(m):
        raise ConnectionError("ollama yok")
    monkeypatch.setattr(web, "embed", patla)


# ---- 1. daha derin okuma
def test_okuma_butcesi_modele_gore():
    assert araclar.okuma_butcesi("gemini:gemini-flash-latest") == 8000
    assert araclar.okuma_butcesi("qwen3.6:35b-a3b") is None


def test_butce_sayfadan_buyukse_sayfanin_tamami_okunur(monkeypatch):
    _embed_yok(monkeypatch)
    metin = " ".join(f"Cümle {i} burada anlatılan ayrıntıdır." for i in range(130))  # ~5000 karakter
    parcalar = web.alakali_parcalar(metin, "ayrıntı", butce=8000)
    okunan = " ".join(parcalar)
    assert "Cümle 0 " in okunan and "Cümle 129 " in okunan


def test_butce_asilirsa_en_ilgili_parcalar_sayfa_sirasiyla(monkeypatch):
    _embed_yok(monkeypatch)
    dolgu = "dolgu metni burada uzun uzun devam ediyor. " * 60
    metin = dolgu + " Depozito iki kira bedelidir. " + dolgu + " Kira artışı TÜFE ortalamasıdır. " + dolgu
    parcalar = web.alakali_parcalar(metin, "depozito kira artışı", butce=2000)
    assert sum(len(p) for p in parcalar) <= 2000
    okunan = " ".join(parcalar)
    assert "Depozito" in okunan and "TÜFE" in okunan
    assert okunan.index("Depozito") < okunan.index("TÜFE")  # sayfadaki sıra korunur


def test_butce_yoksa_eski_uc_parca(monkeypatch):
    _embed_yok(monkeypatch)
    metin = "kelime " * 3000
    assert len(web.alakali_parcalar(metin, "kelime", adet=3)) == 3


def test_hizli_gemini_de_bes_sayfa_butceyle_okunur(monkeypatch):
    cagri = {}

    def sayfalari_oku(urller, soru, adet=3, butce=None):
        cagri.update(urller=urller, butce=butce)
        return [{"url": u, "baslik": u, "parcalar": ["metin"]} for u in urller]
    monkeypatch.setattr(araclar, "sayfalari_oku", sayfalari_oku)
    monkeypatch.setattr(araclar, "web_ara", lambda *a, **k: [{"url": f"https://s{i}.com/a", "baslik": "b", "ozet": "o"} for i in range(8)])
    monkeypatch.setattr(hizli_mod, "json_sor", lambda *a, **k: {"arama": True, "sorgular": ["x"]})
    monkeypatch.setattr(hizli_mod.saglayici, "sohbet", lambda *a, **k: iter([Parca("cevap")]))
    list(hizli_mod.hizli("soru", [], "gemini:gemini-flash-latest"))
    assert cagri["butce"] == 8000 and len(cagri["urller"]) == 5


# ---- 2-4. derin: çok kaynak, çok turlu eksik, doğrulama, yapılı rapor
class _Derin:
    """Sahte arama/okuma/model: kaç arama yapıldığını ve rapor istemini kaydeder."""

    def __init__(self, monkeypatch, eksik_turlari=2, iddialar=()):
        self.aramalar, self.eksik_cagrisi, self.rapor, self.okuma_butcesi = [], 0, "", None
        self.eksik_turlari, self.iddialar = eksik_turlari, list(iddialar)
        monkeypatch.setattr(derin_mod, "web_ara", self.web_ara)
        monkeypatch.setattr(derin_mod, "sayfalari_oku", self.sayfalari_oku)
        monkeypatch.setattr(derin_mod, "json_sor", self.json_sor)
        monkeypatch.setattr(derin_mod.saglayici, "sohbet", self.sohbet)

    def web_ara(self, sorgular, soru="", adet=8, haber=False):
        self.aramalar.append(sorgular[0])
        n = len(self.aramalar)
        return [{"url": f"https://site{n}-{i}.com/s", "baslik": f"Kaynak {n}-{i}", "ozet": "özet " * 20} for i in range(8)]

    def sayfalari_oku(self, urller, soru, adet=3, butce=None):
        self.okuma_butcesi = butce
        return [{"url": u, "baslik": u, "metin": "x", "parcalar": [f"{u} sayfasının uzun içeriği " * 3]} for u in urller]

    def json_sor(self, model, sistem, girdi=""):
        if "alt soruya böl" in sistem:
            return {"alt_sorular": [{"soru": f"alt {i}", "sorgu": f"sorgu {i}"} for i in range(9)]}
        if "iddia" in sistem.lower():  # doğrulama istemi bulguları da içerir (orada "eksik 1" geçebilir): önce bu
            return {"iddialar": self.iddialar}
        if "eksik" in sistem.lower():
            self.eksik_cagrisi += 1
            if self.eksik_cagrisi <= self.eksik_turlari:
                return {"eksikler": [{"soru": f"eksik {self.eksik_cagrisi}", "sorgu": f"eksik sorgu {self.eksik_cagrisi}"}]}
            return {"eksikler": []}
        return {}

    def sohbet(self, model, mesajlar, **k):
        self.rapor = mesajlar[0]["content"]
        return iter([Parca("RAPOR")])


def test_derin_yedi_alt_soru_ve_sayfa_basina_alti(monkeypatch):
    d = _Derin(monkeypatch, eksik_turlari=0)
    olaylar = list(derin_mod.derin("güneş paneli mantıklı mı?", [], "gemini:gemini-flash-latest"))
    assert d.aramalar[:7] == [f"sorgu {i}" for i in range(7)] and "sorgu 7" not in d.aramalar
    assert d.okuma_butcesi == 8000
    assert sum(1 for o in olaylar if o["tur"] == "kaynak") >= 7 * 6


def test_derin_eksik_tamamlama_birden_cok_tur_ve_en_cok_uc(monkeypatch):
    d = _Derin(monkeypatch, eksik_turlari=2)
    list(derin_mod.derin("soru", [], "gemini:x"))
    assert d.eksik_cagrisi == 3 and "eksik sorgu 1" in d.aramalar and "eksik sorgu 2" in d.aramalar
    d = _Derin(monkeypatch, eksik_turlari=99)
    list(derin_mod.derin("soru", [], "gemini:x"))
    assert d.eksik_cagrisi == derin_mod.EKSIK_TURU == 3


def test_tek_kaynakli_iddia_icin_hedefli_arama_ve_rapora_dogrulama(monkeypatch):
    d = _Derin(monkeypatch, eksik_turlari=0, iddialar=[
        {"iddia": "Teşvik oranı %25", "kaynaklar": [3], "sorgu": "güneş paneli teşvik oranı 2026"},
        {"iddia": "Geri dönüş 6 yıl", "kaynaklar": [1, 9], "sorgu": "geri dönüş süresi"},
        {"iddia": "Panel fiyatı", "kaynaklar": [2, 4], "celiski": "A: 20.000 TL, B: 26.000 TL", "sorgu": "panel fiyatı"}])
    list(derin_mod.derin("soru", [], "gemini:x"))
    assert "güneş paneli teşvik oranı 2026" in d.aramalar and "geri dönüş süresi" not in d.aramalar
    assert "DOĞRULAMA" in d.rapor and "Teşvik oranı %25" in d.rapor and "20.000 TL" in d.rapor


def test_rapor_promptu_yapili():
    p = promptlar.RAPOR_PROMPTU.lower()
    for ifade in ("kısaca", "güven düzeyi", "sınırlılıklar", "doğrulama", "açık kalan"):
        assert ifade in p, ifade


def test_derin_rapor_siniri_geminide_buyuk():
    assert derin_mod.rapor_siniri("gemini:x") >= 200000 and derin_mod.rapor_siniri("qwen") == 60000
