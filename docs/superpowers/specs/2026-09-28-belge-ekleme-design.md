# Sohbete belge ekleme — Tasarım

*28 Eylül 2026 · Durum: onaylandı (sohbette, bölüm bölüm)*

## Amaç

Kullanıcı sohbete kendi belgesini ekler; Sonda belgeyi okur, soruya göre yalnız belgeden ya da belge ile webdeki güncel
bilgiyi birlikte kullanarak cevaplar. Örnek: *"Şu sözleşmemdeki kira artış maddesi yeni yasaya uygun mu?"* — Sonda
PDF'teki maddeyi bulur, güncel yasayı webde bulur, ikisini karşılaştırır ve hangi bilginin belgeden, hangisinin webden
geldiğini ayrı gösterir.

Yol haritasındaki "Senin dosyaların ve web bir arada" özelliğinin A seçeneğidir (sohbete ekleme). Belge kütüphanesi
(B) ve oturumu açık sitelerden okuma ayrı turlardır.

## Kullanıcının verdiği kararlar

| Soru | Karar |
|---|---|
| Belge Gemini'ye gidebilir mi? | Seçili modele göre: yerel modelde belge bilgisayardan çıkmaz; Gemini seçiliyse ilgili kısımlar gider ve arayüzde uyarı görünür |
| Dosya türleri (ilk sürüm) | Metni olan PDF, `.docx`, `.txt`, `.md`. Taranmış PDF, Excel/CSV, görsel yok |
| Web ne zaman kullanılır? | Soruya göre: belgeden cevaplanabilen soruda arama yapılmaz; güncel/dış bilgi gerekiyorsa belge + web |
| Belgenin modele verilişi | Karma: kısa belge tamamen, uzun belge soruya en yakın parçalar |

## Yapı ve veri akışı

### Yükleme — `sonda/belge.py` (yeni) ve `POST /api/belge`

- Arayüz dosyayı `multipart/form-data` ile `POST /api/belge`'ye gönderir.
- `belge.py` metni çıkarır:
  - PDF: `pypdf` ile sayfa sayfa
  - `.docx`: paragraf paragraf (sayfa bilgisi yok; ~3000 karakterlik "bölüm" numarası kullanılır)
  - `.txt` / `.md`: doğrudan (UTF-8, olmazsa cp1254 denenir)
- Kayıt: `veri/belgeler/<id>.json` → `{"id", "ad", "tur", "sayfa_sayisi", "karakter", "sayfalar": [{"no", "metin"}], "zaman"}`.
  Orijinal dosya saklanmaz.
- `id` sunucuda üretilir (`uuid4().hex`); dosya yolu yalnızca bu biçime uyan kimlikten kurulur (yol geçişi yok).
- Cevap: `{"id", "ad", "sayfa_sayisi", "karakter", "kesildi"}`; hata olursa 400 ve Türkçe `detail`.
- `DELETE /api/belge/{id}` belgeyi siler.
- Yeni bağımlılık: `python-docx` (Word için). `python-multipart` FastAPI'nin dosya yüklemesi için gerekir.

### Sohbete bağlama

- Sohbet kaydı (`localStorage`, `sonda-sohbetler`) yalnızca `belgeler: [{id, ad, sayfa_sayisi}]` tutar.
- `/api/sor` isteğine `belgeler: list[str]` (kimlikler) eklenir.
- Belge sohbete aittir; sohbet silinince arayüz belgeleri de `DELETE` ile siler.

### Cevaplama

1. `asistan.calistir` belge kimliklerini alır, `belge.yukle()` ile okur; bulunamayanları atlar ve arayüze bildirir.
2. Belge bağlamı hazırlanır (`belge.baglam(belgeler, soru, model)`):
   - Toplam metin sınırın altındaysa belgelerin tamamı. Sınır: Gemini ~60.000, yerel model ~15.000 karakter.
   - Değilse metin parçalara bölünür (`web._parcala` ile aynı mantık, parça sayfa numarasını taşır) ve soruya en yakın
     parçalar `bge-m3` embedding ile seçilir; toplam yine sınırın altında kalır. Embedding yapılamazsa (Ollama kapalı)
     sorudaki kelimelerin geçme sayısıyla seçilir.
