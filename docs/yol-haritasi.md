# Sonda — Yol Haritası ve Açık Kararlar

*Son güncelleme: 28 Eylül 2026*

## 000. Sohbete belge ekleme (A) — tamamlandı

PDF (metinli), Word, .txt, .md sohbete eklenir (ataç ya da sürükle-bırak; en çok 5 belge, 20 MB). Kısa belge modele
tamamen, uzun belge `bge-m3` ile soruya en yakın parçalarla gider (Gemini 60 bin, yerel 15 bin karakter). Ön karar
belgeden cevaplanabilen soruda web araması yapmaz; belge kaynakları 📄 "ad · s. N" olarak numaralı kaynak listesine
girer. Yerel modelde belge bilgisayardan çıkmaz; Gemini seçiliyse arayüz uyarır. Tasarım:
`docs/superpowers/specs/2026-09-28-belge-ekleme-design.md`.
Canlı deneme: Gemini Flash ile .docx kira sözleşmesi: "3 maddede özetle" 9 sn, web araması yok, 📄 kaynaklı ve doğru. "Madde 4 yasal sınıra uygun mu?" web aramasını doğru başlattı (10 kaynak) ama sayfa okumada `bge-m3 not found` hatası: Ollama'daki modeller (qwen'ler ve bge-m3) silinmiş görünüyor; web sayfası okuma (`web.alakali_parcalar`) embedding yedeği olmadığı için Gemini'de de düşüyor. Yerel model senaryosu model olmadığından denenemedi.
Sıradaki: oturumu açık sitelerden okuma ve analiz (Upwork, e-Devlet, banka ekstresi).

## 00. Görev modu gerçek testleri (26 Eylül)

"Butonlara kendisi bassın" kutucuğu gerçek sitelerde, Gemini Flash ile test edildi. Toplu çalıştırıcı:
`python tests/gorev_toplu.py <etiket> [--liste zor|uzun]` (sunucu açıkken; sonuç `tests/sonuc_gorev_<etiket>.json`).

