"""Derin araştırma modu: alt sorular, çok turlu eksik tamamlama, iddia doğrulama ve yapılı rapor."""
from .. import model as saglayici

from .. import hafiza
from ..ortak import SECENEKLER, bugun, json_sor
from ..web import alan_adi, sayfalari_oku, web_ara
from .araclar import arama_olayi, okuma_butcesi
from .belge_baglami import belge_blogu, belge_ozeti
from .hizli import gecmisi_hazirla
from .kaynaklar import Kaynaklar
from .promptlar import DOGRULAMA_PROMPTU, EKSIK_PROMPTU, PLAN_PROMPTU, RAPOR_PROMPTU

ALT_SORU = 7  # plandaki en çok alt soru
SAYFA = 6  # alt soru başına okunan sayfa
EKSIK_TURU = 3  # "hâlâ eksik ne?" turu; model eksik yok deyince erken biter
EN_FAZLA_KAYNAK = 80  # plan tek başına 7 x 8 kaynağa ulaşabilir; eksik turları buna rağmen çalışsın
DOGRULANACAK = 4  # tek kaynakta kalan en önemli iddialar için hedefli arama


def rapor_siniri(model):
    """Rapor istemine giden bulgular (karakter): Gemini sayfaların tamamına yakınını kaldırır."""
    return 200000 if str(model).startswith("gemini:") else 60000


def _alt_sorulari_arastir(liste, kaynaklar, okunan, bulgular, butce=None, sayfa=SAYFA):
    for p in liste:
        sorgular = [s for s in (p.get("sorgu"), p.get("sorgu_en")) if isinstance(s, str) and s.strip()]
        if not sorgular:
            continue
        haber = bool(p.get("haber"))
        alt_soru = p.get("soru") or sorgular[0]
        sonuclar = web_ara(sorgular, soru=alt_soru, adet=8, haber=haber)
        yield arama_olayi(sorgular, haber, len(sonuclar))

        yeni = [r["url"] for r in sonuclar if r["url"] not in okunan][:sayfa]
        okunan.update(yeni)
        if yeni:
            yield {"tur": "adim", "tip": "oku", "metin": ", ".join(alan_adi(u) for u in yeni)}
        sayfalar = {s["url"]: s for s in sayfalari_oku(yeni, alt_soru, adet=3, butce=butce)}
        for r in sonuclar[:sayfa + 2]:
            sayfa_ = sayfalar.get(r["url"], {})
            parcalar = sayfa_.get("parcalar") or [r["ozet"]]
            if not any(len(x) > 40 for x in parcalar):
                continue
            no, olay = kaynaklar.ekle(r["url"], r["baslik"])
            if olay:
                yield olay
            bulgular.append({"no": no, "baslik": r["baslik"], "alt_soru": alt_soru,
                             "metin": "\n...\n".join(parcalar), "tam": bool(sayfa_.get("parcalar"))})


def _bulgu_metni(bulgular):
    bulgular = sorted(bulgular, key=lambda b: not b["tam"])  # tam okunan sayfalar önce
    return "\n\n".join(f"[{b['no']}] {b['baslik']} (konu: {b['alt_soru']})\n{b['metin']}" for b in bulgular)


def _dogrula(model, soru, bulgular, kaynaklar, okunan, butce):
    """Önemli iddiaları çıkarır; tek kaynakta kalanlar için hedefli arama yapar. Rapora gidecek tabloyu döner."""
    try:
        veri = json_sor(model, DOGRULAMA_PROMPTU.format(tarih=bugun(), soru=soru, bulgular=_bulgu_metni(bulgular)[:60000]))
    except Exception:
        return ""
    iddialar = [i for i in (veri.get("iddialar") if isinstance(veri, dict) else None) or []
                if isinstance(i, dict) and str(i.get("iddia") or "").strip()][:10]
    if not iddialar:
        return ""
    tek = [i for i in iddialar if len(set(i.get("kaynaklar") or [])) < 2 and str(i.get("sorgu") or "").strip()]
    if tek:
        yield {"tur": "adim", "tip": "plan", "metin": f"Doğrulama: {len(tek[:DOGRULANACAK])} iddia ikinci kaynakta aranıyor",
               "detay": [i["iddia"] for i in tek[:DOGRULANACAK]]}
        yield from _alt_sorulari_arastir([{"soru": i["iddia"], "sorgu": i["sorgu"]} for i in tek[:DOGRULANACAK]],
                                         kaynaklar, okunan, bulgular, butce, sayfa=3)
    satirlar = []
    for i in iddialar:
        nolar = "".join(f"[{n}]" for n in sorted(set(i.get("kaynaklar") or [])))
        if str(i.get("celiski") or "").strip():
            durum = f"kaynaklar çelişiyor: {i['celiski']}"
        elif len(set(i.get("kaynaklar") or [])) >= 2:
            durum = "iki ya da daha çok kaynakta aynı"
        elif i in tek[:DOGRULANACAK]:
            durum = "tek kaynak; ikinci kaynak arandı (yeni bulgulara bak)"
        else:
            durum = "tek kaynak"
        satirlar.append(f"- {i['iddia']} {nolar}: {durum}")
    return "\n".join(satirlar)