3. Hızlı modda ön karar (`ON_KARAR_PROMPTU`) belgenin adını ve kısa bir özetini (ilk ~1500 karakter) görerek "arama
   gerekli mi?" kararını verir: belgeden cevaplanabiliyorsa arama yapılmaz.
4. Belge parçaları web kaynaklarıyla aynı `Kaynaklar` listesine numaralı girer; tür `belge`, başlık `sozlesme.pdf · s. 4`.
   Model `[n]` ile atıf yapar; sistem istemi belgeden gelenle webden geleni ayırmasını ister.
5. Derin modda belge bağlamı araştırma planı ve son rapor istemine eklenir; aynı kaynak numaralandırması kullanılır.
6. Görev modunda ilk sürümde belge kullanılmaz (istek belgeyle gelirse belgeler yok sayılır ve bu söylenir).

### Gizlilik

- Model yerelse belge metni hiçbir sunucuya gitmez (embedding de yerel `bge-m3`).
- Gemini seçiliyse modele giden belge bağlamı Gemini'ye gider; arayüz bunu ekli belgelerin altında yazar.
- Belge metni kalıcı kullanıcı hafızasına (`hafiza.json`) ve site hafızasına yazılmaz.

## Arayüz (`static/index.html`)

- Mesaj kutusunun solunda ataç simgesi; sohbet alanına sürükle-bırak da yükler.
- Yüklenen her belge mesaj kutusunun üstünde çip: `📄 sozlesme.pdf · 12 sayfa ✕`. Yüklenirken "okunuyor…";
  hata olursa kırmızı çip ve nedeni.
- Çipler sohbet boyunca kalır; ✕ belgeyi sohbetten çıkarır ve sunucudan siler.
- Gemini seçiliyken çiplerin altında soluk tek satır: "Belgenin ilgili kısımları Gemini'ye gönderilir."
- Belgeyle sorulan mesajın üstünde küçük `📄 sozlesme.pdf` etiketi.
- Kaynak listesinde belge kaynakları 📄 ile; tıklanınca parçanın metni açılır (adresi yok).

## Sınırlar

| Konu | Sınır |
|---|---|
| Dosya boyutu | 20 MB |
| Sohbet başına belge | 5 |
| Belge başına metin | 2 milyon karakter (~1000 sayfa); fazlası kesilir, `kesildi: true` ve kullanıcıya söylenir |
| Dosya türleri | `.pdf`, `.docx`, `.txt`, `.md` (uzantı ve içerik birlikte kontrol edilir) |

## Hata durumları

| Durum | Davranış |
|---|---|
| Desteklenmeyen tür, bozuk dosya | 400, "Bu dosyayı okuyamadım: …" |
| Şifreli PDF | 400, "PDF şifreli; şifresini kaldırıp yeniden ekle." |
| Taranmış PDF (sayfaların çoğunda metin yok) | 400, "Bu PDF taranmış görünüyor; ilk sürümde okuyamıyorum." |
| Boyut/sayı sınırı aşıldı | 400 ya da arayüzde yüklemeden önce uyarı |
| Embedding yapılamadı | Kelime eşleşmesiyle parça seçilir; hata verilmez |
| Sunucuda belge yok | Çip "belge bulunamadı"; soru belgesiz cevaplanır ve bu söylenir |

## Testler (önce test)

- `tests/test_belge.py`: PDF/docx/txt/md'den sayfa bilgili metin; şifreli, taranmış, bozuk dosya; boyut ve metin
  sınırı; kimlik biçimi (yol geçişi); kısa belgede tamamı, uzun belgede doğru parça (sahte embedding); embedding
  hatasında kelime yedeği. Örnek dosyalar testte üretilir (pypdf ile PDF, python-docx ile docx).
- `tests/test_sunucu.py`: `/api/belge` yükleme/silme, tür ve boyut reddi; `/api/sor` belgelerle.
- Hızlı mod (sahte model): belgeden cevaplanabilen soruda web araması yapılmaz; belge parçaları numaralı `belge`
  kaynağı olarak gelir; bulunamayan belge atlanır.
- `tests/test_arayuz.py`: çip ekleme/silme, Gemini uyarısı, sohbet silinince belge silme isteği.

## Kapsam dışı (bu tur)

Belge kütüphanesi (B), taranmış PDF/OCR, Excel/CSV, görsel, görev modunda belge kullanımı, belgeler arası kalıcı arama,
oturumu açık sitelerden okuma.
