# Sonda Agent

**Gemini ürünü tanımlar ve teslimi onaylar; Claude Code / Codex planlar, kodlar ve inceler; Sonda test eder.**
macOS ve Windows'ta çalışan masaüstü uygulaması. İsteğini yaz ("Next.js ile e-ticaret sitesi yap") ya da teknik dokümanını bırak; gerisini senin yerine yaptırır.

```
 İstek + dokümanlar (PDF, Word, Markdown) + tasarım dosyaları (HTML/CSS, klasör, görsel)
        │
        ▼
 GEMİNİ — YÖNETİCİ (ürün ve "bitti"nin tanımı)
   keşif: isteği tam ürün tanımına genişletir, sadece senin verebileceğin kararları sorar
   gereksinimler (R1…Rn, [SEC] güvenlik, [ROB] sağlamlık) + tasarım yönü
        │
        ▼
 CLAUDE — MÜHENDİS (salt-okunur, araçlarla)
   klasörü inceler, npm'den güncel sürümleri ve komut bayraklarını doğrular,
   teknik şartnameyi ve görev planını yazar (Given/When/Then + testler)
        │
        ▼
 GEMİNİ — plan kabulü: isteğe sadakat, kapsam, eksik/fazla, hata yolları
   beğenmezse "şunları değiştir" → Claude aynı oturumda revize eder (en fazla 2 tur)
        │
        ▼  (sen onaylarsın)
 ┌──────────────── her görev (Gemini'siz: ajanlar yürütür) ───────────────┐
 │ Claude Fable 5.1 kodu gezip teknik brifi yazar → ajan (Claude / Codex) │
 │ kodlar → lint · tip · test · build → bağımsız ajan incelemesi (kodu    │
 │ gezer, testleri çalıştırır, kırmayı dener) + uzman paneli → her bulgu  │
 │ kodda doğrulanır → düzeltme → yeniden doğrulama → hafıza → commit      │
 └────────────────────────────────────────────────────────────────────────┘
        ▼  (her 3 görevde bir)
 Bağımsız denetim: Claude Fable 5.1 bitmiş kodun tamamını kalan görevlerle
 birlikte okur → öneriler doğrulanır → doğrulananlar sonraki görevden önce
 uygulanır (bir kontrol bozulursa geri alınır) → yeniden doğrulama
        ▼
 Faz kapısı (ajanlar): tüm kontroller + temiz kurulum + tarayıcı testi +
 derin inceleme + üç uzman → bulgu defterinde açık kayıt kalmayana kadar
        ▼
 GEMİNİ — son kabul: kullanıcı yolculukları, ekran görüntüleri, gereksinimler;
 Claude derin inceleme + uzman paneli; en fazla 3 düzeltme turu → teslim raporu
        ▼
 "Teslime hazır" yalnızca hepsi geçerse. Geçmezse "Teslime hazır değil":
 açık sorunlar listelenir, "Düzeltmeye devam et" ile yeni turlar başlatılır.
```

**Roller** (Ayarlar → Süreç):
- **Gemini'nin rolü** — *Yönetici* (varsayılan): yalnızca işin başında (ürün tanımı, gereksinimler, plan onayı) ve sonunda (son kabul, teslim raporu) çalışır; küçük bir işte toplam 5 çağrı. Yapım döngüsünü — teknik brif, görev incelemesi, proje hafızası, faz kapısı, TDD modunda test incelemesi — ajanlar yürütür. *Her adımda*: Gemini her görevi ve fazı da inceler, hafızayı yazar.
- **Teknik brif** — varsayılan **Claude Fable 5.1**: her görevden önce salt okunur bir oturumda kodu gezer (şartname, hafıza, görevin dokunacağı dosyalar ve dayandıkları) ve gerçek yollar, imzalar ve hata modlarıyla brifi yazar. Seçenekler: kodlama modeli ya da Gemini. Claude kurulu değilse brifi Gemini yazar.
- **Plan** — *Claude yazar, Gemini onaylar* (önerilen) ya da *Gemini yazar, Claude eleştirir* (daha hızlı). Claude plan oturumu kullanılabilir bir plan vermezse Sonda Gemini planlayıcıya geçer.
- **İnceleme gücü** — *Standart*: her görev bir kez incelenir; *Derin* (önerilen): + uzman paneli, bulgu doğrulama, faz kapısında ve teslimde derin inceleme; *Maksimum*: her görevde mimari/test uzmanı da. **TDD modu** isteğe bağlıdır.

Kodu yazan ajan Claude ya da Codex olabilir; inceleyici, Claude kuruluysa her zaman Claude'dur (Codex ile kodlanan işte çapraz model incelemesi). Bir ajan incelemesi sonuç vermezse Sonda Gemini'ye, o da yoksa doğrulama komutlarına düşer; iş kilitlenmez.

İnceleyici Claude **salt okunurdur**: dosya yazamaz, yalnızca okuma/arama ve test/lint/tip/build komutlarını çalıştırabilir. Ajanlar bilgisayarındaki kişisel MCP bağlantılarını (deploy, tasarım araçları…) varsayılan olarak göremez. Ayarlar'da açılsa bile bu bağlantılar yalnızca kodlayan ajana yüklenir; brif, inceleme, uzman, doğrulama ve hafıza oturumları onları hiç yüklemez. Bağlayıcıların araç tanımları her oturuma yüz binlerce token ekler: bu ayar kapalıyken kullanım limitlerin birkaç kat daha uzun dayanır.

## Kurulum

Gerekenler:

| Araç | Neden | Kurulum |
|---|---|---|
| Node.js 20+ | uygulama ve projeler | https://nodejs.org |
| Git | commit, kod farkı incelemesi | macOS: `xcode-select --install` · Windows: https://git-scm.com |
| Claude Code | kodlama ajanı | Sonda kurar ve bağlar (aşağıya bak). Elle: `curl -fsSL https://claude.ai/install.sh \| bash` |
| Codex (isteğe bağlı) | alternatif ajan | `npm install -g @openai/codex` ardından `codex login` |
| Gemini API anahtarı | planlama ve inceleme | https://aistudio.google.com/apikey |