**Trendyol powerbank testi:** Ürünü favorilere ve sepete ekledi (Chrome'da doğrulandı) ama birkaç seçeneği
karşılaştırmadan ilk ürünü seçti. Bu, aşağıdaki "aday kapısı"nı doğurdu.

**Bulunan ve düzeltilen hatalar:**

| Sorun (canlı testte) | Düzeltme |
|---|---|
| Kutucuk açıkken "Ödemeyi Gönder", "Para Çek", "Hesap Sil", "Start free trial" gibi butonlar geçiyordu; SPA ödeme sayfasında form dışı "Onayla" basılabiliyordu | Para kuralı genişledi; ödeme sayfası adresten ya da kart/IBAN/kod alanından tanınır, orada kutucuk geçmez |
| "Birkaç seçeneği karşılaştır" denmişken tek ürüne bakıp sepete ekledi | Seçim görevinde en az N adayın kendi sayfası incelenmeden sepete ekleme/favori/başvuru ve bitirme yok (arama/liste sayfaları sayılmaz) |
| Trendyol "−" butonunun ipucu "…satın alabilirsin" diye para butonu sanıldı | Buton adı ipucundan (title) alınmaz, yalnızca ikon butonlarda |
| Sepette "+" sonrası sayfa güncellenmeden okundu, model yeniden bastı (adet 3 olabilirdi) | Tıklamanın başlattığı istekler ve sayfa geçişi beklenir |
| Kullanıcının Chrome'unda arka plandaki sekmede ekran görüntüsü 30 sn bekliyordu | 5 sn sınır |
| `oku` ile taranan uzun doküman "%1 gördün" sayıldı, aynı not 3 kez alındı | `oku` sayfayı görülmüş sayar |
| "5 maddeyi birer cümleyle" istenmişken cevaba güçlü/zayıf yönler eklendi | Sonuç kullanıcının istediği biçime uyar |
| Çok adımlı görevde bir kısım yapılmadan bitirilebiliyordu | Bitirmeden önce görev maddelere ayrılıp kontrol edilir; eksik varsa devam |

**10 görev (kolaydan zora, farklı alanlar):** 1. tur 8 başarılı, 1 başarısız (sepet), 1 yapılamaz (Booking
Türkiye'deki otelleri Türkiye'den göstermiyor; Sonda bunu dürüstçe söyledi). 2. tur (düzeltmelerle, #110 Google
Oteller'e taşındı): 10/10. Hepsiburada 38→22 adım, Python dokümanı 10→6 adım.

**5 uzun, çok siteli görev (28 Eylül, `tests/sonuc_gorev_uzun_tur1.json`):** 3 tamamlandı, 2 yarıda kaldı.
Robot doğrulamasında betik artık "devam" diyor (Sonda siteyi atlamalı).

| # | Görev | Sonuç |
|---|---|---|
| 201 | Kulaklık: 4 mağaza + 2 inceleme + Trendyol favori | ✅ 5,4 dk, 32 adım. 4 mağazada satıcı/puan/fiyat/garanti/kargo, artı-eksi, gerekçeli öneri, favoriye eklendi. Bir robot doğrulamasında "devam" sonrası sürdürdü. Kusurlar: RTINGS okundu ama kaynak listesinde yok (artı-eksiler yalnız TechRadar'a [5] atfedildi); Teknosa'nın kendi fiyatı 30.699 TL (diğerlerinin ~2 katı) doğrulanmadı |
| 202 | Kapadokya gezisi + bütçe | ❌ 2,4 dk. Uçuş ve 2 otel doğru bulundu; GetYourGuide'daki tur kartı "Dün 24 kez rezervasyon yapıldı…" **para butonu sanılıp engellendi** (`koruma.py` `_PARA_BUTON`: `rezervasyon\w* (yap…)` "yapıldı"yı da yakalıyor; kutucuk açıkken bile geçmiyor). Balon ikinci site, hava durumu, bütçe eksik |
| 203 | Asgari ücret + TÜİK enflasyon | ✅ 2,4 dk, 23 adım, devir yok. ÇSGB + AA + TRT; net artış %27,01 ve reel kayıp %3,42 doğru hesaplandı; TÜİK Ağustos 2026 TÜFE %31,51 |
| 204 | Kariyer.net + Indeed Python ilanları | ❌ 1,1 dk. Kariyer.net "Basılı Tut" doğrulaması **tanınmadı** (`captcha` eylemi "bulunamadı"); model serbest metinle devretti, betik bunu robot doğrulaması saymayıp durdurdu. Indeed'e hiç geçilmedi |
| 205 | FastAPI / DRF / Litestar | ✅ 3,4 dk, 27 adım. 3 depo (yıldız, sürüm+tarih, issue), 3 doküman, pypistats, tablo, gerekçeli öneri |

**Düzeltmeler (28 Eylül):**
- [x] Para/son adım kuralları geçmiş zaman ve bilgi yazılarını yakalamıyor ("rezervasyon yapıldı", "satın aldı", "sipariş verildi", "satın alan"); emir kipi ("yapın", "verin") yine engelli (`koruma._BILGI_EKI`).
- [x] "Basılı tut" doğrulaması robot doğrulaması sayılıyor (kısa sayfa + doğrulama sözü şartıyla); kullanıcıya bırakılır, "devam"da site atlanır.
- [x] **Site hafızası** (`sonda/gorev/site_hafizasi.py`, `veri/site_hafizasi.json`): her görevden sonra her site için nerede ne yapıldığı (sayfalar, tıklamalar, engeller, robot doğrulamaları) kaydedilir; model site başına kısa dersler çıkarır. Model bir siteye girince ya da görevde site adı geçince bu hafızayı istemde görür. Not içerikleri ve şifreler yazılmaz.
- [ ] Okunan ama not alınmayan sayfa (RTINGS) kaynak listesine girsin ya da cevaptaki bilgi ona atfedilmesin.
- Yeniden çalıştırma (202, 204) Chrome "İzin ver" beklediği için yapılamadı; bırakıldı. Görev modunda site site hata kovalama burada durduruldu, sıradaki iş "dosyalar ve web" (tasarım: `docs/superpowers/specs/2026-09-28-belge-ekleme-design.md`).

**Açık konular:**
- Chrome her yeni bağlantıda (sunucu her başladığında) "İzin ver" istiyor; kimse basmazsa 90 sn sonra görev biter.
- Upwork'te "Submit proposal" kutucuk açıkken izinli; ama her teklif Connects harcar (parayla alınır). Para sayılsın mı?
- Google Haritalar'daki anlamsız "Daha fazla göster" butonları bitirmeyi bir kez geciktirebiliyor.

## 0. Gemini sağlayıcı (25 Eylül akşamı)

Sonda artık yerel modellerin yanında Gemini ile de çalışıyor (`gemini-saglayici` dalı). Ayarlar'dan anahtar eklenince
seçicide iki ucuz model çıkıyor: Gemini Flash-Lite (en ucuz) ve Gemini Flash. Pro, pahalı olduğu için listelenmiyor.

- Yerel sahte mağazadaki SSD görevi: Flash-Lite ile 11 sn, Flash ile 15 sn. Hızlı araştırma yaklaşık 20 sn sürüyor.
- Görevde verilen şifre hiçbir modele gitmiyor, model `{SIFRE_1}` görüyor.
- Gerçek API testleri: `.venv\Scripts\python -m pytest -m gemini`.

**Upwork karşılaştırması (gerçek hesap, Gemini Flash):** "Profilimi incele, neden iş alamadığımı analiz et, hiçbir
şeyi değiştirme" görevi **64 sn, 9 adımda** bitti. Yerel modelde aynı iş 22 dakika sürmüştü (~20 kat hızlı). Robot
doğrulaması 12 sn içinde geçildi, hiçbir şey değiştirilmedi. Cevap kanıtlı ve somut: kimlik doğrulanmamış, portfolyo
boş, İngilizce "Conversational", "Open for work" kapalı; öncelik sıralı öneriler ve örnek başlıklar verdi.
Zayıf yan: bazı genel Upwork bilgileri ("algoritma geri plana iter") profil kaynağına [1] atfedilmiş; bunlar
sayfada yazmıyor.

**Not:** İlk denemede deneme betiği devretmede görevi otomatik durdurduğu için captcha'da kaldı; ikinci denemede betik
bekledi ve doğrulama geçildi.

## 1. Bugün yapılanlar

**Test sonucu (50 soru):** 40 geçti, 9 elle kontrol edildi, 1 kaldı. Elle kontrolde 1 hata daha çıktı, yani toplam **2 gerçek hata**.

| Hata | Neden | Düzeltme |
|---|---|---|
| 23: "1 Ocak 2027'ye kaç gün kaldı?" (98 yerine 99 olmalıydı) | Tarih aracı yerine webdeki, başka bir günde hesaplanmış sayıyı aldı | Tarih/gün hesabı soruları artık web aramasına gitmiyor, tarih aracıyla hesaplanıyor (`agent.py`, ön karar promptu) |
| 32: "2026 Dünya Kupası'nı kim kazandı?" ("henüz oynanmadı" dedi) | Arama motorları geçici olarak boş döndü; model eski bilgisiyle cevap uydurdu | Boş arama yeniden deneniyor, haber araması boşsa normal aramaya geçiliyor (`webtools.py`). Yine boşsa model çağrılmıyor, dürüst bir "sonuç alamadım" mesajı gösteriliyor (`agent.py`) |

Ek düzeltmeler:
- Kaynak yokken modelin uydurduğu `[1]` atıfları arayüzde gösterilmiyor (`static/index.html`).
- Tarih testlerinin beklenen cevapları artık test günü hesaplanıyor (`tests/sorular.py`).

**Doğrulama:** Etkilenen 13 test yeniden çalıştırıldı, hepsi doğru. Tarih soruları 25-112 sn yerine 5-25 sn sürüyor.

**Bekleyenler:**
- [ ] Değişiklikler henüz commit'lenmedi.
- [ ] Hafıza testleri (49-50) gerçek `veri/hafiza.json` dosyasını siliyor ve oraya test bilgisi ("Deniz, İzmir") yazıyor. Testin ayrı bir hafıza dosyası kullanması gerekiyor.
- [ ] Ollama güncellemesi yarım kaldı (kurulu sürüm 0.34.4 çalışıyor).

---

## 2. Sonda nasıl farklılaşır?

Perplexity veya ChatGPT'nin kopyası olmak yerine, Sonda'nın onlarda olmayan üç gücüne yaslanmak:

1. **Senin bilgisayarında çalışıyor:** dosyalarına gizlilik sorunu olmadan erişebilir.
2. **Zamanı bedava:** bulut şirketleri araştırmayı maliyet yüzünden 1-2 dakikayla sınırlar. Sonda saatlerce araştırabilir.
3. **Türkçe odaklı:** Türk ve yabancı kaynakları birlikte tarayabilir.

**Konum:** *"Senin için çalışan, yorulmayan, özel araştırmacı."* Hızlı sohbet aracı değil, iş teslim eden araştırmacı.

| # | Özellik | Kısaca |
|---|---|---|
| 1 | 🌙 Gece Araştırması | Akşam konuyu verirsin, sabah grafikli ve kaynaklı uzun bir rapor bulursun |
| 2 | 🗂️ Senin dosyaların ve web bir arada | **← SEÇİLDİ.** Ayrıntılar aşağıda |
| 3 | 🌍 İki bakış açısı | "Türk basını ne diyor, dünya basını ne diyor": ortak noktalar ve farklar |
| 4 | 🧠 Büyüyen bilgi arşivi | Her araştırma bağlantılı bir arşive kaydedilir; "geçen ay ne bulmuştuk, ne değişti?" |
| 5 | ✅ Kanıt Modu | Cevaptaki her cümle kaynaktaki birebir alıntıya bağlanır, çelişkiler gösterilir |
| 6 | 🎬 Canlı araştırma sahnesi | Arama sırasında siteler kart kart belirir, okuma ilerlemesi izlenir |
| 7 | 📊 Görsel cevaplar | Soruya göre otomatik grafik, karşılaştırma tablosu ya da zaman çizelgesi |
| 8 | 🔔 Konu takibi | Bir konuyu her gün arka planda yeniden araştırır, değişiklik olursa haber verir |

Önerilen sıra: **Dosyalar ve web (2)**, sonra **Kanıt Modu (5)**, sonra **Gece Araştırması (1)**.

---

## 3. Seçilen özellik: Senin dosyaların ve web bir arada

**Örnek:** *"Şu sözleşmemdeki kira artış maddesi yeni yasaya uygun mu?"* Sonda PDF'i okur, güncel yasayı webde bulur, ikisini karşılaştırır. Belge hiçbir sunucuya gitmez.

**Anlaşılan:**
- Kullanıcı kendi belgesini verir. Sonda belgeyi okur, ilgili güncel bilgiyi webde bulur ve karşılaştırır.
- *Varsayım (onay bekliyor):* Cevapta hangi bilginin belgeden, hangisinin webden geldiği açıkça ayrılır. Örneğin 📄 "Sözleşme, madde 4" ve 🌐 "resmigazete.gov.tr".

**Hazır olan altyapı:** PDF okuma (`pypdf`), metni parçalara bölme ve anlamsal arama (`bge-m3`, `webtools.py`). Web sayfaları için kullanılan parçalar belgeler için de kullanılabilir.

### Açık soru 1 (sıradaki karar): Belgeler Sonda'ya nasıl gelsin?

**Karar (28 Eylül):** A teslim edildi; B sonra.

- **A) Sohbete ekleme:** Dosyayı sürükle-bırak ya da ataç simgesiyle sohbete eklersin; dosya o sohbete ait olur. Basit ve tanıdık.
- **B) Belge kütüphanesi:** "Belgelerim" klasörünü bir kez gösterirsin; Sonda tüm dosyaları arka planda dizinler ve hangi sohbette olursan ol ilgili belgeyi kendisi bulur. Daha güçlü, daha büyük bir iş.
- **C) İkisi birden (önerilen):** Önce A teslim edilir, B arkasından eklenir.

### Sonra konuşulacak sorular
- Hangi dosya türleri? (PDF, Word, Excel, görsel/tarama → OCR?)
- Taranmış PDF'ler (metni olmayan, resim olan) desteklensin mi?
- Karşılaştırma cevabının biçimi: düz metin mi, "uygun / uygun değil / belirsiz" tablosu mu?
- Belgeler nerede saklansın, nasıl silinsin?

**Süreç:** Sorular netleşince kısa bir tasarım belgesi yazılacak ve onayından sonra kodlamaya geçilecek.

---

## 4. Ertelenen proje: UI tasarımında uzman kodlama ajanı

İndirilebilir bir masaüstü uygulaması. Uzun (gerekirse 10 saat) otonom döngüyle etkileyici web siteleri yazar.

- **Karar verildi:** Model olarak **Gemini API ve yerel Ollama birlikte**, çıktı olarak **Next.js** (App Router ve Tailwind).
- **Açık soru:** Otonomi düzeyi. Seçenekler: tamamen otonom, tasarım yönü onaylandıktan sonra otonom (önerilen), ya da her adımda etkileşimli.
