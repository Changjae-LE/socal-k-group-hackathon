"""SodaGift Biz API LINK delivery.

Flow: catalog lookup -> optional realtime availability check -> idempotent order
creation -> order polling -> secret delivery URL.

The delivery URL is returned to the caller only. It must never be logged or
broadcast to public/admin channels.
"""
import asyncio
import json
import logging
import time
import uuid

import httpx

from app import config

log = logging.getLogger("streamdrop.sodagift")

_product_cache: dict[str, dict] = {}
_ALLOWED_LOG_FIELDS = {
    "mode",
    "country",
    "external_reference_id",
    "order_id",
    "product_name",
    "status",
}


class SodaGiftError(Exception):
    """Safe, user-displayable SodaGift integration error."""


def mock_mode() -> bool:
    return not config.SODAGIFT_API_KEY.strip()


def _headers() -> dict[str, str]:
    return {
        "SODA-API-KEY": config.SODAGIFT_API_KEY,
        "Accept": "application/json",
        "Content-Type": "application/json",
    }


def _error_description(response: httpx.Response) -> str:
    if response.status_code == 401:
        return "unauthorized: check SODAGIFT_API_KEY"
    try:
        body = response.json()
    except ValueError:
        return f"HTTP {response.status_code}"
    code = body.get("errorCode") or body.get("code") or f"HTTP {response.status_code}"
    message = body.get("message")
    return f"{code}: {message}" if message else str(code)