def derin(soru, gecmis, model, onceki_kaynaklar=(), diger_sohbetler=(), belgeler=()):
    kaynaklar, okunan, bulgular = Kaynaklar(onceki_kaynaklar), set(), []
    butce, sinir = okuma_butcesi(model), rapor_siniri(model)
    gecmis = gecmisi_hazirla(gecmis, onceki_kaynaklar)
    baglam = "\n".join(f"{m['role']}: {m['content'][:400]}" for m in gecmis[-4:])
    istek = f"Önceki konuşma:\n{baglam}\n\nAraştırma sorusu: {soru}" if baglam else soru
    if belgeler:
        istek = f"{belge_ozeti(belgeler)}\n\n{istek}"  # plan belgeyi bilsin: belgede olanı webde arama
    # Belge rapor bütçesinin en çok yarısını alır: web bulguları istemden düşmesin
    belge_metni, olaylar = belge_blogu(belgeler, soru, model, kaynaklar, sinir=sinir // 2)
    yield from olaylar

    yield {"tur": "adim", "tip": "plan", "metin": "Araştırma planı hazırlanıyor"}
    plan = json_sor(model, PLAN_PROMPTU.format(tarih=bugun()), istek).get("alt_sorular", [])
    plan = [p for p in plan if isinstance(p, dict) and p.get("sorgu")][:ALT_SORU] or [{"soru": soru, "sorgu": soru}]
    yield {"tur": "adim", "tip": "plan", "metin": f"{len(plan)} alt soru",
           "detay": [p.get("soru", p["sorgu"]) for p in plan]}
    yield from _alt_sorulari_arastir(plan, kaynaklar, okunan, bulgular, butce)

    # Eksik tamamlama: model "eksik yok" diyene kadar en çok EKSIK_TURU tur
    for tur in range(1, EKSIK_TURU + 1):
        if len(kaynaklar.liste) >= EN_FAZLA_KAYNAK:
            break
        ozet = "\n".join(f"- {b['alt_soru']}: {b['baslik']}" for b in bulgular)[:8000]
        try:
            eksikler = json_sor(model, EKSIK_PROMPTU.format(tarih=bugun(), soru=soru, ozet=ozet)).get("eksikler", [])
        except Exception:
            break
        eksikler = [e for e in eksikler if isinstance(e, dict) and e.get("sorgu")][:3]
        if not eksikler:
            break
        yield {"tur": "adim", "tip": "plan", "metin": f"Eksik bilgi turu {tur}: {len(eksikler)} ek soru",
               "detay": [e.get("soru", e["sorgu"]) for e in eksikler]}
        yield from _alt_sorulari_arastir(eksikler, kaynaklar, okunan, bulgular, butce)

    dogrulama = yield from _dogrula(model, soru, bulgular, kaynaklar, okunan, butce)

    metin = _bulgu_metni(bulgular)
    if belge_metni:
        metin = f"{belge_metni}\n\n{metin[:sinir - len(belge_metni) - 2]}"
    yield {"tur": "adim", "tip": "yaz", "metin": f"{len(kaynaklar.liste)} kaynaktan rapor yazılıyor"}
    hafiza_metni = hafiza.istem_metni()
    sistem = RAPOR_PROMPTU.format(tarih=bugun(), bulgular=metin[:sinir], dogrulama=dogrulama or "(doğrulama tablosu yok)",
                                  hafiza=f"\n{hafiza_metni}\n" if hafiza_metni else "")
    akis = saglayici.sohbet(model, [{"role": "system", "content": sistem}, *gecmis[-4:],
                                    {"role": "user", "content": soru}], akis=True, secenekler=SECENEKLER,
                            dusun=str(model).startswith("gemini:"))  # raporu önce düşünerek kur
    rapor = ""
    for parca in akis:
        if parca.metin:
            rapor += parca.metin
            yield {"tur": "token", "metin": parca.metin}
    yield {"tur": "cevap_bitti", "metin": rapor}
