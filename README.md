# Sonda Agent

**Gemini planlar ve denetler, Claude Code / Codex kodlar, Sonda test eder.**
macOS ve Windows'ta çalışan masaüstü uygulaması. İsteğini yaz ("Next.js ile e-ticaret sitesi yap") ya da teknik dokümanını bırak; gerisini senin yerine yaptırır.

```
 İstek + dokümanlar (PDF, Word, Markdown, wireframe)
        │
        ▼
 GEMİNİ — YÖNETİCİ (ürün ve "bitti"nin tanımı)
   keşif: isteği tam ürün tanımına genişletir, sadece senin verebileceğin kararları sorar
   gereksinimler (R1…Rn) = kabul edilecek işin tanımı
        │
        ▼
 CLAUDE — MÜHENDİS (salt-okunur, araçlarla)
   klasörü inceler, npm'den güncel sürümleri ve komut bayraklarını doğrular,
   teknik şartnameyi ve görev planını yazar (Given/When/Then + testler)
        │
        ▼
 GEMİNİ — plan kabulü: isteğe sadakat, kapsam, eksik/fazla, test tabanı
   beğenmezse "şunları değiştir" → Claude aynı oturumda revize eder (en fazla 2 tur)
        │
        ▼  (sen onaylarsın)
 ┌──────────────────────────── her görev ─────────────────────────────┐
 │ Gemini teknik brif → [TDD: QA Claude testleri yazar → Gemini       │
 │ testleri denetler] → Claude kodlar → lint · tip · test · build →   │
 │ Gemini madde madde inceler (tam dosyalar, kanıtlı kabul kriterleri)│
 │ → gerekirse düzeltme → hafıza → commit                             │
 └────────────────────────────────────────────────────────────────────┘
        ▼
 Faz kapısı: tüm kontroller + tarayıcı testi + Gemini + bağımsız Claude
 derin inceleme + güvenlik denetimi → engelleyici bulgular birleştirilir
        ▼
 Son kabul: kullanıcı yolculukları uçtan uca, bağımlılık güvenlik taraması
 (npm audit), güvenlik denetimi, en fazla 3 düzeltme turu
        ▼
 "Teslime hazır" yalnızca hepsi geçerse. Geçmezse "Teslime hazır değil":
 açık sorunlar listelenir, "Düzeltmeye devam et" ile yeni turlar başlatılır.
```

Plan yazımı Ayarlar'dan değiştirilebilir: *Claude yazar, Gemini yönetir* (önerilen) ya da *Gemini yazar, Claude eleştirir* (daha hızlı). Claude plan oturumu kullanılabilir bir plan vermezse Sonda otomatik olarak Gemini planlayıcıya geçer.

**İnceleme gücü** (Ayarlar): *Standart* yalnızca Gemini; *Derin* (önerilen) + Claude plan eleştirisi ve faz kapılarında/sonda derin inceleme; *Maksimum* + Claude her görevi de inceler. **TDD modu** isteğe bağlıdır.

İnceleyici Claude **salt okunurdur**: dosya yazamaz, yalnızca okuma/arama ve test/lint/tip/build komutlarını çalıştırabilir. Ajanlar bilgisayarındaki kişisel MCP bağlantılarını (deploy, tasarım araçları…) varsayılan olarak göremez.

## Kurulum

Gerekenler:

| Araç | Neden | Kurulum |
|---|---|---|
| Node.js 20+ | uygulama ve projeler | https://nodejs.org |
| Git | commit, kod farkı incelemesi | macOS: `xcode-select --install` · Windows: https://git-scm.com |
| Claude Code | kodlama ajanı | `npm install -g @anthropic-ai/claude-code` ardından terminalde `claude` (giriş) |
| Codex (isteğe bağlı) | alternatif ajan | `npm install -g @openai/codex` ardından `codex login` |
| Gemini API anahtarı | planlama ve inceleme | https://aistudio.google.com/apikey |

> Windows'ta Claude Code, Git for Windows'un (Git Bash) kurulu olmasını ister.

Çalıştırma:

```bash
npm install
npm start
```

