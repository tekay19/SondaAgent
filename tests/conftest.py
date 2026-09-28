import functools
import http.server
import sys
import threading
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

SAYFALAR = Path(__file__).resolve().parent / "sayfalar"


class _SessizIsleyici(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        # /yavas/<ms>/<yol>: yavaş sunucu (Heroku gibi); bekleyip asıl sayfaya yönlendirir
        if self.path.startswith("/yavas/"):
            _, _, ms, yol = self.path.split("/", 3)
            time.sleep(int(ms) / 1000)
            self.send_response(302)
            self.send_header("Location", "/" + yol)
            self.end_headers()
            return
        super().do_GET()


@pytest.fixture(scope="session")
def site():
    """tests/sayfalar klasörünü rastgele bir portta sunar; kök adresi döner."""
    isleyici = functools.partial(_SessizIsleyici, directory=str(SAYFALAR))
    sunucu = http.server.ThreadingHTTPServer(("127.0.0.1", 0), isleyici)
    threading.Thread(target=sunucu.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{sunucu.server_address[1]}"
    sunucu.shutdown()


@pytest.fixture
def yerel_tarayici_ac():
    """Playwright'ın kendi Chromium'unda Tarayici açan fonksiyon (kullanıcının Chrome'una dokunmaz).
    Playwright'ın senkron API'si iş parçacığına bağlı olduğundan, fonksiyon onu kullanacak iş parçacığında çağrılmalıdır."""
    from playwright.sync_api import sync_playwright

    from sonda.tarayici import Tarayici

    def ac():
        pw = sync_playwright().start()
        b = pw.chromium.launch(headless=True)
        sayfa = b.new_context(viewport={"width": 1280, "height": 900}).new_page()
        return Tarayici(sayfa, kapat=lambda: (b.close(), pw.stop()))
    return ac


@pytest.fixture
def tarayici(yerel_tarayici_ac):
    t = yerel_tarayici_ac()
    yield t
    t.kapat()


def ihlaller(t):
    """Test sayfalarının localStorage'a yazdığı güvenlik ihlalleri."""
    return t.sayfa.evaluate("JSON.parse(localStorage.getItem('ihlaller') || '[]')")


@pytest.fixture(autouse=True, scope="session")
def _gecici_gorev_kayitlari(tmp_path_factory):
    """Görev hata ayıklama kayıtları testlerde geçici klasöre gider (gerçek kayıtlar silinmesin)."""
    from sonda.gorev import ayar
    eski = ayar.KAYIT_KLASORU
    ayar.KAYIT_KLASORU = tmp_path_factory.mktemp("gorev_kayitlari")
    yield
    ayar.KAYIT_KLASORU = eski


@pytest.fixture(autouse=True, scope="session")
def _site_hafizasi_oturum(tmp_path_factory):
    """Site hafızası tüm oturumda geçici dosyaya yazılır: test bittikten sonra işini bitiren görev işçisi de gerçek
    veri/site_hafizasi.json'a yazamaz. Ders çıkarma (arka planda model çağrısı) başka testin sahte modelini
    tüketmesin diye kapalı; test_site_hafizasi açar."""
    from sonda.gorev import site_hafizasi
    eski = site_hafizasi.DOSYA, site_hafizasi.DERS_CIKAR
    site_hafizasi.DOSYA = tmp_path_factory.mktemp("site_hafizasi") / "site_hafizasi.json"
    site_hafizasi.DERS_CIKAR = False
    yield
    site_hafizasi.DOSYA, site_hafizasi.DERS_CIKAR = eski


@pytest.fixture(autouse=True)
def _gecici_site_hafizasi(tmp_path, monkeypatch, _site_hafizasi_oturum):
    """Her test boş bir site hafızasıyla başlar."""
    from sonda.gorev import site_hafizasi
    monkeypatch.setattr(site_hafizasi, "DOSYA", tmp_path / "site_hafizasi.json")


@pytest.fixture(autouse=True, scope="session")
def _test_captcha_ana_makinesi():
    """Testlerde yerel sahte captcha çerçeveleri localhost'tan gelir (gerçekte yalnızca bilinen captcha sunucuları)."""
    from sonda.tarayici import sayfa
    sayfa.CAPTCHA_SUNUCULARI["localhost"] = "/captcha"
    yield
    sayfa.CAPTCHA_SUNUCULARI.pop("localhost", None)
