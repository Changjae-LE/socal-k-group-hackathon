"""SodaGift Biz API 연동 (LINK 배송).

플로우: 국가별 기본 상품 자동 선택 -> POST /v1/orders (LINK) -> GET /v1/orders/{id} 폴링
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

# 국가별 LINK 상품 카탈로그 캐시 (이벤트 동안 반복 조회 방지)
_catalog_cache: dict[str, list[dict]] = {}


class SodaGiftError(Exception):
    pass


def mock_mode() -> bool:
    return not config.SODAGIFT_API_KEY


def _log_order(record: dict) -> None:
    """지급 사고 대비용 기록. 수령 URL은 절대 평문으로 저장하지 않는다."""
    safe_record = {key: value for key, value in record.items() if key != "link"}
    safe_record["link_issued"] = bool(record.get("link"))
    safe_record["ts"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    with open("orders.log", "a", encoding="utf-8") as f:
        f.write(json.dumps(safe_record, ensure_ascii=False) + "\n")


def _product_rank(product: dict, price: float) -> tuple[int, int, float]:
    """Prefer fixed-price brand gifts for a predictable hackathon demo."""
    name = str(product.get("name") or "").lower()
    custom_amount = (
        product.get("min_amount") is not None
        and product.get("max_amount") is not None
    )
    generic_prepaid = any(token in name for token in (
        "prepaid", "mastercard", "universal", "promotional",
    ))
    return (
        1 if custom_amount else 0,
        1 if generic_prepaid else 0,
        price,
    )


async def list_products(country: str) -> list[dict]:
    """Return eligible LINK products for the winner's country."""
    if country in _catalog_cache:
        return _catalog_cache[country]

    async with httpx.AsyncClient(base_url=config.SODAGIFT_BASE_URL, headers=HEADERS, timeout=15) as client:
        response = await client.get(
            "/v1/products",
            params={"country_code": country, "delivery_method": "LINK", "size": 100},
        )
    if response.status_code != 200:
        raise SodaGiftError(
            f"products query failed {response.status_code}: {response.text[:200]}"
        )

    ranked = []
    for product in response.json().get("products", []):
        if product.get("availability") != "ON_SALE":
            continue
        if "LINK" not in (product.get("available_delivery_method") or []):
            continue
        price = product.get("amount") or product.get("min_amount")
        if price is None:
            continue
        ranked.append((_product_rank(product, float(price)), product))
    if not ranked:
        raise SodaGiftError(f"no LINK-deliverable product for country {country}")

    ranked.sort(key=lambda item: item[0])
    products = [product for _rank, product in ranked]
    _catalog_cache[country] = products
    return products


async def get_gift_options(country: str, limit: int = 3) -> list[dict]:
    """Publish only safe catalog fields for participant choice."""
    products = await list_products(country)
    return [
        {
            "id": int(product["id"]),
            "name": product.get("name") or "Gift",
            "amount": float(product.get("amount") or product.get("min_amount")),
            "currency": product.get("currency") or "",
            "imageUrl": product.get("image_url") or "",
        }
        for product in products[:limit]
    ]


async def select_product(country: str, product_id: int | None = None) -> dict:
    """Select a participant-approved product from the current SodaGift catalog."""
    products = await list_products(country)
    if product_id is None:
        product = products[0]
    else:
        product = next(
            (item for item in products if int(item.get("id")) == int(product_id)),
            None,
        )
        if product is None:
            raise SodaGiftError(
                f"selected product {product_id} is not available for country {country}"
            )
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
    # API 문서 기준: min/max_amount가 함께 반환되면 custom_amount 필수.
    # catalog의 amount가 함께 있더라도 가변금액 상품으로 판단한다.
    if (
        product.get("min_amount") is not None
        and product.get("max_amount") is not None
    ):
        body["item"]["custom_amount"] = product["min_amount"]

    async with httpx.AsyncClient(base_url=config.SODAGIFT_BASE_URL, headers=HEADERS, timeout=20) as client:
        for attempt in range(3):
            r = await client.post("/v1/orders", json=body)
            if r.status_code == 200:
                payload = r.json()
                raw_id = payload.get("id") or payload.get("order_id")
                if raw_id is None and isinstance(payload.get("order"), dict):
                    raw_id = payload["order"].get("id")
                if raw_id is None:
                    raise SodaGiftError(
                        "POST /v1/orders succeeded but carried no order id"
                    )
                return int(raw_id)
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


async def get_order_link(order_id: int | str) -> str:
    """Re-fetch the bearer URL for an existing SodaGift order."""
    return await _fetch_link(int(order_id))


async def get_gift_link(
    nickname: str,
    country: str,
    ref_id: str,
    product_id: int | None = None,
) -> dict:
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

    product = await select_product(country, product_id)
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
    _catalog_cache.clear()