İlk açılışta Ayarlar penceresi açılır. Gemini anahtarını gir, **Modelleri getir** ile modeli seç (önerilen: `gemini-pro-latest`) ve **Test et**'e bas. Ajan kartında **Bağlantıyı test et** ile Claude'un çalıştığını doğrula; giriş gerekiyorsa **Giriş yap** terminalde açar.

## Kullanım

1. **Klasör seç**: boş bir klasör yeni proje demektir. Dolu bir klasör seçersen Sonda mevcut projenin üzerine çalışır.
2. İsteğini yaz ve/veya **📎 Doküman ekle** ile teknik şartname, PRD, API dokümanı ya da ekran tasarımı ekle (sürükle-bırak da olur). PDF ve görselleri Gemini doğrudan okur; Word (.docx) metne çevrilir.
3. **Planla** (⌘↵ / Ctrl+↵). Gemini şartnameyi, gereksinim listesini ve görevleri çıkarır. Soruları varsa cevaplayıp **Planı güncelle** diyebilirsin. İstemediğin görevin işaretini kaldır.
4. **Onayla ve başlat**. Canlı akışta ajanın ne yaptığını, testleri ve Gemini incelemelerini izle. Çalışırken **Ajana talimat ver** kutusundan ek istek gönderebilirsin; bir sonraki adımda uygulanır.
5. Bittiğinde **Rapor**, **Ekran görüntüleri**, **Şartname** ve **Hafıza** sekmelerine bak. **▶ Uygulamayı çalıştır** projeyi başlatıp tarayıcıda açar. **Bu projede devam et** ile yeni özellik iste.

Durdurulan ya da uygulama kapanırken yarım kalan iş, geçmişten açılıp **↻ Sürdür** ile kaldığı görevden devam eder.

## Anahtarlar (.env)

Stripe, Twilio, veritabanı gibi servislerin anahtarlarını **🔑 Anahtarlar** penceresinden gir (yeni proje ekranında ya da iş başlığında).

- Proje `.env.example` dosyası yazınca Sonda onu okur ve bölümlere ayrılmış bir form gösterir: **gerekli** (yer tutucu ya da gizli bilgi), **varsayılan** (projenin kendi varsayılanı var) ve **isteğe bağlı** alanlar.
- Değerler bilgisayarda şifreli saklanır (macOS Keychain / Windows DPAPI) ve projenin `.env` dosyasına **Sonda tarafından** yazılır. Varsa `.env.local` da güncellenir, böylece eski bir yer tutucu gerçek değeri gölgelemez. Dosya izinleri yalnızca sahibine açıktır; `.gitignore` her ikisini de kapsar.
- Claude ve Gemini **değerleri görmez**, yalnızca adları bilir ve kodu bu adlara bağlar. Gemini'ye giden her metinde ve loglarda değerler `‹gizli:AD›` olarak maskelenir.
- Bir ajan anahtarı koda yazarsa o dosya commit dışında bırakılır ve ajandan anahtarı ortam değişkenine taşıması istenir.
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
| `CLAUDE.md`, `AGENTS.md` | ajanların her oturumda otomatik okuduğu, yukarıdakilere yönlendiren blok | Sonda |

Hafıza ve Gemini'nin "sonraki görevlere devreden notları" her ajan istemine olduğu gibi eklenir; güncel dosya ağacı da verilir. Aynı klasörde yeni bir iş başlattığında Gemini önceki şartnameyi, hafızayı ve günlüğü okuyarak planlar.

## Kalite

