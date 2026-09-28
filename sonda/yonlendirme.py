"""Görev modunda gelen mesajın ne olduğuna karar verir: tarayıcı görevi ya da sohbet.
Böylece "teşekkürler" ya da "tabloyu kısalt" gibi mesajlar tarayıcı açmadan cevaplanır."""
from .model import ModelHatasi
from .ortak import bugun, json_sor

HEDEFLER = ("gorev", "sohbet")

YON_PROMPTU = """Bugün {tarih}. Kullanıcı Sonda'nın "Görev" modunda bir mesaj yazdı. Sonda bu modda kullanıcının
tarayıcısında sitelere girip iş yapabilir. Mesajın ne olduğuna karar ver. Sadece JSON: {{"hedef": "gorev|sohbet"}}
- gorev: varsayılan. Tarayıcıda sitelere girip gezinmek, aramak, incelemek, karşılaştırmak, form doldurmak,
  hesapta/profilde bir şeye bakmak ya da düzenlemek, sepete eklemek, bir sitede bir şey açmak/oluşturmak. Yeni
  bilgi gerektiren her soru da gorev'dir ("dolar kaç?", "nasıl yapılır?"): tarayıcıda Google'da aranır. Önceki
  konuşmayla ilgili olsa bile yeni bir iş ya da yeni bilgi isteyen mesaj gorev'dir ("şimdi ikincisini sepete ekle",
  "aynısını Amazon'da da bak", "tamam şimdi aç", "sen yap", "gir ve oluştur").
- sohbet: SADECE selam, teşekkür, "tamam" gibi kısa onaylar ya da önceki cevabın kendisini yeniden biçimlendirme /
  açıklama isteği ("tabloyu kısalt", "neden öyle dedin?", "bunu İngilizceye çevir").
Emin değilsen gorev."""


def yon_belirle(model, soru, gecmis):
    son = "\n".join(f"{m['role']}: {m['content'][:300]}" for m in list(gecmis)[-4:])
    try:
        veri = json_sor(model, YON_PROMPTU.format(tarih=bugun()), f"Önceki konuşma:\n{son or '(yok)'}\n\nSon mesaj: {soru}")
    except ModelHatasi:
        raise  # anahtar/kota sorunu: tarayıcı boşuna açılmasın, kullanıcı hemen görsün
    except Exception:
        return "gorev"
    hedef = veri.get("hedef") if isinstance(veri, dict) else None
    return hedef if hedef in HEDEFLER else "gorev"