> Windows'ta Claude Code, Git for Windows'un (Git Bash) kurulu olmasını ister.

Çalıştırma:

```bash
npm install
npm start
```

İlk açılışta Ayarlar penceresi açılır. Gemini anahtarını gir, **Modelleri getir** ile modeli seç (önerilen: `gemini-pro-latest`) ve **Test et**'e bas.

### Claude bağlantısı (tek düğme)

Claude, kendi **Claude (Pro / Max) aboneliğinle** çalışır; API anahtarı gerekmez ve kullanılmaz (ortamda `ANTHROPIC_API_KEY` olsa bile ajanlara aktarılmaz, böylece iş API faturasına düşmez).

Claude bağlı değilse yeni iş ekranında ve Ayarlar → Ajanlar'da bir bağlantı kartı görünür. **Claude'u bağla** düğmesi sırayla şunları yapar:

1. **Kurulum** — Claude Code kurulu değilse resmi yükleyiciyle kurar (Node.js gerekmez).
2. **Hesap girişi** — tarayıcıda giriş sayfasını açar; hesabınla giriş yapıp izin verirsin. Sonda girişi kendiliğinden algılar (bir şey yapıştırman ya da "tekrar kontrol et"e basman gerekmez).
3. **Model testi** — seçili modelle (varsayılan Opus 5.5) küçük bir istek gönderir ve yanıtı doğrular.

Kart her adımın durumunu, abonelik planını (Pro / Max) ve hesabı gösterir. **Hesap değiştir** çıkış yapıp yeniden giriş ekranını açar. Bir iş oturum sorunu yüzünden durursa hata kutusunda **Giriş yap** düğmesi çıkar; girişten sonra **Sürdür** ile kaldığı yerden devam eder.

## Kullanım

1. **Klasör seç**: boş bir klasör yeni proje demektir. Dolu bir klasör seçersen Sonda mevcut projenin üzerine çalışır.
2. İsteğini yaz ve/veya **Doküman** ile teknik şartname, PRD, API dokümanı ekle (sürükle-bırak da olur). PDF ve görselleri Gemini doğrudan okur; Word (.docx) metne çevrilir.
   **Tasarım** düğmesiyle arayüzün görünümünü belirleyen dosyaları ayrıca ekle: HTML/CSS sayfalar, bir tasarım klasörü (bağlı stiller, görseller, fontlarıyla), ekran görseli ya da PDF çizim. Doküman "ne yapılacağını", tasarım "nasıl görüneceğini" söyler; ikisini birlikte verebilirsin ("landing page bu tasarımda olsun, arka uç şu PDF'teki gibi"). Çipteki rozete tıklayarak bir dosyanın rolünü (doküman ↔ tasarım) değiştirebilirsin; klasörler her zaman tasarımdır.
3. **Planla** (⌘↵ / Ctrl+↵). Gemini ürünü tanımlar ve gereksinim listesini çıkarır; teknik şartnameyi ve görev planını Claude yazar, Gemini onaylar. Soruları varsa cevaplayıp **Planı güncelle** diyebilirsin. İstemediğin görevin işaretini kaldır.
4. **Onayla ve başlat**. Plan ayrıntılarındaki **Sonda'nın çalıştıracağı komutlar** bölümü, faz kapılarında ve son kabulde Sonda'nın proje klasöründe kendisinin çalıştıracağı ek komutları (servis kurulumu, migration, ek kontroller) gösterir; onaylamadan önce göz at. Canlı akışta ajanın ne yaptığını, testleri ve incelemeleri izle. Çalışırken **Ajana talimat ver** kutusundan ek istek gönderebilirsin; bir sonraki adımda uygulanır.
5. Bittiğinde **Rapor**, **Ekran görüntüleri**, **Şartname** ve **Hafıza** sekmelerine bak. **▶ Uygulamayı çalıştır** projeyi başlatıp tarayıcıda açar. **Bu projede devam et** ile yeni özellik iste.

Durdurulan ya da uygulama kapanırken yarım kalan iş, geçmişten açılıp **↻ Sürdür** ile kaldığı görevden devam eder. Sürdür yalnızca onaylanmış bir planı yürütür: plan onay beklerken yeniden planlama yarıda kaldıysa iş onaya döner. Kodlanıp incelenmiş ama hafıza / commit adımında kesilmiş görev yeniden yazılmaz, yalnızca o adım tamamlanır; sorunlu kalmış görevler yeniden denenir. Faz kapısı yalnızca hiç bitmediyse, katı kapı işi durdurduysa ya da fazında bir görev yeniden çalıştıysa tekrarlanır. Uygulama sırasında kesilen bağımsız denetim baştan yapılmaz: doğrulanmış öneriler uygulanır.
Onay ya da cevap beklerken **İptal** edilen iş kaybolmaz: iş ekranındaki **Planı geri getir** aynı planı yeniden onayına getirir (ürün tanımı, şartname ve görevler durur; yeniden planlama yapılmaz).

## Anahtarlar (.env)

Stripe, Twilio, veritabanı gibi servislerin anahtarlarını **🔑 Anahtarlar** penceresinden gir (yeni proje ekranında ya da iş başlığında).

**Kapıda `.env` otomatik tamamlanır:** Faz kapısı ve teslim kontrolleri servisleri (docker compose, veritabanı) kurar ve bunlar `.env` ister. `.env` yoksa Sonda `.env.example`'dan oluşturur (varsayılanlar ve yorumlar korunur, girdiğin anahtarlar eklenir; yönetici parolası, oturum sırrı gibi **uygulamanın kendi sırları rastgele üretilir**; `OPENAI_API_KEY` gibi üçüncü taraf anahtarlarına dokunulmaz, boş kalır). `.env` varsa yalnızca eksik satırlar eklenir; var olan satırlar değişmez. Üretilen değerler günlüğe yazılmaz. Compose'un "eksik değişken" hatası kod hatası sayılmaz, ortam sorunu olarak raporlanır.

