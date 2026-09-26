"""Gerçek web görevleri: elle değerlendirilir. Birbirine benzemeyen 10 tür: fiyat karşılaştırma, harita,
form, sepete ekleme (devretme), derin araştırma, haber, tarif, resmî kurum, İngilizce doküman, İngilizce site."""
GOREVLER = [
    {"id": 2, "gorev": "Hepsiburada ve Trendyol'da 'Samsung 990 EVO Plus 1TB' fiyatlarını karşılaştır.", "beklenen": "iki site, iki fiyat, tablo"},
    {"id": 6, "gorev": "Google Maps'te Alsancak'taki en yüksek puanlı 3 kahveciyi bul.", "beklenen": "3 isim ve puan"},
    {"id": 8, "gorev": "https://httpbin.org/forms/post formunu doldur: müşteri adı Semih, boyut orta, sos peynir. Gönderme.", "beklenen": "doldurulmuş, gönderilmemiş, devredilmiş"},
    {"id": 10, "gorev": "Amazon.com.tr'de Kindle Paperwhite'ı sepete ekle ve satın alma adımına kadar ilerle.", "beklenen": "sepete eklendi, ödeme devredildi"},
    {"id": 12, "gorev": "Yerel yapay zekâ modelleri için 2026'da önerilen en iyi 24 GB VRAM ekran kartlarını araştır, en az 3 kaynaktan karşılaştır.", "beklenen": "derin görev, 3+ site, İngilizce kaynaklar, tablo"},
    {"id": 13, "gorev": "Bugün Türkiye gündeminde öne çıkan 3 haberi iki farklı haber sitesinden bul ve kısaca özetle.", "beklenen": "haber, 2 site, 3 başlık"},
    {"id": 14, "gorev": "Nefis Yemek Tarifleri'nde karnıyarık tarifini bul; malzemeleri ve pişirme süresini listele.", "beklenen": "tarif, malzeme listesi"},
    {"id": 16, "gorev": "Merkez Bankası'nın sitesinden bugünkü USD/TRY ve EUR/TRY döviz alış kurlarını bul.", "beklenen": "resmî site, iki kur"},
    {"id": 18, "gorev": "Python requests kütüphanesinin resmi dokümantasyonunda zaman aşımı (timeout) nasıl ayarlanır, örnekle açıkla.", "beklenen": "İngilizce doküman, kod örneği"},
    {"id": 20, "gorev": "IMDb'de Christopher Nolan'ın en yüksek puanlı 3 filmini puanlarıyla bul.", "beklenen": "İngilizce site, 3 film, puan"},
]

