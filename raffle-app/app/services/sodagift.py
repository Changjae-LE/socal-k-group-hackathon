"""SodaGift Biz API 연동 (LINK 배송).

플로우: 국가별 상품 선택 -> POST /v1/orders (LINK) -> GET /v1/orders/{id} 폴링
       -> order_items[].delivery.link (수령 URL, 비밀로 취급)

SODAGIFT_API_KEY 미설정 시 mock 모드: 가짜 링크를 즉시 반환한다.
"""
import asyncio
import json
import logging
import time
import uuid

import httpx

from app import config

log = logging.getLogger("streamdrop.sodagift")

HEADERS = {"SODA-API-KEY": config.SODAGIFT_API_KEY}
LINK_POLL_INTERVAL = 1.5
LINK_POLL_TIMEOUT = 30.0

# 국가별 상품 선택 캐시 (이벤트 동안 반복 조회 방지)
_product_cache: dict[str, dict] = {}


class SodaGiftError(Exception):
    pass


def mock_mode() -> bool:
    return not config.SODAGIFT_API_KEY


def _log_order(record: dict) -> None:
    """지급 사고 대비: 발급된 주문/링크를 파일에 영속 기록."""
    record["ts"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    with open("orders.log", "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


async def select_product(country: str) -> dict:
    """국가에서 LINK 배송 가능한 ON_SALE 상품 중 가장 저렴한 것을 선택.

    (해커톤: sandbox 잔액 절약을 위해 최저가. 고정가 상품 우선,
    custom amount 상품은 min_amount로 주문.)
    """
    if country in _product_cache:
        return _product_cache[country]

    async with httpx.AsyncClient(base_url=config.SODAGIFT_BASE_URL, headers=HEADERS, timeout=15) as client:
        r = await client.get(
            "/v1/products",
            params={"country_code": country, "delivery_method": "LINK", "size": 100},
        )
        if r.status_code != 200:
            raise SodaGiftError(f"products query failed {r.status_code}: {r.text[:200]}")
        products = r.json().get("products", [])

    candidates = []
    for p in products:
        if p.get("availability") != "ON_SALE":
            continue
        price = p.get("amount") or p.get("min_amount")
        if price is None:
            continue
        candidates.append((float(price), p))
    if not candidates:
        raise SodaGiftError(f"no LINK-deliverable product for country {country}")

    candidates.sort(key=lambda t: t[0])
    _, product = candidates[0]
    _product_cache[country] = product
    log.info("selected product for %s: [%s] %s", country, product["id"], product.get("name"))
    return product


async def _create_order(product: dict, recipient_name: str, ref_id: str) -> int:
    body = {
        "item": {"id": product["id"]},
        "delivery": {
            "method": "LINK",
            "recipient": {"name": recipient_name},
            "sender": {"name": config.GIFT_SENDER_NAME},
        },
        "message": "Congratulations! You won the StreamDrop giveaway 🎉",
        # 영숫자만 허용 (멱등키)
        "external_reference_id": ref_id,
    }
    # custom amount 상품이면 최소 금액으로 주문
    if product.get("amount") is None and product.get("min_amount") is not None:
        body["item"]["custom_amount"] = product["min_amount"]

    async with httpx.AsyncClient(base_url=config.SODAGIFT_BASE_URL, headers=HEADERS, timeout=20) as client:
        for attempt in range(3):
            r = await client.post("/v1/orders", json=body)
            if r.status_code == 200:
                return r.json()["id"]
            # order_retry_needed(500) 은 재시도 안전 (멱등키 있음)
            retriable = r.status_code == 500 and "order_retry_needed" in r.text
            if r.status_code == 429 or retriable:
                await asyncio.sleep(1.2 * (attempt + 1))
                continue
            raise SodaGiftError(f"create order failed {r.status_code}: {r.text[:300]}")
    raise SodaGiftError("create order: retries exhausted")


async def _fetch_link(order_id: int) -> str:
    """주문 상세를 폴링해서 delivery.link 획득."""
    deadline = time.monotonic() + LINK_POLL_TIMEOUT
    async with httpx.AsyncClient(base_url=config.SODAGIFT_BASE_URL, headers=HEADERS, timeout=15) as client:
        while time.monotonic() < deadline:
            r = await client.get(f"/v1/orders/{order_id}")
            if r.status_code == 200:
                data = r.json()
                items = data.get("order_items") or []
                # 단일 주문 응답이 order_item(단수)로 올 수도 있어 방어적으로 처리
                if not items and data.get("order_item"):
                    items = [data["order_item"]]
                for item in items:
                    link = (item.get("delivery") or {}).get("link")
                    if link:
                        return link
                    if item.get("status") == "CANCELLED":
                        raise SodaGiftError(f"order item cancelled (order {order_id})")
            await asyncio.sleep(LINK_POLL_INTERVAL)
    raise SodaGiftError(f"link not ready after {LINK_POLL_TIMEOUT}s (order {order_id})")


async def get_gift_link(nickname: str, country: str, ref_id: str) -> dict:
    """당첨자 1명분 처리. 반환: {order_id, product_name, link}"""
    if mock_mode():
        await asyncio.sleep(1.0)  # 데모 연출용 짧은 지연
        result = {
            "order_id": f"mock-{uuid.uuid4().hex[:8]}",
            "product_name": f"Mock Gift Card ({country})",
            "link": f"{config.BASE_URL}/claim/{uuid.uuid4().hex}",
        }
        _log_order({"mode": "mock", "nickname": nickname, "country": country, **result})
        return result

    product = await select_product(country)
    order_id = await _create_order(product, nickname, ref_id)
    link = await _fetch_link(order_id)
    result = {
        "order_id": str(order_id),
        "product_name": product.get("name") or "Gift",
        "link": link,
    }
    _log_order({"mode": "live", "nickname": nickname, "country": country,
                "order_id": order_id, "product": product.get("name"), "link": link})
    return result


def clear_cache() -> None:
    _product_cache.clear()
