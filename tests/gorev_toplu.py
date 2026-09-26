"""Görevleri çalışan Sonda sunucusuna (python server.py) arayüzdeki gibi verir, olayları ve sonucu kaydeder.
Kullanım: python tests/gorev_toplu.py <etiket> [id,id,...] [--liste zor|uzun] [--model ...] [--kilitli]
Varsayılan: Gemini Flash ve "Butonlara kendisi bassın" açık (--kilitli kapatır). Devretmede DEVIR_BEKLE saniye
bekler (robot doğrulaması kendiliğinden geçebilir), sonra durdurur. Sonuç: tests/sonuc_gorev_<etiket>.json"""
import argparse
import json
import sys
import time
from pathlib import Path

import httpx

KOK = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(KOK / "tests"))

from gorevler import GOREVLER_UZUN, GOREVLER_ZOR  # noqa: E402

SUNUCU = "http://127.0.0.1:8765"
DEVIR_BEKLE = 40
GOREV_SINIRI = 30 * 60
LISTELER = {"zor": GOREVLER_ZOR, "uzun": GOREVLER_UZUN}


def calistir(g, model, serbest):
    basla, sonuc = time.time(), {**g, "adimlar": [], "anlatim": [], "devir": [], "kaynaklar": [], "cevap": ""}
    devir_zamani, gorev_id = None, None

    def yaz(satir):
        print(f"  [{g['id']} {time.time() - basla:5.0f}s] {satir[:160]}", flush=True)

    govde = {"soru": g["gorev"], "gecmis": [], "model": model, "mod": "gorev", "serbest": serbest}
    with httpx.stream("POST", f"{SUNUCU}/api/sor", json=govde, timeout=None) as yanit:
        for satir in yanit.iter_lines():
            if not satir.startswith("data: "):
                continue
            o = json.loads(satir[6:])
            tur = o.get("tur")
            if tur == "gorev_basladi":
                gorev_id = sonuc["gorev_id"] = o["id"]
            elif tur == "adim":
                sonuc["adimlar"].append(f"{o.get('tip')}: {o.get('metin')}")
                yaz(f"{o.get('tip')}: {o.get('metin')}")
            elif tur == "anlatim":
                sonuc["anlatim"].append(o.get("metin"))
            elif tur == "kullaniciya":
                sonuc["devir"].append(o.get("sebep"))
                devir_zamani = time.time()
                yaz(f"DEVİR: {o.get('sebep')}")
            elif tur == "devam_edildi":
                devir_zamani = None
            elif tur == "kaynak":
                sonuc["kaynaklar"].append(o.get("url"))
            elif tur == "token":
                sonuc["cevap"] += o.get("metin", "")
            elif tur == "gorev_bitti":
                sonuc["durum"] = o.get("durum")
            elif tur == "hata":
                sonuc["hata"] = o.get("metin")
                yaz(f"HATA: {o.get('metin')}")
            simdi = time.time()
            gecikti = devir_zamani and simdi - devir_zamani > DEVIR_BEKLE
            if gorev_id and (gecikti or simdi - basla > GOREV_SINIRI):
                httpx.post(f"{SUNUCU}/api/gorev/{gorev_id}/durdur")
                devir_zamani = None
    sonuc["sure"] = round(time.time() - basla, 1)
    return sonuc


def main():
    p = argparse.ArgumentParser()
    p.add_argument("etiket")
    p.add_argument("idler", nargs="?")
    p.add_argument("--model", default="gemini:gemini-flash-latest")
    p.add_argument("--kilitli", action="store_true", help="'Butonlara kendisi bassın' kapalı")
    p.add_argument("--liste", choices=LISTELER, default="zor")
    a = p.parse_args()
    secili = {int(x) for x in a.idler.split(",")} if a.idler else None
    dosya = KOK / "tests" / f"sonuc_gorev_{a.etiket}.json"
    sonuclar = []
    for g in LISTELER[a.liste]:
        if secili and g["id"] not in secili:
            continue
        print(f"#{g['id']} ({g['zorluk']}, {g['alan']}) başlıyor", flush=True)
        try:
            s = calistir(g, a.model, not a.kilitli)
        except Exception as h:
            s = {**g, "hata": f"{type(h).__name__}: {h}"}
        sonuclar.append(s)
        dosya.write_text(json.dumps(sonuclar, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"#{g['id']} bitti: {s.get('sure')} sn, {len(s.get('adimlar', []))} adım, durum={s.get('durum')}, "
              f"devir={len(s.get('devir', []))}\n", flush=True)
    print("HEPSİ BİTTİ", flush=True)


if __name__ == "__main__":
    main()
