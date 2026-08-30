"""환경변수 로드. .env 파일 기준."""
import os

from dotenv import load_dotenv

load_dotenv()

BASE_URL = os.getenv("BASE_URL", "http://localhost:8000").rstrip("/")

TWITCH_CLIENT_ID = os.getenv("TWITCH_CLIENT_ID", "")
TWITCH_CLIENT_SECRET = os.getenv("TWITCH_CLIENT_SECRET", "")
TWITCH_BOT_USER_ID = os.getenv("TWITCH_BOT_USER_ID", "")
TWITCH_BOT_TOKEN = os.getenv("TWITCH_BOT_TOKEN", "")

SODAGIFT_API_KEY = os.getenv("SODAGIFT_API_KEY", "")
SODAGIFT_BASE_URL = os.getenv("SODAGIFT_BASE_URL", "https://biz-sandbox-api.sodagift.com").rstrip("/")
GIFT_SENDER_NAME = os.getenv("GIFT_SENDER_NAME", "StreamDrop")
SODAGIFT_STORE_URL = os.getenv("SODAGIFT_STORE_URL", "https://sodagift.com")

# AI 추천 (미설정 시 fallback 추천으로 동작)
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
ANTHROPIC_MODEL = os.getenv("ANTHROPIC_MODEL", "claude-haiku-4-5")

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