def _log_order(record: dict) -> None:
    """Persist operational metadata without recipient identity or claim URL."""
    safe = {
        key: value
        for key, value in record.items()
        if key in _ALLOWED_LOG_FIELDS and value is not None
    }
    safe["ts"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    with open("orders.log", "a", encoding="utf-8") as stream:
        stream.write(json.dumps(safe, ensure_ascii=False) + "\n")


def _product_order_amount(product: dict) -> float | None:
    amount = product.get("amount")
    if amount is not None:
        return float(amount)
    minimum = product.get("min_amount")
    return float(minimum) if minimum is not None else None


async def _get_with_rate_limit_retry(
    client: httpx.AsyncClient,
    path: str,
    *,
    params: dict | None = None,
) -> httpx.Response:
    for attempt in range(2):
        response = await client.get(path, params=params)
        if response.status_code != 429:
            return response
        await asyncio.sleep(1.0 + attempt)
    return response


async def select_product(country: str) -> dict:
    """Select the lowest-value LINK product available for the country."""
    if country in _product_cache:
        return _product_cache[country]

    async with httpx.AsyncClient(
        base_url=config.SODAGIFT_BASE_URL,
        headers=_headers(),
        timeout=15,
    ) as client:
        response = await _get_with_rate_limit_retry(
            client,
            "/v1/products",
            params={
                "country_code": country,
                "delivery_method": "LINK",
                "page": 0,
                "size": 100,
            },
        )
        if response.status_code != 200:
            raise SodaGiftError(
                f"product catalog failed: {_error_description(response)}"
            )

        products = response.json().get("products") or []
        candidates: list[tuple[float, dict]] = []
        for product in products:
            if product.get("availability") != "ON_SALE":
                continue
            if "LINK" not in (product.get("available_delivery_method") or []):
                continue
            amount = _product_order_amount(product)
            if amount is None:
                continue
            candidates.append((amount, product))

        if not candidates:
            raise SodaGiftError(
                f"no LINK-deliverable ON_SALE product for country {country}"
            )
        candidates.sort(key=lambda candidate: candidate[0])

        selected = candidates[0][1]
        if config.SODAGIFT_CHECK_AVAILABILITY:
            unknown_fallback: dict | None = None
            selected = None
            # Avoid turning one draw into a large burst of supplier checks.
            for _, product in candidates[:5]:
                availability = await _get_with_rate_limit_retry(
                    client,
                    f"/v1/products/{product['id']}/availability",
                )
                if availability.status_code != 200:
                    unknown_fallback = unknown_fallback or product
                    continue
                status = availability.json().get("status", "UNKNOWN")
                if status == "ON_SALE":
                    selected = product
                    break
                if status == "UNKNOWN":
                    unknown_fallback = unknown_fallback or product

            # UNKNOWN means the supplier check failed, not necessarily sold out.
            # Preserve demo continuity while clearly recording the fallback.
            if selected is None and unknown_fallback is not None:
                selected = unknown_fallback
                log.warning(
                    "using catalog availability fallback for country %s product %s",
                    country,
                    selected["id"],
                )
            if selected is None:
                raise SodaGiftError(
                    f"no realtime-available LINK product for country {country}"
                )

    _product_cache[country] = selected
    log.info(
        "selected SodaGift product for %s: id=%s name=%s",
        country,
        selected["id"],
        selected.get("name"),
    )
    return selected


async def _create_order(product: dict, recipient_name: str, ref_id: str) -> int:
    item = {"id": product["id"]}
    if product.get("amount") is None and product.get("min_amount") is not None:
        item["custom_amount"] = product["min_amount"]

    body = {
        "item": item,
        "delivery": {
            "method": "LINK",
            "recipient": {"name": recipient_name},
            "sender": {"name": config.GIFT_SENDER_NAME},
        },
        "message": "Congratulations! You won the StreamDrop giveaway 🎉",
        "external_reference_id": ref_id,
    }

    async with httpx.AsyncClient(
        base_url=config.SODAGIFT_BASE_URL,
        headers=_headers(),
        timeout=20,
    ) as client:
        for attempt in range(3):
            response = await client.post("/v1/orders", json=body)
            if response.status_code == 200:
                order_id = response.json().get("id")
                if order_id is None:
                    raise SodaGiftError("order response did not include an id")
                return int(order_id)

            error = _error_description(response)
            retryable = response.status_code == 429 or (
                response.status_code == 500
                and error.startswith("order_retry_needed")
            )
            if not retryable:
                raise SodaGiftError(f"create order failed: {error}")
            await asyncio.sleep(1.0 + attempt)

    raise SodaGiftError("create order failed after 3 attempts")


async def _fetch_link(order_id: int) -> str:
    """Poll the order until SodaGift exposes order_items[].delivery.link."""
    deadline = time.monotonic() + config.SODAGIFT_LINK_POLL_TIMEOUT
    last_state = "not returned"

    async with httpx.AsyncClient(
        base_url=config.SODAGIFT_BASE_URL,
        headers=_headers(),
        timeout=15,
    ) as client:
        while time.monotonic() < deadline:
            response = await _get_with_rate_limit_retry(
                client,
                f"/v1/orders/{order_id}",
            )
            if response.status_code != 200:
                raise SodaGiftError(
                    f"order lookup failed: {_error_description(response)}"
                )

            data = response.json()
            order_status = data.get("status", "UNKNOWN")
            items = data.get("order_items") or []
            if not items and data.get("order_item"):
                items = [data["order_item"]]

            item_states = []
            for item in items:
                item_status = item.get("status", "UNKNOWN")
                item_states.append(item_status)
                link = (item.get("delivery") or {}).get("link")
                if link:
                    return link
                if item_status == "CANCELLED":
                    raise SodaGiftError(f"order item cancelled (order {order_id})")

            if order_status in {"PAYMENT_EXPIRED", "CANCELLED"}:
                raise SodaGiftError(
                    f"order {order_id} ended with status {order_status}"
                )
            last_state = f"order={order_status}, items={item_states or ['missing']}"
            await asyncio.sleep(config.SODAGIFT_LINK_POLL_INTERVAL)

    raise SodaGiftError(
        f"claim link not ready after {config.SODAGIFT_LINK_POLL_TIMEOUT:.0f}s "
        f"(order {order_id}, {last_state})"
    )


async def get_gift_link(nickname: str, country: str, ref_id: str) -> dict:
    """Create one idempotent reward and return its secret claim URL in memory."""
    if mock_mode():
        await asyncio.sleep(1.0)
        result = {
            "order_id": f"mock-{uuid.uuid4().hex[:8]}",
            "product_name": f"Mock Gift Card ({country})",
            "link": f"{config.BASE_URL}/claim/{uuid.uuid4().hex}",
        }
        _log_order(
            {
                "mode": "mock",
                "country": country,
                "external_reference_id": ref_id,
                "order_id": result["order_id"],
                "product_name": result["product_name"],
                "status": "link_ready",
            }
        )
        return result

    product = await select_product(country)
    order_id = await _create_order(product, nickname, ref_id)
    link = await _fetch_link(order_id)
    result = {
        "order_id": str(order_id),
        "product_name": product.get("name") or "Gift",
        "link": link,
    }
    _log_order(
        {
            "mode": "sandbox"
            if "sandbox" in config.SODAGIFT_BASE_URL
            else "production",
            "country": country,
            "external_reference_id": ref_id,
            "order_id": order_id,
            "product_name": result["product_name"],
            "status": "link_ready",
        }
    )
    return result


def clear_cache() -> None:
    _product_cache.clear()
