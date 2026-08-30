"""Twitch CLI 없이 귓속말용 유저 토큰 발급.

메인 서버를 잠시 내리고 8000 포트에서 콜백을 직접 받는다.
사용: .venv/bin/python scripts/get_whisper_token.py
  -> 출력된 URL을 브라우저에서 열고 승인
  -> .env의 TWITCH_BOT_TOKEN / TWITCH_BOT_USER_ID 자동 갱신
"""
import re
import secrets
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import httpx
from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = ROOT / ".env"
env = dotenv_values(ENV_PATH)
CLIENT_ID = env.get("TWITCH_CLIENT_ID", "")
CLIENT_SECRET = env.get("TWITCH_CLIENT_SECRET", "")
if not (CLIENT_ID and CLIENT_SECRET):
    sys.exit("TWITCH_CLIENT_ID/SECRET가 .env에 없음")

REDIRECT = "http://localhost:8000/join/callback"
STATE = secrets.token_urlsafe(16)
SCOPE = "user:manage:whispers"

auth_url = "https://id.twitch.tv/oauth2/authorize?" + urllib.parse.urlencode({
    "client_id": CLIENT_ID,
    "redirect_uri": REDIRECT,
    "response_type": "code",
    "scope": SCOPE,
    "state": STATE,
})
print("\n브라우저에서 열고 승인하세요 (귓속말 발신 계정으로 로그인):\n")
print(auth_url + "\n")

result = {}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        if urllib.parse.urlparse(self.path).path != "/join/callback":
            self.send_response(404); self.end_headers(); return
        if q.get("state", [""])[0] != STATE or not q.get("code"):
            self.send_response(400); self.end_headers()
            self.wfile.write("bad state/code — script를 다시 실행하세요".encode())
            return
        result["code"] = q["code"][0]
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write("<h2>✅ 발급 완료 — 터미널을 확인하세요. 이 창은 닫아도 됩니다.</h2>".encode())

    def log_message(self, *a):
        pass


server = HTTPServer(("0.0.0.0", 8000), Handler)
print("콜백 대기 중... (localhost:8000)")
while "code" not in result:
    server.handle_request()
server.server_close()

r = httpx.post("https://id.twitch.tv/oauth2/token", data={
    "client_id": CLIENT_ID,
    "client_secret": CLIENT_SECRET,
    "code": result["code"],
    "grant_type": "authorization_code",
    "redirect_uri": REDIRECT,
})
r.raise_for_status()
tok = r.json()
access = tok["access_token"]

u = httpx.get("https://api.twitch.tv/helix/users",
              headers={"Authorization": f"Bearer {access}", "Client-Id": CLIENT_ID})
u.raise_for_status()
user = u.json()["data"][0]

text = ENV_PATH.read_text()
for key, val in [("TWITCH_BOT_TOKEN", access), ("TWITCH_BOT_USER_ID", user["id"])]:
    if re.search(rf"^{key}=.*$", text, flags=re.M):
        text = re.sub(rf"^{key}=.*$", f"{key}={val}", text, flags=re.M)
    else:
        text += f"\n{key}={val}\n"
ENV_PATH.write_text(text)

print(f"\n✅ 완료: {user['display_name']} (id={user['id']}) — .env 갱신됨")
print("   토큰은 약 4시간 유효. 만료되면 이 스크립트를 다시 실행하세요.")
print("   이제 메인 서버를 다시 시작하면 됩니다.")
