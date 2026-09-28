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
