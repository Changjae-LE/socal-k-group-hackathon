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
SODAGIFT_BASE_URL = os.getenv("SODAGIFT_BASE_URL", "https://biz-sandbox-api.sodagift.com").rstrip("/")
GIFT_SENDER_NAME = os.getenv("GIFT_SENDER_NAME", "StreamDrop")

# 공개 Firestore 이벤트와 로컬 SodaGift 지급 브리지를 연결한다.
FIREBASE_PROJECT_ID = os.getenv("FIREBASE_PROJECT_ID", "hackathon-korean")
FIREBASE_WEB_API_KEY = os.getenv("FIREBASE_WEB_API_KEY", "AIzaSyDLJZCsHtidnHpOEeEUqT1aX1kdYO8Yz7A")
FIRESTORE_EVENT_DOCUMENT = os.getenv("FIRESTORE_EVENT_DOCUMENT", "events/live").strip("/")
FIRESTORE_POLL_INTERVAL = float(os.getenv("FIRESTORE_POLL_INTERVAL", "1.5"))

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
