"""Görevler arası kalıcı site hafızası: Sonda hangi sitede ne yaptı, orada neyi öğrendi.

Her görevin sonunda ziyaret edilen her site için yapılanlar (açılan sayfalar, tıklamalar, engeller, robot
doğrulamaları) kod tarafından kaydedilir; model de o siteye özgü kısa dersler çıkarır ("şehir filtresi sayfası robot
doğrulaması çıkarıyor, ?kw= araması çalışıyor"). Sonraki görevlerde model o siteye girince bunları istemde görür.
Not içerikleri (kişisel bilgi olabilir) ve şifreler hafızaya yazılmaz."""
import json
import re
import threading
import time
from pathlib import Path
from urllib.parse import urlparse

from .. import koruma
from .. import model as saglayici
from ..ortak import JSON_SECENEKLERI, bugun
from ..web import alan_adi

DOSYA = Path(__file__).resolve().parents[2] / "veri" / "site_hafizasi.json"
EN_FAZLA_SITE = 200
KAYIT_SAYISI = 5  # site başına saklanan son ziyaret
DERS_SAYISI = 6  # site başına ders
ISTEM_SINIRI = 1500  # istemdeki site hafızası (karakter)
DERS_CIKAR = True  # görev sonunda model dersleri çıkarır (testler kapatır)
_ATLA = {"", "about:blank"}
_kilit = threading.Lock()

DERS_PROMPTU = """Bugün {tarih}. Kullanıcının tarayıcısında bir görev yürüttün. Aşağıda görevin adımları ve her site
için önceden bildiğin dersler var. Her site için, SONRAKİ görevlerde o sitede işini hızlandıracak ya da hatayı
önleyecek kısa, somut dersler yaz: hangi adres/arama biçimi işe yaradı, hangi buton nerede, hangi sayfa robot
doğrulaması ya da giriş istiyor, hangi yol çıkmaz sokaktı, sitenin bir kısıtı (ör. "Türkiye'den otel göstermiyor").
Kurallar: her ders tek cümle; yalnızca adımlarda kanıtı olan şeyleri yaz; göreve özgü içerik (fiyat, ürün adı,
kişisel bilgi) yazma, siteye özgü kullanım bilgisi yaz; eski dersi yeni kanıt çürütüyorsa düzelt ya da çıkar; site
başına en çok {sinir} ders. Arama motorlarını (google.com arama sonuçları) yalnızca gerçekten öğrenilen bir şey varsa yaz.
Sadece JSON döndür: {{"siteler": {{"alan.adi": ["ders", "..."]}}}}"""