- Proje `.env.example` dosyası yazınca Sonda onu okur ve bölümlere ayrılmış bir form gösterir: **gerekli** (yer tutucu ya da gizli bilgi), **varsayılan** (projenin kendi varsayılanı var) ve **isteğe bağlı** alanlar.
- Değerler bilgisayarda şifreli saklanır (macOS Keychain / Windows DPAPI) ve projenin `.env` dosyasına **Sonda tarafından** yazılır. Varsa `.env.local` da güncellenir, böylece eski bir yer tutucu gerçek değeri gölgelemez. Dosya izinleri yalnızca sahibine açıktır; `.gitignore` her ikisini de kapsar.
- İstemlere **yalnızca adlar** girer. Claude oturumları `.env` dosyasını okuyamaz (inceleyiciler hiçbir zaman; kodlayan ajan da sen anahtar girdiysen): `Read` aracı ve dosyayı doğrudan okuyan kabuk komutları (`cat .env`, `head .env`…) reddedilir; inceleyicilerde `cat` / `grep` gibi komutlar hiç yoktur (okuma ve arama Read / Grep araçlarıyla). `.env.example` okunabilir. Gemini'ye giden her metinde ve loglarda değerler `‹gizli:AD›` olarak maskelenir: ham hali, çok satırlı değerlerin satırları, `.env` / JSON kaçışlı, URL kodlu ve `$` kaçışlı (`\$`, `$$`) biçimleri. Commit ve zip taraması aynı biçimleri arar. Sonda'nın kendi ürettiği sırlar (yönetici parolası, oturum sırrı) da aynı korumadan geçer. Uygulama değerleri çalışırken ortamdan okur.
- Bilgisayarındaki gizli ortam değişkenleri (`GEMINI_API_KEY`, `OPENAI_API_KEY`, `GITHUB_TOKEN`, `AWS_SECRET_ACCESS_KEY`… — adında KEY / TOKEN / SECRET / PASSWORD geçenler) ajanlara ve projenin komutlarına (kurulum, test, build, dev sunucusu) aktarılmaz. İstisnalar: özel npm kayıtları için `NPM_TOKEN` / `NODE_AUTH_TOKEN`; Codex oturumuna `OPENAI_API_KEY` / `CODEX_API_KEY`; Claude Bedrock / Vertex üzerinden çalışıyorsa o sağlayıcının kimliği (yalnızca ajana).
- Değerler `.env` dosyasına **dotenv'in okuduğu biçimde** yazılır: tırnak, ters bölü, `$`, `#`, çok satırlı anahtar (PEM) ve JSON kimlik bilgileri okunduğunda birebir geri gelir (testler gerçek `dotenv` ile doğrular). Sonda'dan sildiğin anahtar `.env` dosyasından da kalkar.
- Neyin gizli sayılacağına ad parçalarına ve değerin biçimine bakılarak karar verilir: `NEXTAUTH_SECRET`, `STRIPE_API_KEY`, parolalı veritabanı adresi gizlidir; `NEXTAUTH_URL=http://localhost:3000`, `DATABASE_URL=file:./dev.db`, `PORT` değildir. `.env.example`'daki örnek değerle aynı olan değer de gizli sayılmaz.
- `.env`, `.env.local` ve `.env.*.local` **hiçbir zaman commit'e girmez** (depoda zaten izleniyor olsalar bile); `.gitignore` eksikse tamamlanır. Bir ajan anahtarı koda yazarsa o dosya commit dışında bırakılır ve ajandan anahtarı ortam değişkenine taşıması istenir.
- Tarayıcı testi Basic Auth korumalı sayfaları `.env`'deki kullanıcı adı ve parolayla açar.

## Görünüm ve CLI güncellemesi

- **Açık / koyu tema:** Kenar çubuğundaki ☀︎/☾ düğmesi ya da Ayarlar → Genel → Görünüm (Sistem / Açık / Koyu).
- **Claude CLI:** Bilgisayarda birden fazla kurulum varsa (Homebrew, resmi yükleyici, npm) Sonda en yeni sürümü kullanır. Yeni sürüm çıkınca Ayarlar → Ajanlar'da **Güncelle** düğmesi görünür ve kurulum yöntemine uygun komutu çalıştırır. Homebrew kurulumları çoğu zaman birkaç sürüm geriden gelir.

## Büyük projeler

100 maddelik bir platform şartnamesi gibi büyük istekler için:

- **Fazlar**: istekte PHASE 1…N varsa birebir korunur, her faz birden çok göreve bölünür (büyük platformlarda 25-45 görev).
- **Faz kalite kapısı**: her fazın sonunda Sonda `lint`, `typecheck`, `test`, `build` yanında `docker compose` ile servisleri kaldırıp `test:integration` ve `test:e2e` çalıştırır, uygulamayı tarayıcıda gezer. Gemini fazı bütün olarak ve regresyon açısından inceler. Kapı geçilmezse (Ayarlar'da **katı faz kapısı** açıksa) iş durur ve seni bekler. Talimat ekleyip **Sürdür** diyebilirsin.
- **Orijinal istek korunur**: yazdığın metin `docs/sonda/REQUEST.md` olarak birebir saklanır ve "nihai doğruluk kaynağı" sayılır. Gemini'nin özeti hiçbir kuralı yutamaz.
- **Kullanım limiti**: Claude/Codex limiti dolarsa Sonda sıfırlanma saatine kadar bekler ve aynı oturumdan kendiliğinden devam eder. Bilgisayar uykuya geçmez, uygulamayı açık bırakman yeterli.
- **İnternet kesintisi**: bağlantı koparsa adım başarısız sayılmaz. Sonda bağlantıyı bekler (en fazla 6 saat) ve aynı oturumdan kendiliğinden devam eder — plan yazımı Gemini'ye düşmez, kesinti yüzünden başarısız olan `npm install` kod hatası sayılıp ajana "düzelttirilmez". Bağlantı gelmezse iş açık bir mesajla durur; **Sürdür** ile kaldığı yerden devam edilir.
- **Docker kapalıysa** bu bir kod hatası sayılmaz: entegrasyon testleri atlanır ve "Docker Desktop'ı açın" uyarısı gösterilir.

## Asla unutmaz: proje hafızası

Her ajan oturumu temiz bir bağlamla başlar. Önceki işleri şu dosyalar sayesinde bilir; hepsi projenin içinde durur:

| Dosya | İçerik | Kim yazar |
|---|---|---|
| `docs/sonda/REQUEST.md` | yazdığın istek, birebir (sonraki istekler sona eklenir) | Sonda |
| `docs/sonda/SPEC.md` | teknik şartname + gereksinimler | Gemini (plan) |
| `docs/sonda/MEMORY.md` | modüller, veri modeli, rotalar, ortak bileşenler, konvansiyonlar, kararlar, bilinen sorunlar | Gemini, **her görevden sonra gerçek kod farkına bakarak** |
| `docs/sonda/PROGRESS.md` | her görevin kaydı: ne yapıldı, değişen dosyalar, inceleme sonucu (sadece eklenir) | Sonda |
| `docs/sonda/references/` | eklediğin orijinal dokümanlar | Sonda |
| `docs/sonda/design/` | eklediğin tasarım dosyaları (olduğu gibi); `_onizleme/` altında sayfaların masaüstü + mobil görüntüleri | Sonda |
| `CLAUDE.md`, `AGENTS.md` | ajanların her oturumda otomatik okuduğu, yukarıdakilere yönlendiren blok | Sonda |

Hafıza ve Gemini'nin "sonraki görevlere devreden notları" her ajan istemine olduğu gibi eklenir; güncel dosya ağacı da verilir. Aynı klasörde yeni bir iş başlattığında Gemini önceki şartnameyi, hafızayı ve günlüğü okuyarak planlar.

## Kalite

- **Mühendislik standartları** (Ayarlar'dan düzenlenebilir): strict TypeScript, girdi doğrulama (zod), katmanlı mimari, erişilebilirlik, güvenlik, test, placeholder yasağı… Her ajan istemine eklenir ve incelemede ölçüt olarak kullanılır.
- **İlk inceleme kırmayı dener:** Her görevin ilk incelemesi "onay"ı varsayılan saymaz. Varsayılan rolde bunu bağımsız bir ajan oturumu yapar: değişen dosyaları ve çağırdıklarını okur, ilgili testleri ve tip kontrolünü kendisi çalıştırır; önce değişikliği kırmaya çalışır — doğruluk, hata yolları, eşzamanlılık, veri bütünlüğü, güvenlik, entegrasyon, testler ve arayüz için en az 8 somut senaryoyu kodda izleyip "ele alınmış / kırık / testsiz" diye kanıtıyla işaretler — sonra kabul kriterlerini ve gereksinimleri kanıtla denetler, kusurları dosya/satır/senaryo/çözümle **bulgu** olarak yazar; puanı ve kararı en son verir. Puan beş boyutta (doğruluk, sağlamlık, test, bakım, arayüz) verilir; genel puan doğruluk ve sağlamlığın en düşüğünü aşamaz. İlk incelemenin her bulgusu uzman bulguları gibi ayrı bir Claude tarafından **kodda doğrulanır**: doğrulanan düzeltmeye gider, çürütülen iddia ajana "bunu uygulama" diye bildirilir. Gemini "her adımda" rolündeyse aynı yöntemi fark, değişen dosyalar ve içe aktardıkları üzerinden o uygular (yanıt şemasında karar alanı en sonda).
- **Bulgu defteri — doğrulanmış kusur kapanmadan teslim yok:** Uzmanların ve Gemini'nin doğrulanmış her orta ve üstü bulgusu işin bulgu defterine girer. Bulgu, yazıldığı görevde hemen düzeltilir (sonraki görevlere devredilmez); düzeltmeden sonra doğrulayıcı güncel kodu yeniden okur ve "düzeldi / hâlâ duruyor" der — kısmi düzeltme kabul edilmez, kalan kısım notuyla birlikte yeniden düzeltmeye gider. Düzeltme turları bittiğinde kapanmayan orta bulgu defterde açık kalır; faz kapısı ve son kabul açık bulguyla geçilemez. "Belirsiz" kalan bulgular son kabulde karara bağlanır. Defter iş ekranında ("Bulgu defteri") ve teslim raporunda görünür; açık kalan kusur raporda gizlenmez.
- **Projenin dersleri:** Doğrulanmış kusurlardan projeye özgü kurallar damıtılır ("her durum geçişi şu modülden yapılır; terminal durum ezilmez" gibi) ve sonraki her brife, göreve ve incelemeye girer; aynı sınıf hata ikinci kez yazılmaz.
- **Sağlamlık plana baştan girer:** Planlayıcı güvenlikte olduğu gibi bir sağlamlık temeli uygular ve bunu `[ROB]` etiketli gereksinimlere çevirir: her işlemin yükleniyor/boş/hata/başarı durumu, her dış çağrıda zaman aşımı ve ele alınmış hata, çok adımlı işlerde açık durum makinesi (her hata yolu görünür bir terminal duruma varır; hiçbir kayıt "sürüyor"da takılmaz, terminal durum ezilmez), ya hep ya hiç yazmalarda transaction, yinelenen olaylarda idempotency, yeniden başlatmada toparlanma. Şartnamenin akış bölümü her akış için hata-modu tablosu içerir; mantık, G/Ç ya da durum içeren her görevin en az iki hata yolu kabul kriteri ve bunu sınayan testi vardır; iş mantığı olan projelerde test betiği kapsam eşiğini (≥ %80) zorlar. Gemini'nin yönetici incelemesi yalnızca mutlu yolu anlatan ya da hata yönetimini "sertleştirme" görevine erteleyen planı geri çevirir.
- **Kesintiden sonra kaldığı yerden:** Uygulama kapanır, bilgisayar yeniden başlar ya da kullanım limiti dolarsa yarım kalan görev baştan yazılmaz: ajan, o görevde o ana kadar değişen dosyaların listesiyle "bu işi tamamla" talimatını alır; inceleme de görevin başından beri değişen her şeye bakar (yarım iş incelenmeden geçemez).
- **Temiz kurulum denetimi:** Faz kapılarında ve teslimde proje geçici bir klasöre klonlanır, `.env.example` `.env` yapılır, bağımlılıklar kilit dosyasından kurulur, tip kontrolü ve birim testleri çalıştırılır. "Yalnızca geliştirildiği klasörde çalışan" proje (commit'lenmemiş dosya, eksik üretim adımı, bozuk postinstall, eşitlenmemiş kilit dosyası) teslim edilemez.
- **Görsel test ve sayfa denetimleri**: faz kapılarında ve son aşamada uygulama yalıtılmış bir tarayıcıda açılır; HTTP durumları, konsol/hidrasyon hataları ve ekran görüntüleri (masaüstü + mobil) Gemini'ye gösterilir. Sayfalar ayrıca nesnel olarak denetlenir: mobilde yatay taşma, kırık görsel, başarısız istek, kırık iç bağlantı ve bilinmeyen adreste çökme **kusurdur** ve düzeltme turu açar; temel erişilebilirlik eksikleri (etiketsiz alan, alt metni olmayan görsel, adsız düğme, `lang`/başlık/`main`/`h1`) inceleyicilere uyarı olarak verilir.
- **Güvenlik plandan başlar:** Planlayıcı her ürün için bir tehdit modeli çıkarır (saldırı yüzeyi, korunacak veriler, olası saldırılar) ve savunmaları `[SEC]` etiketli, test edilebilir gereksinimlere çevirir. Her `[SEC]` gereksinimi, koruduğu yüzeyi kuran göreve gider; kabul kriterinde reddedilmesi gereken durum da yazılıdır ("giriş yapmamış istek 401 alır"). Şartnamenin güvenlik bölümü bu modele göre yazılır.
- **Görev sonu uzman incelemesi:** Her görevin sonunda Claude güvenlik uzmanı ve iş kuralları uzmanı değişen kodu ve dokunduğu yüzeyleri inceler (iskelet görevinde, riskli görevlerde ve azami inceleme seviyesinde mimari/test uzmanı da). İş kuralları uzmanı hata yollarını da yürür: dış çağrı başarısız olursa, iki yazma arasında süreç durursa, aynı olay iki kez gelirse geride ne kalıyor? Bulgular ayrı bir Claude doğrulayıcıdan geçer; doğrulanan orta ve üstü bulgular aynı görevde düzeltilir, düzeltme yeniden doğrulanır ve Gemini'nin kalite puanını kanıtla sınırlar.
- **Görev süre bütçesi:** Her görevin büyüklüğüne göre 20–45 dakikalık bir hedef ajana bildirilir; kabul kriterleri ve kontroller geçince ajan durur, gereksiz araştırma ve yardımcı harness kurmaz. Hedefi %50 aşan görevler loga düşer ve sonraki göreve hatırlatma olarak taşınır.
- **Paralel işler:** Her iş kendi orkestratöründe ve kendi ajan oturumunda çalışır; farklı klasörlerdeki projeler aynı anda ilerler (varsayılan en fazla 3, Ayarlar → Süreç → "Aynı anda çalışan iş"). Aynı klasörde aynı anda tek iş çalışır ki iki ajan aynı dosyaları ezmesin. Her işin akışı, durdur/sürdür düğmeleri ve bildirimleri kendine aittir.
- **Tasarım dosyaları bağlayıcıdır:** Eklediğin HTML/CSS sayfalar, tasarım klasörü ya da çizimler projeye `docs/sonda/design/` altına kopyalanır; Sonda HTML sayfaları yalıtılmış pencerede açıp masaüstü ve mobil görüntüsünü alır. Gemini planlarken kaynakları ve bu görüntüleri görür; Claude planlayıcı ve kodlayan ajan dosyaları okur ve tasarımı projenin kendi yığınına taşır (renk/tipografi/aralık değerleri tasarım token'ı, sayfa parçaları bileşen olur; görseller ve fontlar projeye kopyalanır). Görünüşte tasarım, davranış ve veride doküman kazanır. Tasarım yalnızca bazı ekranları kapsıyorsa (ör. sadece landing page varken şartnamede yönetim paneli de anlatılıyorsa) kalan ekranlar aynı görsel dilde üretilir; eksik tasarım hata ya da soru sebebi değildir. İnceleyiciler ve son kabul, uygulamanın ekran görüntülerini tasarımın görüntüleriyle karşılaştırır; tasarımdan açıkça sapan sayfa sorun olarak döner.
- **Tasarım vermediysen de şablon görünüm yok:** Planlama sırasında Gemini ürün için bir **tasarım yönü** yazar — konsept ve duygu, adıyla seçilmiş tipografi (başlık için Inter/Roboto gibi varsayılanlar değil), hex değerli palet, yerleşim ilkeleri, ürünü tanınır kılan imza detaylar, bileşen stili, hareket, ikon/görsel yaklaşımı ve "kaçınılacaklar". Plan onayında **Tasarım yönü** bölümünde görürsün; beğenmezsen geri bildirimle değiştirirsin. Kodlayan ajan bu yönü tasarım token'ları ve ortak bileşenlerle kurar; mor-mavi degrade, cam efekti, "üç aynı kart", emoji ikon, lorem ipsum gibi "yapay zekâ şablonu" klişeleri yasaktır. Gemini'nin yönetici incelemesi tasarımı doğaçlamaya bırakan planı geri çevirir; görev ve son kabul incelemeleri ekran görüntülerinde jenerik görünümü ya da yönden sapmayı bulgu olarak açar.
- **Proje bazlı geçmiş:** Kenar çubuğunda her proje tek satırdır; o projede sonradan yapılan işler (özellik ekleme, hata düzeltme, refactor) projenin altında listelenir.
- **Özellik ekle:** Bitmiş projeye yeni özellik, projenin kendi yapısına uyacak şekilde eklenir. Claude önce klasör yapısını, katmanları, veri modelini, tasarım sistemini ve test düzenini okur; özelliği mevcut modülleri ve bileşenleri yeniden kullanarak tasarlar. Yeni gereksinimler (güvenlik olanlar `[SEC]`), şartname eki, varsayımlar ve görev planı onaya sunulur. Mevcut davranış ve testler değişmez; veri modeli değişikliği yeni bir migration ile yapılır. Onaydan sonra şartname ve gereksinim listesi güncellenir.
- **Hata düzelt / Refactor (bakım):** Bitmiş ya da mevcut bir projede, iş ekranındaki "Hata düzelt…" / "Refactor…" düğmeleri (ya da ⋯ menüsü) bakım penceresini açar. Hatalar ayrı kutulara yazılır (ne yaptın, ne oldu, ne olmalıydı); hata mesajı, log ya da ekran görüntüsü eklenebilir. Claude önce projeyi **salt okunur** inceler: hata için kök nedeni (dosya, satır, neden) ve aynı kusurun başka yerdeki örneklerini bulur; refactor için dosya boyutlarını, tekrar eden kodu, katman ihlallerini, zayıf testleri ve okurken gördüğü hataları çıkarır. Teşhis ve görev planı onaya sunulur; onaylamadan kod değişmez. Hata düzeltmede önce hatayı yakalayan test yazılır ve başarısız olduğu görülür, sonra kök neden düzeltilir. Refactor davranışı korur: rotalar, API biçimleri, veritabanı şeması ve arayüz metinleri aynı kalır, mevcut testlerin doğrulamaları zayıflatılamaz. Önceki Sonda planının gereksinimleri devralınır ve her görevin sonunda uzmanlar değişikliği inceler.
- **Zip olarak paketle:** Teslim kutusundaki ya da ⋯ menüsündeki düğme projeyi teslim paketi olarak zipler. Git deposunda dosya listesi git'ten alınır (`.gitignore`'a uyar): kaynak kod, testler, `docs/sonda`, `README` içeride; `node_modules`, derleme çıktıları ve **gizli dosyalar** (`.env*` — yalnızca `.env.example` kalır —, `.npmrc`, anahtar/sertifika, `*.tfstate`…) dışarıda. Yerel veritabanı dosyaları (`*.db`, `*.sqlite`) da dışarıdadır. İçinde senin gizli değerlerinden biri (herhangi bir biçimiyle; dosya boyutu sınırı olmadan) geçen dosya da pakete girmez ve adıyla bildirilir. Git geçmişi `.git` klasörünün kopyası olarak değil, **temiz bir kopya** olarak eklenir: yalnızca dalların ve etiketlerin ulaştığı commit'ler girer; değiştirilmiş (amend / reset) commit'ler, reflog ve sahipsiz nesneler girmez, uzak depo adresleri de girmez. Bu kopyada gizli dosya ya da değer commit'lenmişse, ya da geçmiş kopyalanamaz / taranamazsa geçmiş dışarıda bırakılır ve nedeni söylenir. Kayıt yeri sorulur, zip bittiğinde Finder/Gezgin'de gösterilir.
- **Uzman denetim paneli** (yalnızca Claude): Her faz kontrolünde ve teslimde üç uzman projeyi paralel, salt okunur inceler: güvenlik ve yapılandırma, iş kuralları ve veri bütünlüğü (yarış durumları, tekrar kuralları, zaman aşımı işleri) ve mimari, testler ve çalıştırılabilirlik. Ayrı bir Claude doğrulayıcı her bulguyu kodda kontrol eder; yanlış alarmlar elenir. Doğrulanan kritik/yüksek bulgular düzeltme turu açar, orta olanlar aynı turda ya da sonraki görevlerde düzeltilir; teslimde orta bulgular da engeller. Düzeltmeden sonra hedefli yeniden doğrulama yapılır.
- **Bağımsız denetim ("Claude önerileri"):** Görev incelemeleri her görevin farkını tek başına görür. Her 3 görevde bir (Ayarlar → Kalite → Bağımsız denetim, aralık Akış'ta) Claude Fable 5.1 bitmiş kodun tamamını planın kalan görevleriyle birlikte salt okunur inceler ve görev görev incelemenin kör noktasını arar: sonraki görevlerin dayanacağı temellerdeki eksikler (SDK, arayüz, sözleşme), sessizce hiç çalışmayan testler (toplanmayan test yolları, kapsam dışı kalan tip kontrolü, bozuk uygulamayı geçiren test kitleri) ve görev sınırlarına düşen kusurlar. Her öneri dosya/satır ve somut bir bozulma senaryosuyla gelir; ayrı bir doğrulayıcı her birini kodda kontrol eder, yanlış alarmlar elenir. Doğrulananlar bulgu defterine yazılır ve sonraki görev başlamadan bir kodlama oturumu uygular. Akış korunur: düzeltmeden önce kontrollerin durumu kaydedilir; düzeltme daha önce geçen bir kontrolü bozarsa aynı oturumda onarılır, olmazsa tamamen geri alınır ve öneriler defterde açık kalır. Uygulananlar doğrulayıcı onaylarsa "uygulandı" sayılır. İş ekranındaki "Claude önerileri" bölümü her önerinin akıbetini gösterir.
- **Yönetici seçimi (Gemini ya da Claude API):** Ürün tanımı, gereksinimler, plan onayı, son kabul (ekran görüntüleriyle), güvenlik denetimi ve teslim raporu "yönetici" adımlarıdır. Varsayılan yönetici Gemini'dir; Ayarlar → Genel → Yönetici'den **Claude (API anahtarı)** seçilirse aynı adımlar Anthropic Messages API'siyle yürür (varsayılan model Sonnet 5.5, Ayarlar'dan değiştirilebilir; Haiku 4.5 daha ucuzdur). İki sağlayıcı aynı sözleşmeyi taşır, yani akış değişmez; yalnızca anahtar, model, şema biçimi ve kullanım sayacı ("Claude API · N K token") farklıdır. Claude API anahtarı yalnızca Sonda'ya girilir (şifreli saklanır; `ANTHROPIC_API_KEY` ortam değişkeni bilerek okunmaz) ve ajanların ortamına hiç geçmez: kodlayan ve inceleyen Claude oturumları her zaman Claude CLI ve abonelikle çalışır. Seçilen yöneticinin anahtarı yoksa iş başlamaz; diğer sağlayıcının anahtarı yerine geçmez.
- **Claude modeli:** varsayılan **Opus 5.5** (`claude-opus-5-5`); planlama, kodlama ve incelemelerin hepsi onunla çalışır. Ayarlar → Ajanlar → Model açık bir seçim listesidir (ilk seçenek varsayılan; "Özel model kimliği" başka bir kimlik yazmanı sağlar). Kullanılan model kenar çubuğunda ("Claude · Opus 5.5"), iş menüsünde ve her işin başındaki "Modeller" satırında görünür.
- **Onay kanıta bağlıdır:** Gemini ya da Claude "onay" dese bile kapsamındaki bir gereksinim "eksik" bulunduysa, kanıtla karşılanmamış bir kabul kriteri varsa ya da inceleyicinin kendi çalıştırdığı test başarısızsa düzeltme turu açılır. Kalite puanı 1–10 aralığında tutulur ve doğrulanmış uzman bulgusuyla düşürülür.
- **Dayanıklılık:** Paralel çalışan inceleme adımlarından biri hata verirse diğerleri durdurulur (arkada ajan oturumu kalmaz). Gemini'nin geçici hatalarında yaklaşık 4 dakikaya yayılan yeniden denemeler yapılır; teslim raporu Gemini'ye ulaşılamasa bile eldeki sonuçlardan yazılır. Kayıtlar atomik yazılır (yarım kalmış bir yazma iş geçmişini bozmaz).
- **İstem enjeksiyonuna karşı:** Ajanların okuduğu her şey (proje dosyaları, README, test çıktısı, web sayfaları) veridir; talimat yalnızca Sonda'nın isteminden gelir. Bu kural kod yazan ve inceleyen tüm oturumlara eklenir; inceleyiciler böyle bir girişimi bulgu olarak bildirir.

## Paketleme

```bash
npm run dist:mac   # dist/Sonda Agent-<sürüm>-arm64.dmg ve x64.dmg
npm run dist:win   # dist/Sonda Agent Setup <sürüm>.exe (Windows'ta çalıştırılması önerilir)
```

İmzasız macOS uygulamasını ilk kez açarken Finder'da sağ tık → **Aç** deyin.

## Güvenlik notları

- Ajanlar varsayılan olarak MCP sunucularına ve Claude hesabındaki bağlayıcılara (Vercel, Shopify, Slack… gibi gerçek dünyada işlem yapan araçlar) **erişemez**: yerel yapılandırma `--strict-mcp-config` ile, hesap bağlayıcıları `ENABLE_CLAUDEAI_MCP_SERVERS=false` ile kapatılır. Ayarlar → Ajanlar'daki seçeneği açarsan tam otomatik modda bu araçları onay sormadan çağırabilir.
- "Tam otomatik" modda ajan, proje klasöründe onay sormadan komut çalıştırır (Claude `--dangerously-skip-permissions`, Codex `--dangerously-bypass-approvals-and-sandbox`). Yalnızca güvendiğin klasörlerde kullan ya da Ayarlar'dan **Güvenli** moda al.
- Gemini API anahtarı ve proje anahtarları (.env değerleri) işletim sisteminin anahtar zincirinde şifreli saklanır (macOS Keychain / Windows DPAPI). Şifreleme kullanılamıyorsa yalnızca sahibine açık bir dosyada düz durur (Ayarlar anahtarın kaynağını "dosya" diye gösterir) ve şifreleme kullanılabilir olunca ilk açılışta şifrelenir. `GEMINI_API_KEY` ortam değişkeni de desteklenir. Ayar ya da anahtar dosyası bozulursa üzerine yazılmaz: `<ad>.bozuk-<zaman>` olarak kenara alınır.
- Uygulama verileri: macOS `~/Library/Application Support/Sonda Agent`, Windows `%APPDATA%\Sonda Agent` (ayarlar, iş geçmişi, loglar, ekran görüntüleri).
- Aynı anda tek Sonda çalışır; ikinci açılış var olan pencereyi öne getirir. Çalışan iş varken çıkmak (⌘Q dahil) onay ister; çıkarken ajan süreçleri ve başlattıkları komutlar kapatılır.
- Ajanların açık bıraktığı **sahipsiz** geliştirme süreçleri (ör. kapatılmamış dev sunucusu) temizlenir; kendi terminalinde, editöründe ya da başka bir ajan oturumunda çalışan süreçlere dokunulmaz.
- Tarayıcı testi yalıtılmış, kalıcı olmayan bir oturumda çalışır: test edilen uygulama izin isteyemez, dosya indiremez, pencere açamaz; Basic Auth bilgisi yalnızca uygulamanın kendi adresine gönderilir.
- Proje klasörüne dokunan arayüz eylemleri (klasörü aç, editörde aç, çalıştır, zip) işin kimliğiyle çağrılır; klasör ve komutlar kayıtlı işten okunur.
- Arayüzden gelen klasör yolları (yeni iş başlatma, Anahtarlar penceresi) yalnızca bu oturumda "Klasör seç" ile seçilmiş, açılıştaki son proje ya da kayıtlı bir işin klasörü olabilir; başka bir klasör reddedilir.

## Sorun giderme

| Belirti | Çözüm |
|---|---|
| "Claude Code bulunamadı" | Bağlantı kartındaki **Claude'u kur ve bağla** düğmesine bas; ya da Ayarlar → CLI yolu'na tam yolu yaz (`which claude` / `where claude`). |
| "oturumu yok veya süresi dolmuş" | Hata kutusundaki ya da bağlantı kartındaki **Giriş yap** düğmesine bas; giriş algılanınca **Sürdür**. |
| Açılışta macOS anahtar zinciri parolası soruyor, pencere boş kalıyor | Uygulama farklı bir kod imzasıyla kurulmuş (ör. `codesign` ile yeniden imzalanmış); anahtar zincirindeki "Sonda Agent Safe Storage" kaydı eski kimliğe bağlı. Paketteki `Kur.command` ile (yeniden imzalamadan) kur; ya da bir kez parolayı girip "Her Zaman İzin Ver" de. |
| Günlükte beklenmeyen bir model görünüyor | Ayarlar → Ajanlar → Model'i kontrol et; "Opus 5.5 — varsayılan" seçili olmalı. |
| Model testi "model yanıt vermedi" diyor | Hesabının o modele erişimi olmayabilir; Ayarlar → Ajanlar → Model'den başka bir model seç. |
| Günlükte "This command requires approval" | Zararsız: salt okunur oturum (plan, inceleme) yalnızca okuma, test ve sürüm yoklama komutlarını çalıştırabilir; ajan izinli olmayan bir komut denedi ve engellendi. İş sürer. |
| Başlıkta "bağlantı bekleniyor" | İnternet ya da DNS kesildi; Sonda bekliyor, bağlantı gelince kendiliğinden sürer. Uygulamayı açık bırak. |
| Gemini 429 / kota | Sonda otomatik yeniden dener; sürerse daha hafif bir model seç ya da kotanı kontrol et. |
| Tarayıcı testi "Sunucu yanıt vermedi" | Projede `dev` betiğinin portu `PORT` ortam değişkeninden ya da çıktısındaki URL'den okunabilir olmalı. |

## Mimari

```
src/main/
  main.js            Electron penceresi, IPC, bildirimler, uyku engelleme, "uygulamayı çalıştır"
  orchestrator/      iş hattı (tek sınıf, sorumluluklarına göre dosyalar)
    index.js           çekirdek: durum, günlük, commit, ajan/Gemini çağrıları, iptal
    planning.js        keşif, gereksinimler, şartname ve görev planı, onay
    maintenance.js     özellik ekleme / hata düzeltme / refactor analizi ve planı
    task.js            görev: taban, teknik brif, TDD, kodlama, doğrulama → inceleme → düzeltme
    pipeline.js        hat: faz kapıları, son kabul, hafıza, rapor
    review.js          inceleme sonucunun birleştirilmesi, derin inceleme, uzman paneli, doğrulayıcı
    findings.js        bulgu defteri: kayıt, yeniden doğrulama, inceleme turunun birleştirilmesi
    audit.js           bağımsız denetim: her N görevde bütün kod + kalan görevler, doğrulama, uygulama, geri alma güvencesi
    shared.js          ortak sabitler
  prompts/           istemler ve JSON şemaları (index.js eski tek arayüzü korur)
    base · context · planning · task · review · specialists · maintenance · report · audit
  agents/            Claude Code / Codex: adapters (izinler, ayrıştırıcılar) · install · detect · run
  verify/            checks (lint/test/build) · browser (dev sunucusu, sayfa denetimleri) · fresh-clone
  gemini.js          Gemini REST istemcisi (yeniden deneme, JSON şema çıktısı, model listesi)
  anthropic.js       Claude API (Messages) istemcisi: yönetici olarak Gemini'nin yerine, aynı sözleşme (akış, araç çağrısıyla şema, görüntü)
  net.js             bağlantı yoklaması: kesintide beklenir, bağlantı gelince adım yeniden denenir
  models.js          Claude model kataloğu, varsayılan model (Opus 5.5), brif modeli (Fable 5.1)
  panel.js           uzman paneli birleştirme, kod alıntısı, bulgu defteri (aç / yeniden doğrula / kapat)
  docs.js            doküman ve tasarım dosyaları, hafıza dosyaları, CLAUDE.md/AGENTS.md
  project.js         dosya ağacı, paket yöneticisi, git (commit, diff, ilgili dosyalar, gizli dosya koruması)
  envfile.js         .env okuma/yazma (dotenv kuralları), gizlilik kuralları, maskeleme
  secrets.js         proje anahtarları: şifreli saklama, .env'ye yazma
  archive.js         teslim paketi (zip): dosya listesi, gizli dosya / değer / geçmiş denetimi
  procs.js           ajanların açık bıraktığı sahipsiz süreçleri bulma ve kapatma
  runner.js          alt süreç: satır akışı, zaman aşımı, süreç grubunu ve ağacını sonlandırma
  settings.js        ayarlar (doğrulamalı) + şifreli API anahtarı
  jobs.js            iş geçmişi, loglar, ekran görüntüleri (atomik kayıt)
  fsx.js · versions.js · env.js · preload.js
src/renderer/
  index.html · styles.css · markdown.js
  app/               arayüz (bağımlılıksız ES modülleri)
    core · history · sidebar · agents · theme · compose · job · logs · header · maintenance · env · settings · main
test/                `npm test` (çekirdek, sağlamlık, kalite hattı ve roller) · `npm run lint` (ESLint)
```
