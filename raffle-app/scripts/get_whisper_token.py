"""Twitch CLI/Client Secret 없이 귓속말용 유저 토큰 발급.

사용: .venv/bin/python scripts/get_whisper_token.py
  -> 출력된 Twitch 활성화 주소를 브라우저에서 열고 승인
  -> .env의 TWITCH_BOT_TOKEN / TWITCH_BOT_USER_ID 자동 갱신
"""
import re
import sys
import time
from pathlib import Path

import httpx
from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = ROOT / ".env"
env = dotenv_values(ENV_PATH)
CLIENT_ID = env.get("TWITCH_CLIENT_ID", "")
if not CLIENT_ID:
    sys.exit("TWITCH_CLIENT_ID가 .env에 없음")

SCOPE = "user:manage:whispers"

r = httpx.post(
    "https://id.twitch.tv/oauth2/device",
    data={"client_id": CLIENT_ID, "scopes": SCOPE},
)
r.raise_for_status()
device = r.json()

print("\n브라우저에서 열고 승인하세요 (귓속말 발신 계정으로 로그인):")
print(device["verification_uri"])
print(f"인증 코드: {device['user_code']}\n")

deadline = time.monotonic() + int(device["expires_in"])
interval = max(int(device.get("interval", 5)), 1)
while time.monotonic() < deadline:
    time.sleep(interval)
    r = httpx.post(
        "https://id.twitch.tv/oauth2/token",
        data={
            "client_id": CLIENT_ID,
            "scopes": SCOPE,
            "device_code": device["device_code"],
            "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
        },
    )
    if r.status_code == 200:
        break
    if r.status_code == 400 and r.json().get("message") == "authorization_pending":
        continue
    r.raise_for_status()
else:
    sys.exit("Twitch 인증 시간이 만료되었습니다. 다시 실행해 주세요.")

access = r.json()["access_token"]
u = httpx.get(
    "https://api.twitch.tv/helix/users",
    headers={
        "Authorization": f"Bearer {access}",
        "Client-Id": CLIENT_ID,
    },
)
u.raise_for_status()
user = u.json()["data"][0]

text = ENV_PATH.read_text()
for key, value in (
    ("TWITCH_BOT_TOKEN", access),
    ("TWITCH_BOT_USER_ID", user["id"]),
):
    if re.search(rf"^{key}=.*$", text, flags=re.M):
        text = re.sub(rf"^{key}=.*$", f"{key}={value}", text, flags=re.M)
    else:
        text += f"\n{key}={value}\n"
ENV_PATH.write_text(text)

print(f"\n✅ 완료: {user['display_name']} (id={user['id']}) — .env 갱신됨")
print("   토큰은 약 4시간 유효. 만료되면 이 스크립트를 다시 실행하세요.")
