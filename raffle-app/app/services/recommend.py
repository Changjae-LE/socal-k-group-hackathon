"""AI 선물 추천: 팔로우 채널 취향 프로필 + SodaGift 카탈로그 → top-3.

ANTHROPIC_API_KEY 미설정/호출 실패 시 fallback(랜덤 3개)으로 데모가 절대 죽지 않게 한다.
"""
import json
import logging
import random

import anthropic

from app import config
from app.services import sodagift, twitch

log = logging.getLogger("streamdrop.recommend")

# uid -> 취향 프로필 (로그인 콜백 시점엔 Participant가 아직 없어서 별도 보관)
_profiles: dict[str, dict] = {}

_client: anthropic.AsyncAnthropic | None = None

# dev 참가자용 가짜 취향 로테이션
_MOCK_TASTES = [
    [{"name": "faker", "category": "League of Legends"}, {"name": "chess", "category": "Chess"}],
    [{"name": "cookingqueen", "category": "Food & Drink"}, {"name": "mukbang_tv", "category": "Just Chatting"}],
    [{"name": "lofigirl", "category": "Music"}, {"name": "pianodays", "category": "Music"}],
    [{"name": "speedrun_kr", "category": "Super Mario 64"}, {"name": "retrogamer", "category": "Retro"}],
    [{"name": "beautylab", "category": "Just Chatting"}, {"name": "fashionista", "category": "IRL"}],
]


def _get_client() -> anthropic.AsyncAnthropic:
    global _client
    if _client is None:
        _client = anthropic.AsyncAnthropic(api_key=config.ANTHROPIC_API_KEY)
    return _client


def ai_ready() -> bool:
    return bool(config.ANTHROPIC_API_KEY)


def set_profile(uid: str, profile: dict) -> None:
    _profiles[uid] = profile


def get_profile(uid: str) -> dict:
    return _profiles.get(uid, {"channels": []})


def mock_profile(nick: str) -> dict:
    return {"channels": random.choice(_MOCK_TASTES)}


async def fetch_profile(user_token: str, user: dict) -> dict:
    """팔로우 채널 + 카테고리로 취향 프로필 생성. 실패해도 빈 프로필 반환 (best-effort)."""
    try:
        followed = await twitch.get_followed(user_token, user["id"])
        cats = await twitch.get_channel_categories(user_token, [f["id"] for f in followed]) if followed else {}
        channels = [{"name": f["name"], "category": cats.get(f["id"], "")} for f in followed]
        log.info("profile for %s: %d followed channels", user.get("nickname"), len(channels))
        return {"channels": channels}
    except Exception:
        log.exception("profile fetch failed for %s", user.get("nickname"))
        return {"channels": []}


def _fallback(catalog: list[dict], reason: str = "이번 이벤트에서 인기 있는 선물이에요") -> list[dict]:
    picks = random.sample(catalog, min(3, len(catalog)))
    return [{**p, "reason": reason} for p in picks]


async def _ask_claude(profile: dict, catalog: list[dict], country: str) -> list[dict]:
    """Claude에게 카탈로그에서 top-3 선택을 요청. {product_id, reason} JSON 배열."""
    slim = [{"id": p["id"], "name": p["name"], "brand": p["brand"],
             "category": p["category"], "amount": p["amount"], "currency": p["currency"]}
            for p in catalog]
    channels = profile.get("channels") or []
    taste = json.dumps(channels[:50], ensure_ascii=False) if channels else "(no follow data — general viewer)"
    resp = await _get_client().messages.create(
        model=config.ANTHROPIC_MODEL,
        max_tokens=1000,
        system=(
            "You are a gift curator for a Twitch giveaway. Given a viewer's followed channels "
            "(with content categories) and a gift catalog, pick the 3 gifts that best match their taste. "
            "Reply with ONLY a JSON array: [{\"product_id\": <id from catalog>, \"reason\": \"...\"}]. "
            "Each reason is ONE short friendly sentence addressed to the viewer, written in the main "
            "language of their country, referencing their taste. No markdown, no extra text."
        ),
        messages=[{
            "role": "user",
            "content": f"Viewer country: {country}\nFollowed channels: {taste}\nCatalog: {json.dumps(slim, ensure_ascii=False)}",
        }],
    )
    text = "".join(b.text for b in resp.content if b.type == "text").strip()
    if text.startswith("```"):
        text = text.strip("`").lstrip("json").strip()
    picks = json.loads(text)

    by_id = {p["id"]: p for p in catalog}
    out = []
    for pick in picks:
        prod = by_id.get(pick.get("product_id"))
        if prod:
            out.append({**prod, "reason": str(pick.get("reason", ""))[:200]})
    if not out:
        raise ValueError("no valid product ids in model output")
    return out[:3]


async def recommend(uid: str, country: str) -> list[dict]:
    """낙첨자 1명분 추천. 항상 1~3개의 상품 카드 리스트를 반환."""
    catalog = await sodagift.list_catalog(country)
    if not catalog:
        return []
    if not ai_ready():
        return _fallback(catalog)
    try:
        return await _ask_claude(get_profile(uid), catalog, country)
    except anthropic.APIStatusError as e:
        log.warning("claude api error %s: %s", e.status_code, str(e)[:200])
    except anthropic.APIConnectionError:
        log.warning("claude connection error")
    except (json.JSONDecodeError, ValueError, KeyError) as e:
        log.warning("claude output parse failed: %s", e)
    return _fallback(catalog)


def clear() -> None:
    _profiles.clear()
