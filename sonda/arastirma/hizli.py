"""Hızlı mod: arama kararı, en iyi sayfaları okuma ve araç döngüsü."""
from .. import model as saglayici

from ..ortak import SECENEKLER, bugun, json_sor
from .araclar import ARACLAR, arac_calistir, okuma_butcesi
from .belge_baglami import belge_blogu, belge_ozeti
from .kaynaklar import Kaynaklar
from .promptlar import ARAMA_CALISMIYOR, ON_KARAR_PROMPTU, sistem_promptu


MAKS_ARAC_TURU = 10
WEB_BOS_BELGE_VAR = ("(Not: web araması sonuç vermedi. Cevabı yalnızca ekli belgeye dayandır; güncel/dış bilgi "
                     "gerektiren kısım için webde bulamadığını açıkça söyle, kendi bilginle doldurma.)")


def gecmisi_hazirla(gecmis, onceki_kaynaklar):
    """Uzun mesajları kısaltır; son cevabın kaynak listesini modele görünür yapar."""
    hazir = [{"role": m["role"], "content": m["content"][:4000]} for m in gecmis[-10:]]
    if onceki_kaynaklar and hazir and hazir[-1]["role"] == "assistant":
        liste = "\n".join(f"[{k['no']}] {k.get('baslik', '')} ({k['url']})" for k in onceki_kaynaklar[:30])
        hazir[-1]["content"] += f"\n\n(Bu cevabın kaynakları:\n{liste})"
    return hazir


def hizli(soru, gecmis, model, onceki_kaynaklar=(), diger_sohbetler=(), belgeler=()):
    kaynaklar = Kaynaklar(onceki_kaynaklar)
    gecmis = gecmisi_hazirla(gecmis, onceki_kaynaklar)
    blok, olaylar = belge_blogu(belgeler, soru, model, kaynaklar)  # ekli belgeler: numaralı kaynaklar
    yield from olaylar
    mesajlar = [{"role": "system", "content": sistem_promptu(diger_sohbetler)}, *gecmis,
                {"role": "user", "content": f"{blok}\n\nSORU: {soru}" if blok else soru}]

    # 1) Arama kararını modele bırakmadan orkestratör verir: model eski bilgisiyle cevaplamasın
    son = "\n".join(f"{m['role']}: {m['content'][:400]}" for m in gecmis[-4:])
    ek = f"\n\n{belge_ozeti(belgeler)}" if belgeler else ""  # belgeden cevaplanabilen soruda arama yapılmaz
    karar = json_sor(model, ON_KARAR_PROMPTU.format(tarih=bugun()),
                      f"Önceki konuşma:\n{son or '(yok)'}{ek}\n\nSon mesaj: {soru}")
    dusunme = bool(karar.get("zor"))
    if karar.get("arama", True):
        sorgular = [q for q in karar.get("sorgular", []) if isinstance(q, str) and q.strip()][:3] or [soru]
        arg = {"sorgular": sorgular, "haber": bool(karar.get("haber"))}
        arama_sonucu, olaylar = arac_calistir("web_ara", arg, soru, kaynaklar)
        yield from olaylar
        # En iyi sonuçları doğrudan oku: özetler çoğu zaman ayrıntı için yetersiz
        # Belge sayfaları da kaynak listesinde: okunacaklar yalnızca web sonuçları
        en_iyiler = [k["url"] for k in kaynaklar.liste if not k.get("belge")][:5]
        if not en_iyiler and not belgeler:
            # Model, boş aramada uyarılara rağmen eski bilgisiyle cevap uyduruyor ("henüz oynanmadı" gibi).
            # web_ara zaten yeniden denedi; sonuç yoksa model çağrılmadan dürüstçe söylenir.
            yield {"tur": "token", "metin": ARAMA_CALISMIYOR}
            yield {"tur": "cevap_bitti", "metin": ARAMA_CALISMIYOR}
            return
        if not en_iyiler:  # belge var, web boş: belgeyle cevaplanır ama web kısmı hafızadan uydurulmasın
            mesajlar[-1] = {**mesajlar[-1], "content": f"{mesajlar[-1]['content']}\n\n{WEB_BOS_BELGE_VAR}"}
        else:
            okuma_sonucu, olaylar = arac_calistir("sayfa_oku", {"urller": en_iyiler}, soru, kaynaklar,
                                                  butce=okuma_butcesi(model))
            yield from olaylar
            mesajlar.append({"role": "assistant", "content": "", "tool_calls": [
                {"function": {"name": "web_ara", "arguments": arg}},
                {"function": {"name": "sayfa_oku", "arguments": {"urller": en_iyiler}}}]})
            mesajlar.append({"role": "tool", "content": arama_sonucu[:12000], "tool_name": "web_ara"})
            mesajlar.append({"role": "tool", "content": okuma_sonucu[:arac_siniri(model)] or "(okunacak sayfa yok)",
                             "tool_name": "sayfa_oku"})
    yield from _dongu(mesajlar, soru, model, dusunme, kaynaklar)


def arac_siniri(model):
    """Modele giden okuma sonucu (karakter): bütçeyle okunan 5 sayfa Gemini'ye sığar."""
    return 60000 if str(model).startswith("gemini:") else 16000


def _dongu(mesajlar, soru, model, dusunme, kaynaklar):
    """Ajan döngüsü: model gerekirse ek arama, okuma veya hesap yapar."""
    for tur in range(MAKS_ARAC_TURU + 1):
        son_tur = tur == MAKS_ARAC_TURU
        akis = saglayici.sohbet(model, mesajlar, akis=True, dusun=dusunme,
                                araclar=None if son_tur else ARACLAR, secenekler=SECENEKLER)
        icerik, cagrilar, dusundu = "", [], False
        for parca in akis:
            if parca.dusunce and not dusundu:
                dusundu = True
                yield {"tur": "adim", "tip": "dusun", "metin": "Adım adım akıl yürütüyor"}
            if parca.metin:
                icerik += parca.metin
                yield {"tur": "token", "metin": parca.metin}
            cagrilar.extend(parca.arac_cagrilari)
        if not cagrilar:
            yield from kaynaklar.atiflari_ekle(icerik)
            yield {"tur": "cevap_bitti", "metin": icerik}
            return
        if icerik:
            yield {"tur": "sifirla"}
        mesajlar.append({"role": "assistant", "content": icerik, "tool_calls": [
            {"function": {"name": c.ad, "arguments": c.argumanlar}, "imza": c.imza} for c in cagrilar]})
        for c in cagrilar:
            sonuc, olaylar = arac_calistir(c.ad, dict(c.argumanlar), soru, kaynaklar, butce=okuma_butcesi(model))
            yield from olaylar
            mesajlar.append({"role": "tool", "content": sonuc[:arac_siniri(model)], "tool_name": c.ad})
