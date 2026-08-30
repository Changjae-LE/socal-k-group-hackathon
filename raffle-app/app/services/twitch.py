"""Twitch: OAuth(참가자 식별) + 귓속말 발송(best-effort)."""
import logging
import urllib.parse

import httpx

from app import config

log = logging.getLogger("streamdrop.twitch")

AUTH_BASE = "https://id.twitch.tv/oauth2"
HELIX = "https://api.twitch.tv/helix"


def redirect_uri() -> str:
    return f"{config.BASE_URL}/join/callback"


def authorize_url(state: str) -> str:
    params = {
        "client_id": config.TWITCH_CLIENT_ID,
        "redirect_uri": redirect_uri(),
        "response_type": "code",
        "scope": "user:read:follows",  # 취향 프로필용 팔로우 목록 열람
        "state": state,
    }
    return f"{AUTH_BASE}/authorize?{urllib.parse.urlencode(params)}"


async def exchange_code(code: str) -> str:
    """authorization code -> user access token"""
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.post(
            f"{AUTH_BASE}/token",
            data={
                "client_id": config.TWITCH_CLIENT_ID,
                "client_secret": config.TWITCH_CLIENT_SECRET,
                "code": code,
                "grant_type": "authorization_code",
                "redirect_uri": redirect_uri(),
            },
        )
        r.raise_for_status()
        return r.json()["access_token"]


async def get_user(user_token: str) -> dict:
    """토큰 소유자의 id / display_name / login 조회"""
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get(
            f"{HELIX}/users",
            headers={
                "Authorization": f"Bearer {user_token}",
                "Client-Id": config.TWITCH_CLIENT_ID,
            },
        )
        r.raise_for_status()
        data = r.json()["data"][0]
        return {
            "id": data["id"],
            "nickname": data.get("display_name") or data["login"],
            "login": data["login"],
        }


async def get_followed(user_token: str, user_id: str) -> list[dict]:
    """팔로우 채널 최대 100개: [{id, name}] (스코프 user:read:follows 필요)"""
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get(
            f"{HELIX}/channels/followed",
            params={"user_id": user_id, "first": 100},
            headers={
                "Authorization": f"Bearer {user_token}",
                "Client-Id": config.TWITCH_CLIENT_ID,
            },
        )
        r.raise_for_status()
        return [
            {"id": d["broadcaster_id"], "name": d["broadcaster_name"]}
            for d in r.json().get("data", [])
        ]


async def get_channel_categories(user_token: str, broadcaster_ids: list[str]) -> dict[str, str]:
    """채널별 현재 방송 카테고리(game_name). 100개씩 배치 조회."""
    out: dict[str, str] = {}
    async with httpx.AsyncClient(timeout=10) as client:
        for i in range(0, len(broadcaster_ids), 100):
            r = await client.get(
                f"{HELIX}/channels",
                params=[("broadcaster_id", b) for b in broadcaster_ids[i:i + 100]],
                headers={
                    "Authorization": f"Bearer {user_token}",
                    "Client-Id": config.TWITCH_CLIENT_ID,
                },
            )
            r.raise_for_status()
            for d in r.json().get("data", []):
                out[d["broadcaster_id"]] = d.get("game_name") or ""
    return out


async def send_whisper(to_user_id: str, message: str) -> None:
    """귓속말 발송. 실패 시 예외 — 호출부에서 best-effort 처리.

    요구사항: 발신 계정 전화번호 인증 + user:manage:whispers 스코프 토큰.
    제한: 초당 3건, (미인증 계정) 하루 신규 수신자 ~40명, 수신자가 차단 시 실패.
    """
    if not (config.TWITCH_BOT_USER_ID and config.TWITCH_BOT_TOKEN):
        raise RuntimeError("whisper not configured (TWITCH_BOT_USER_ID/TOKEN)")
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.post(
            f"{HELIX}/whispers",
            params={
                "from_user_id": config.TWITCH_BOT_USER_ID,
                "to_user_id": to_user_id,
            },
            headers={
                "Authorization": f"Bearer {config.TWITCH_BOT_TOKEN}",
                "Client-Id": config.TWITCH_CLIENT_ID,
            },
            json={"message": message},
        )
        if r.status_code != 204:
            raise RuntimeError(f"whisper failed {r.status_code}: {r.text[:200]}")