def yukle():
    try:
        veri = json.loads(DOSYA.read_text(encoding="utf-8"))
        return veri if isinstance(veri, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def _yaz(veri):
    if len(veri) > EN_FAZLA_SITE:  # en eski ziyaret edilenler düşer
        veri = dict(sorted(veri.items(), key=lambda kv: kv[1].get("son", 0))[-EN_FAZLA_SITE:])
    try:
        DOSYA.parent.mkdir(parents=True, exist_ok=True)
        DOSYA.write_text(json.dumps(veri, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError:
        pass  # hafıza yazılamazsa görev yine sonuçlanır


def _yol(url):
    p = urlparse(url)
    return (p.path or "/") + (f"?{p.query}" if p.query else "")


def ziyaretleri_topla(sayfalar):
    """SayfaHafizasi.sayfalar -> {alan adı: {"sayfalar": [...], "yapilanlar": [...]}}"""
    siteler = {}
    for url, k in sayfalar.items():
        site = alan_adi(url)
        if url in _ATLA or not site:
            continue
        s = siteler.setdefault(site, {"sayfalar": [], "yapilanlar": []})
        s["sayfalar"].append(f"{_yol(url)[:120]} “{k.get('baslik', '')[:60]}”")
        s["yapilanlar"] += [e[:100] for e in k.get("eylemler", [])]
        if k.get("notlar"):
            s["yapilanlar"].append(f"{len(k['notlar'])} not alındı")
    return siteler


def kaydet(gorev_metni, sayfalar, adimlar, hal, gizliler=(), model=None, arka_planda=True):
    """Görev bitince çağrılır: ziyaretler hemen yazılır; model verilirse dersler (bir model çağrısı) çıkarılır."""
    siteler = ziyaretleri_topla(sayfalar)
    if not siteler:
        return None
    gorev = koruma.gizle(gorev_metni, gizliler)[:120]
    simdi = int(time.time())
    with _kilit:
        veri = yukle()
        for site, z in siteler.items():
            k = veri.setdefault(site, {"ziyaret": 0, "son": 0, "kayitlar": [], "dersler": []})
            k["ziyaret"] += 1
            k["son"] = simdi
            k["kayitlar"] = (k["kayitlar"] + [{
                "zaman": time.strftime("%Y-%m-%d %H:%M"), "gorev": gorev, "sonuc": hal[:120],
                "sayfalar": [koruma.gizle(s, gizliler) for s in z["sayfalar"][-8:]],
                "yapilanlar": [koruma.gizle(y, gizliler) for y in z["yapilanlar"][-12:]]}])[-KAYIT_SAYISI:]
        _yaz(veri)
    if model is None or not DERS_CIKAR:
        return None
    is_ = threading.Thread(target=dersleri_guncelle, args=(model, gorev, list(siteler), list(adimlar), gizliler),
                           daemon=True)
    is_.start()
    if not arka_planda:
        is_.join()
    return is_


def dersleri_guncelle(model, gorev, siteler, adimlar, gizliler=()):
    """Görevin adımlarından site başına dersler çıkarır ve hafızadakilerle birleştirir. Hata olursa sessizce geçer."""
    bilinen = yukle()
    onceki = "\n".join(f"{s}: " + ("; ".join(bilinen.get(s, {}).get("dersler", [])) or "(yok)") for s in siteler)
    icerik = (f"GÖREV: {gorev}\n\nZİYARET EDİLEN SİTELER VE BİLİNEN DERSLER:\n{onceki}\n\nADIMLAR:\n"
              + "\n".join(adimlar[-80:]))
    try:
        yanit = saglayici.sohbet(model, [
            {"role": "system", "content": DERS_PROMPTU.format(tarih=bugun(), sinir=DERS_SAYISI)},
            {"role": "user", "content": koruma.gizle(icerik, gizliler)}], json=True, secenekler=JSON_SECENEKLERI)
        yeni = json.loads(yanit.metin).get("siteler")
    except Exception:
        return
    if not isinstance(yeni, dict):
        return
    with _kilit:
        veri = yukle()
        for site, dersler in yeni.items():
            site = alan_adi(f"https://{site}") if "://" not in str(site) else alan_adi(site)
            if site not in veri or not isinstance(dersler, list):
                continue
            temiz = [koruma.gizle(str(d).strip(), gizliler)[:200] for d in dersler if str(d).strip()]
            veri[site]["dersler"] = temiz[:DERS_SAYISI]
        _yaz(veri)


def _site_metni(site, k):
    satirlar = [f"{site} ({k.get('ziyaret', 0)} kez ziyaret edildi)"]
    for d in k.get("dersler", []):
        satirlar.append(f"  - {d}")
    if kayitlar := k.get("kayitlar"):
        son = kayitlar[-1]
        satirlar.append(f"  son ziyaret {son['zaman']}: “{son['gorev'][:80]}” → {son['sonuc'][:60]}")
        if son.get("yapilanlar"):
            satirlar.append("  orada yaptıkların: " + "; ".join(son["yapilanlar"][-6:]))
    return "\n".join(satirlar)


def _gecen_siteler(gorev_metni, veri):
    """Görev metninde adı geçen, hafızada olan siteler (ör. "Kariyer.net", "tr.indeed.com", "Trendyol")."""
    sade = koruma.sade(gorev_metni)
    bulunan = []
    for site in veri:
        govde = site.split(".")[0] if not site.startswith("tr.") else site.split(".")[1]
        if len(govde) >= 4 and re.search(rf"\b{re.escape(govde)}", sade):
            bulunan.append(site)
    return bulunan


def istem_metni(url="", gorev_metni=""):
    """Modele giden site hafızası: şu anki site ve görevde adı geçen siteler. Hafıza yoksa boş metin."""
    veri = yukle()
    siteler = []
    if (site := alan_adi(url)) in veri:
        siteler.append(site)
    siteler += [s for s in _gecen_siteler(gorev_metni, veri) if s not in siteler]
    if not siteler:
        return ""
    metin = "\n".join(_site_metni(s, veri[s]) for s in siteler)
    return ("SİTE HAFIZAN (önceki görevlerde bu sitelerde yaşadıkların; işine yarıyorsa kullan, sayfa farklıysa "
            "sayfaya güven):\n" + metin[:ISTEM_SINIRI])
