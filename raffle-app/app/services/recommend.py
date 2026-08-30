"""낙첨자 AI 선물 추천: Twitch 팔로우 취향 프로필 + SodaGift 카탈로그 → top-3.

프로필은 참가자 브라우저가 로그인 시 Firestore participants[uid].tasteProfile로
저장한 [{name, category}] 목록. ANTHROPIC_API_KEY 미설정/호출 실패 시
fallback(랜덤 3개)으로 데모가 절대 죽지 않게 한다.
"""
import json
import logging
import random

import anthropic

from app import config
from app.services import sodagift

log = logging.getLogger("streamdrop.recommend")

_client: anthropic.AsyncAnthropic | None = None


def _get_client() -> anthropic.AsyncAnthropic:
    global _client
    if _client is None:
        _client = anthropic.AsyncAnthropic(api_key=config.ANTHROPIC_API_KEY)
    return _client


def ai_ready() -> bool:
    return bool(config.ANTHROPIC_API_KEY)


def _slim_catalog(products: list[dict]) -> list[dict]:
    """추천 카드/LLM 컨텍스트에 필요한 필드만 추린 카탈로그."""
    out = []
    for p in products:
        price = p.get("amount") or p.get("min_amount")
        if price is None:
            continue
        price = float(price)
        brand = p.get("brand") or {}
        out.append({
            "id": int(p["id"]),
            "name": p.get("name") or "",
            "brand": brand.get("name") or "",
            "category": p.get("category") or "",
            "amount": int(price) if price.is_integer() else price,
            "currency": p.get("currency") or "",
            "imageUrl": p.get("image_url") or "",
        })
    return out


def _fallback(catalog: list[dict], reason: str = "이번 이벤트에서 인기 있는 선물이에요") -> list[dict]:
    picks = random.sample(catalog, min(3, len(catalog)))
    return [{**p, "reason": reason} for p in picks]


async def _ask_claude(profile: list[dict], catalog: list[dict], country: str) -> list[dict]:
    """Claude에게 카탈로그에서 top-3 선택을 요청. {product_id, reason} JSON 배열."""
    slim = [{k: p[k] for k in ("id", "name", "brand", "category", "amount", "currency")}
            for p in catalog]
    taste = json.dumps(profile[:50], ensure_ascii=False) if profile else "(no follow data — general viewer)"
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


async def recommend(profile: list[dict] | None, country: str) -> list[dict]:
    """낙첨자 1명분 추천. 항상 0~3개의 상품 카드 리스트를 반환."""
    catalog = _slim_catalog(await sodagift.list_products(country))
    if not catalog:
        return []
    if not ai_ready():
        return _fallback(catalog)
    try:
        return await _ask_claude(profile or [], catalog, country)
    except anthropic.APIStatusError as e:
        log.warning("claude api error %s: %s", e.status_code, str(e)[:200])
    except anthropic.APIConnectionError:
        log.warning("claude connection error")
    except (json.JSONDecodeError, ValueError, KeyError) as e:
        log.warning("claude output parse failed: %s", e)
    return _fallback(catalog)