# 26 Eylül: "ne iş verirsem vereyim dediğimi yapmalı" — 10 farklı alan, kolaydan zora. Gemini + "Butonlara kendisi
# bassın" açık çalıştırılır (tests/gorev_toplu.py). beklenen: görevin tam yapıldığını gösteren ölçütler.
GOREVLER_ZOR = [
    {"id": 101, "zorluk": "kolay", "alan": "resmî kurum / finans",
     "gorev": "Merkez Bankası'nın sitesinden (tcmb.gov.tr) bugünkü gösterge niteliğindeki ABD doları ve euro kurlarını bul; "
              "döviz alış ve döviz satış değerlerini yaz.",
     "beklenen": "tcmb.gov.tr açıldı; USD ve EUR için alış ve satış; kurun tarihi belirtildi"},
    {"id": 102, "zorluk": "kolay", "alan": "şifreyle giriş",
     "gorev": "https://the-internet.herokuapp.com/login sayfasında kullanıcı adı tomsmith, şifre SuperSecretPassword! ile "
              "giriş yap. Giriş sonrası sayfada çıkan mesajı yaz, sonra çıkış yap (Logout) ve çıkış mesajını da yaz.",
     "beklenen": "giriş yapıldı ve 'You logged into a secure area!' yazıldı; Logout'a basıldı ve çıkış mesajı yazıldı; "
                 "şifre hiçbir çıktıda görünmedi"},
    {"id": 103, "zorluk": "orta", "alan": "İngilizce doküman",
     "gorev": "Python'un resmi dokümantasyonundaki 'What's New In Python 3.13' sayfasını incele. En önemli 5 yeniliği "
              "birer cümleyle Türkçe özetle ve her birinin PEP numarasını yaz.",
     "beklenen": "docs.python.org 3.13 sayfası; 5 yenilik; PEP numaraları doğru (ör. 703 free-threading, 744 JIT, "
                 "667, 594, 702, 696); PEP'i olmayan için uydurma numara yok"},
    {"id": 104, "zorluk": "orta", "alan": "e-ticaret, çok kısıt",
     "gorev": "Hepsiburada'da 'kablosuz mouse' ara. Fiyatı 300-600 TL arasında, puanı en az 4 ve en az 100 "
              "değerlendirmesi olan ürünlerden en çok değerlendirilen 3 tanesini bul; ürün adı, fiyat, puan, "
              "değerlendirme sayısı ve satıcıyı tablo yap.",
     "beklenen": "3 ürünün hepsi fiyat/puan/değerlendirme kısıtına uyuyor; değerlendirme sayısına göre en çok olanlar; "
                 "satıcı adları; tablo"},
    {"id": 105, "zorluk": "orta", "alan": "karmaşık form",
     "gorev": "https://demoqa.com/automation-practice-form adresindeki öğrenci kayıt formunu doldur ve gönder: ad Semih, "
              "soyad Tekay, e-posta semih@ornek.com, cinsiyet Male, cep telefonu 5550000000, doğum tarihi 15 Mart 1995, "
              "dersler Maths ve Computer Science, hobiler Reading ve Music, adres 'Alsancak, İzmir', eyalet NCR, "
              "şehir Delhi. Gönderdikten sonra açılan onay penceresindeki değerlerin doğru olduğunu kontrol et ve "
              "yanlış olan varsa söyle.",
     "beklenen": "form gönderildi; onay penceresindeki tüm değerler istenenle aynı (tarih 15 March,1995, iki ders, "
                 "iki hobi, NCR Delhi)"},
    {"id": 106, "zorluk": "orta-zor", "alan": "harita",
     "gorev": "Google Haritalar'da Kadıköy İskelesi'nden Beşiktaş İskelesi'ne toplu taşımayla gitmenin en hızlı yolunu "
              "bul; toplam süreyi, kullanılacak araçları (vapur, metro, otobüs...) ve aktarma sayısını yaz.",
     "beklenen": "Haritalar'da toplu taşıma yol tarifi açıldı; en hızlı seçenek, süre, araçlar ve aktarma sayısı"},
    {"id": 107, "zorluk": "zor", "alan": "hesap içinde çok adımlı iş",
     "gorev": "Trendyol sepetimdeki Xiaomi powerbank'in adedini 2 yap ve sepet toplamının kaç TL olduğunu not et; sonra "
              "adedi yeniden 1'e düşür. Ardından bu ürünün sayfasındaki olumsuz (1-2 yıldızlı) yorumları okuyup en sık "
              "görülen şikâyetleri özetle.",
     "beklenen": "adet 2 yapıldı ve toplam not edildi; adet yeniden 1 (ürün silinmedi); olumsuz yorumlardan "
                 "şikâyet özeti, yorumlardan kanıtla"},
    {"id": 108, "zorluk": "zor", "alan": "uçuş arama",
     "gorev": "Google Flights'ta 15 Kasım 2026 için İstanbul'dan Berlin'e tek yön, aktarmasız en ucuz uçuşu bul; "
              "havayolu, kalkış ve varış saatleri, havalimanları ve fiyatı yaz. Satın alma adımına geçme.",
     "beklenen": "tek yön, 15 Kasım 2026, aktarmasız; en ucuz uçuş; havayolu/saat/havalimanı/fiyat; satın almaya geçilmedi"},
    {"id": 109, "zorluk": "zor", "alan": "çok siteli fiyat karşılaştırma",
     "gorev": "Samsung Galaxy S25 FE 256 GB'ın fiyatını Trendyol, Hepsiburada ve Amazon.com.tr'de karşılaştır. Her "
              "sitede güvenilir satıcıdaki (resmi mağaza ya da satıcı puanı 9 ve üzeri) en ucuz teklifi bul; satıcı adı, "
              "satıcı puanı, fiyat ve kargo ücretini tabloya koy ve en uygun seçeneği söyle.",
     "beklenen": "üç site; doğru model ve 256 GB; her sitede satıcı puanı kontrol edildi; tablo ve öneri"},
    # İlk sürüm Booking.com'du: Booking Türkiye'den bağlanana Türkiye'deki otelleri göstermiyor (Sonda bunu doğru raporladı)
    {"id": 110, "zorluk": "en zor", "alan": "otel, çok kısıt",
     "gorev": "Ankara'da 20-22 Kasım 2026 (2 gece) için 2 yetişkinlik oda arıyorum. Google'ın otel aramasında "
              "(google.com/travel/hotels) Kızılay'a en fazla 1 km uzaklıkta, puanı 5 üzerinden en az 4 olan ve 2 gecelik "
              "toplam fiyatı 6.000 TL'yi geçmeyen 3 otel bul; her biri için toplam fiyat, puan, Kızılay'a uzaklık ve "
              "ücretsiz iptal olup olmadığını tabloya koy. Rezervasyon yapma.",
     "beklenen": "tarih ve kişi doğru; 3 otelin hepsi mesafe/puan/fiyat kısıtına uyuyor; ücretsiz iptal bilgisi; "
                 "rezervasyon yapılmadı"},
]