- **Mühendislik standartları** (Ayarlar'dan düzenlenebilir): strict TypeScript, girdi doğrulama (zod), katmanlı mimari, erişilebilirlik, güvenlik, test, placeholder yasağı… Her ajan istemine eklenir ve incelemede ölçüt olarak kullanılır.
- **Gemini kod incelemesi**: staff engineer rolünde; diff'i, test çıktılarını ve hafızayı okur. Başarısız komut, karşılanmamış kabul kriteri, bug, güvenlik açığı, kod tekrarı veya ciddi standart ihlali varsa düzeltme turu başlatır. Kalite puanı verir.
- **Görsel test**: son aşamada uygulama gizli bir tarayıcıda açılır, HTTP durumları, konsol/hidrasyon hataları ve ekran görüntüleri (masaüstü + mobil) Gemini'ye gösterilir.
- **Uzman denetim paneli** (yalnızca Claude): Her faz kontrolünde ve teslimde üç uzman projeyi paralel, salt okunur inceler: güvenlik ve yapılandırma, iş kuralları ve veri bütünlüğü (yarış durumları, tekrar kuralları, zaman aşımı işleri) ve mimari, testler ve çalıştırılabilirlik. Ayrı bir Claude doğrulayıcı her bulguyu kodda kontrol eder; yanlış alarmlar elenir. Doğrulanan kritik/yüksek bulgular düzeltme turu açar, orta olanlar aynı turda ya da sonraki görevlerde düzeltilir; teslimde orta bulgular da engeller. Düzeltmeden sonra hedefli yeniden doğrulama yapılır.
- Claude modeli varsayılan olarak **Opus 5.5** (`claude-opus-5-5`); Ayarlar → Ajanlar'dan değiştirilebilir. Düşünme seviyesi (effort) de oradadır.

## Paketleme

```bash
npm run dist:mac   # dist/Sonda Agent-<sürüm>-arm64.dmg ve x64.dmg
npm run dist:win   # dist/Sonda Agent Setup <sürüm>.exe (Windows'ta çalıştırılması önerilir)
```

İmzasız macOS uygulamasını ilk kez açarken Finder'da sağ tık → **Aç** deyin.

## Güvenlik notları

- "Tam otomatik" modda ajan, proje klasöründe onay sormadan komut çalıştırır (Claude `--dangerously-skip-permissions`, Codex `--dangerously-bypass-approvals-and-sandbox`). Yalnızca güvendiğin klasörlerde kullan ya da Ayarlar'dan **Güvenli** moda al.
- Gemini API anahtarı ve proje anahtarları (.env değerleri) işletim sisteminin anahtar zincirinde şifreli saklanır (macOS Keychain / Windows DPAPI). `GEMINI_API_KEY` ortam değişkeni de desteklenir.
- Uygulama verileri: macOS `~/Library/Application Support/Sonda`, Windows `%APPDATA%\Sonda` (ayarlar, iş geçmişi, loglar, ekran görüntüleri).

## Sorun giderme

| Belirti | Çözüm |
|---|---|
| "Claude Code bulunamadı" | Kurulumu yap ya da Ayarlar → Claude CLI yolu'na tam yolu yaz (`which claude` / `where claude`). |
| "oturumu yok veya süresi dolmuş" | Ayarlar → **Giriş yap** (ya da terminalde `claude`), sonra **Bağlantıyı test et**. |
| Gemini 429 / kota | Sonda otomatik yeniden dener; sürerse daha hafif bir model seç ya da kotanı kontrol et. |
| Tarayıcı testi "Sunucu yanıt vermedi" | Projede `dev` betiğinin portu `PORT` ortam değişkeninden ya da çıktısındaki URL'den okunabilir olmalı. |

## Mimari

```
src/main/
  main.js          Electron penceresi, IPC, bildirimler, uyku engelleme, "uygulamayı çalıştır"
  orchestrator.js  plan → görev döngüsü → doğrulama → inceleme → düzeltme → hafıza → son test → rapor
  prompts.js       Gemini sistem istemleri, JSON şemaları, ajan istem şablonları, standartlar
  gemini.js        Gemini REST istemcisi (yeniden deneme, JSON şema çıktısı, model listesi)
  agents.js        Claude Code / Codex adaptörleri (stream-json → log), kurulum/giriş tespiti
  verify.js        lint/test/build, dev sunucusu, gizli tarayıcıda ekran görüntüsü
  docs.js          doküman okuma (PDF/görsel/docx/metin), hafıza dosyaları, CLAUDE.md/AGENTS.md
  project.js       dosya ağacı, paket yöneticisi tespiti, git (commit, diff)
  runner.js        alt süreç: satır akışı, zaman aşımı, süreç ağacını öldürme (Win/mac)
  settings.js      ayarlar + şifreli API anahtarı
  jobs.js          iş geçmişi, loglar, ekran görüntüleri
src/renderer/      arayüz (bağımlılıksız HTML/CSS/JS)
```
