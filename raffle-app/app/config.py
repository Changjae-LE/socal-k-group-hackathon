"""환경변수 로드. .env 파일 기준."""
import os

from dotenv import load_dotenv

load_dotenv()

BASE_URL = os.getenv("BASE_URL", "http://localhost:8000").rstrip("/")
PUBLIC_JOIN_URL = os.getenv("PUBLIC_JOIN_URL", "https://hackathon-korean.web.app/join").rstrip("/")
if "localhost" in PUBLIC_JOIN_URL or "127.0.0.1" in PUBLIC_JOIN_URL:
    PUBLIC_JOIN_URL = "https://hackathon-korean.web.app/join"
TWITCH_REDIRECT_URI = os.getenv("TWITCH_REDIRECT_URI", PUBLIC_JOIN_URL)
if "localhost" in TWITCH_REDIRECT_URI or "127.0.0.1" in TWITCH_REDIRECT_URI:
    TWITCH_REDIRECT_URI = PUBLIC_JOIN_URL

TWITCH_CLIENT_ID = os.getenv("TWITCH_CLIENT_ID", "")
TWITCH_CLIENT_SECRET = os.getenv("TWITCH_CLIENT_SECRET", "")
TWITCH_BOT_USER_ID = os.getenv("TWITCH_BOT_USER_ID", "")
TWITCH_BOT_TOKEN = os.getenv("TWITCH_BOT_TOKEN", "")

SODAGIFT_API_KEY = os.getenv("SODAGIFT_API_KEY", "")
_soda_raw = os.getenv("SODAGIFT_BASE_URL", "https://biz-sandbox-api.sodagift.com").rstrip("/")
# Docs first-call URL is /v1/accounts/balance. If that full path is pasted, keep the API host.
if "/v1/" in _soda_raw:
    SODAGIFT_BASE_URL = _soda_raw.split("/v1/")[0].rstrip("/")
else:
    SODAGIFT_BASE_URL = _soda_raw
SODAGIFT_BALANCE_PATH = "/v1/accounts/balance"
GIFT_SENDER_NAME = os.getenv("GIFT_SENDER_NAME", "StreamDrop")

ADMIN_TOKEN = os.getenv("ADMIN_TOKEN", "streamdrop")
SECRET_KEY = os.getenv("SECRET_KEY", "dev-secret-change-me")
DEBUG = os.getenv("DEBUG", "0") == "1"

# SodaGift CountryCode enum과 일치 (지원 국가만 노출)
COUNTRIES = [
    ("KR", "🇰🇷 South Korea"),
    ("US", "🇺🇸 United States"),
    ("JP", "🇯🇵 Japan"),
    ("CA", "🇨🇦 Canada"),
    ("AU", "🇦🇺 Australia"),
    ("GB", "🇬🇧 United Kingdom"),
    ("FR", "🇫🇷 France"),
    ("SG", "🇸🇬 Singapore"),
    ("HK", "🇭🇰 Hong Kong"),
    ("TW", "🇹🇼 Taiwan"),
    ("PH", "🇵🇭 Philippines"),
    ("TH", "🇹🇭 Thailand"),
    ("VN", "🇻🇳 Vietnam"),
    ("MY", "🇲🇾 Malaysia"),
    ("ID", "🇮🇩 Indonesia"),
    ("IN", "🇮🇳 India"),
    ("CN", "🇨🇳 China"),
]
COUNTRY_CODES = {c for c, _ in COUNTRIES}
