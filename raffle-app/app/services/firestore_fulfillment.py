"""Bridge public Firestore winners to private SodaGift LINK fulfillment.

The browser stores only an RSA public key in Firestore. This worker keeps the
SodaGift API key on the host, encrypts each claim link for the winner's device,
and writes only ciphertext back to the public event document.
"""

from __future__ import annotations

import asyncio
import base64
import copy
import logging
import os
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

import httpx
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app import config
from app.services import sodagift, twitch

log = logging.getLogger("streamdrop.firestore_fulfillment")

GiftProvider = Callable[[str, str, str, int | None], Awaitable[dict[str, str]]]
WhisperProvider = Callable[[str, str], Awaitable[None]]
LinkProvider = Callable[[int | str], Awaitable[str]]


def _decode_value(value: dict[str, Any]) -> Any:
    if "nullValue" in value:
        return None
    if "booleanValue" in value:
        return value["booleanValue"]
    if "integerValue" in value:
        return int(value["integerValue"])
    if "doubleValue" in value:
        return float(value["doubleValue"])
    if "stringValue" in value:
        return value["stringValue"]
    if "timestampValue" in value:
        return value["timestampValue"]
    if "arrayValue" in value:
        return [_decode_value(item) for item in value["arrayValue"].get("values", [])]
    if "mapValue" in value:
        return {
            key: _decode_value(item)
            for key, item in value["mapValue"].get("fields", {}).items()
        }
    raise ValueError(f"unsupported Firestore value: {tuple(value)}")


def _encode_value(value: Any) -> dict[str, Any]:
    if value is None:
        return {"nullValue": None}
    if isinstance(value, bool):
        return {"booleanValue": value}
    if isinstance(value, int):
        return {"integerValue": str(value)}
    if isinstance(value, float):
        return {"doubleValue": value}
    if isinstance(value, str):
        return {"stringValue": value}
    if isinstance(value, list):
        return {"arrayValue": {"values": [_encode_value(item) for item in value]}}
    if isinstance(value, dict):
        return {
            "mapValue": {
                "fields": {key: _encode_value(item) for key, item in value.items()}
            }
        }
    raise TypeError(f"unsupported Firestore value type: {type(value).__name__}")


@dataclass(frozen=True)
class EventSnapshot:
    data: dict[str, Any]
    update_time: str


class FirestoreEventStore:
    """Minimal Firestore REST client for the single hackathon event document."""

    def __init__(self, client: httpx.AsyncClient | None = None) -> None:
        project = config.FIREBASE_PROJECT_ID
        self._document_name = (
            f"projects/{project}/databases/(default)/documents/"
            f"{config.FIRESTORE_EVENT_DOCUMENT}"
        )
        self._client = client or httpx.AsyncClient(
            base_url=f"https://firestore.googleapis.com/v1/projects/{project}/databases/(default)/documents",
            timeout=15,
        )
        self._owns_client = client is None

    async def __aenter__(self) -> "FirestoreEventStore":
        return self

    async def __aexit__(self, *_exc: object) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def get_event(self) -> EventSnapshot | None:
        response = await self._client.get(
            f"/{config.FIRESTORE_EVENT_DOCUMENT}",
            params={"key": config.FIREBASE_WEB_API_KEY},
        )
        if response.status_code == 404:
            return None
        response.raise_for_status()
        payload = response.json()
        data = {
            key: _decode_value(value)
            for key, value in payload.get("fields", {}).items()
        }
        return EventSnapshot(data=data, update_time=payload["updateTime"])

    async def replace_winners(
        self,
        winners: list[dict[str, Any]],
        expected_update_time: str,
    ) -> bool:
        params = [
            ("key", config.FIREBASE_WEB_API_KEY),
            ("updateMask.fieldPaths", "winners"),
            ("updateMask.fieldPaths", "updatedAt"),
            ("currentDocument.updateTime", expected_update_time),
        ]
        body = {
            "name": self._document_name,
            "fields": {
                "winners": _encode_value(winners),
                "updatedAt": _encode_value(int(time.time() * 1000)),
            },
        }
        response = await self._client.patch(
            f"/{config.FIRESTORE_EVENT_DOCUMENT}",
            params=params,
            json=body,
        )
        if response.status_code in {409, 412} or "FAILED_PRECONDITION" in response.text:
            return False
        response.raise_for_status()
        return True


def _b64url_decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _b64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _public_key_from_jwk(jwk: dict[str, Any]) -> rsa.RSAPublicKey:
    if jwk.get("kty") != "RSA" or not jwk.get("n") or not jwk.get("e"):
        raise ValueError("winner claim public key is not a valid RSA JWK")
    modulus = int.from_bytes(_b64url_decode(jwk["n"]), "big")
    exponent = int.from_bytes(_b64url_decode(jwk["e"]), "big")
    return rsa.RSAPublicNumbers(exponent, modulus).public_key()


def encrypt_gift_link(link: str, public_jwk: dict[str, Any]) -> dict[str, str]:
    """Hybrid-encrypt a variable-length link for Web Crypto in the winner browser."""
    public_key = _public_key_from_jwk(public_jwk)
    aes_key = AESGCM.generate_key(bit_length=256)
    iv = os.urandom(12)
    ciphertext = AESGCM(aes_key).encrypt(iv, link.encode("utf-8"), None)
    wrapped_key = public_key.encrypt(
        aes_key,
        padding.OAEP(
            mgf=padding.MGF1(algorithm=hashes.SHA256()),
            algorithm=hashes.SHA256(),
            label=None,
        ),
    )
    return {
        "alg": "RSA-OAEP-256+A256GCM",
        "wrappedKey": _b64url_encode(wrapped_key),
        "iv": _b64url_encode(iv),
        "ciphertext": _b64url_encode(ciphertext),
    }


def _uid(winner: dict[str, Any]) -> str:
    return str(winner.get("uid") or winner.get("twitch_user_id") or "")


def _is_placeholder(winner: dict[str, Any]) -> bool:
    if winner.get("encryptedGift"):
        return False
    link = str(winner.get("giftLink") or "")
    if not link:
        return winner.get("status") != "failed"
    return "/claim" in link and winner.get("status") != "failed"


def admin_link_backfill_candidates(data: dict[str, Any]) -> list[dict[str, Any]]:
    """Return issued orders that need encryption for the current admin browser."""
    if data.get("status") != "drawn":
        return []
    key_id = str(data.get("adminClaimKeyId") or "")
    public_key = data.get("adminClaimPublicKey")
    if not key_id or not public_key:
        return []
    return [
        winner
        for winner in data.get("winners") or []
        if winner.get("status") == "link_ready"
        and str(winner.get("orderId") or "").isdigit()
        and winner.get("adminGiftKeyId") != key_id
    ]


def fulfillment_candidates(data: dict[str, Any]) -> list[dict[str, Any]]:
    """Return winners that requested a gift or approved a legacy product choice."""
    if data.get("status") != "drawn":
        return []
    participants = data.get("participants") or {}
    candidates = []
    for winner in data.get("winners") or []:
        uid = _uid(winner)
        participant = participants.get(uid) or {}
        status = winner.get("status")
        has_approved_product = bool(winner.get("selectedProductId"))
        processable = status == "claim_requested" or (
            status == "order_approved" and has_approved_product
        )
        if (
            uid
            and uid.isdigit()
            and processable
            and participant.get("twitch") is True
            and not winner.get("encryptedGift")
            and participant.get("claimPublicKey")
        ):
            candidates.append(winner)
    return candidates


async def reset_failed_winners(store: FirestoreEventStore) -> int:
    """Retry a failed user-requested claim only on explicit operator request."""
    for _ in range(4):
        snapshot = await store.get_event()
        if not snapshot or snapshot.data.get("status") != "drawn":
            return 0
        winners = copy.deepcopy(snapshot.data.get("winners") or [])
        reset_count = 0
        for winner in winners:
            if winner.get("status") == "failed" and not winner.get("encryptedGift"):
                winner["status"] = (
                    "order_approved" if winner.get("selectedProductId") else "claim_requested"
                )
                winner.pop("error", None)
                reset_count += 1
        if not reset_count:
            return 0
        if await store.replace_winners(winners, snapshot.update_time):
            return reset_count
        await asyncio.sleep(0.15)
    raise RuntimeError("failed winner state changed repeatedly during retry reset")


async def _mutate_winner(
    store: FirestoreEventStore,
    event_id: str,
    uid: str,
    mutate: Callable[[dict[str, Any]], None],
) -> bool:
    for _ in range(4):
        snapshot = await store.get_event()
        if not snapshot or snapshot.data.get("eventId") != event_id:
            return False
        winners = copy.deepcopy(snapshot.data.get("winners") or [])
        winner = next((item for item in winners if _uid(item) == uid), None)
        if winner is None:
            return False
        mutate(winner)
        if await store.replace_winners(winners, snapshot.update_time):
            return True
        await asyncio.sleep(0.15)
    return False


async def fulfill_once(
    store: FirestoreEventStore,
    gift_provider: GiftProvider = sodagift.get_gift_link,
    whisper_provider: WhisperProvider = twitch.send_whisper,
    link_provider: LinkProvider = sodagift.get_order_link,
    dry_run: bool = False,
) -> int:
    snapshot = await store.get_event()
    if not snapshot:
        return 0
    candidates = fulfillment_candidates(snapshot.data)
    backfills = admin_link_backfill_candidates(snapshot.data)
    if dry_run:
        return len(candidates) + len(backfills)
    if not candidates and backfills:
        candidate = backfills[0]
        uid = _uid(candidate)
        event_id = str(snapshot.data.get("eventId") or "")
        key_id = str(snapshot.data.get("adminClaimKeyId") or "")
        try:
            link = await link_provider(candidate["orderId"])
            encrypted_admin = encrypt_gift_link(
                link, snapshot.data["adminClaimPublicKey"]
            )
        except Exception as exc:
            log.warning("Admin LINK backfill failed for winner %s: %s", uid, exc)
            return 0

        def mark_admin_link(winner: dict[str, Any]) -> None:
            winner["encryptedAdminGift"] = encrypted_admin
            winner["adminGiftKeyId"] = key_id

        if not await _mutate_winner(store, event_id, uid, mark_admin_link):
            return 0
        log.info("Admin SodaGift LINK ready for winner %s", uid)
        return 1
    if not candidates:
        return 0

    candidate = candidates[0]
    uid = _uid(candidate)
    event_id = str(snapshot.data.get("eventId") or "")
    participant = (snapshot.data.get("participants") or {})[uid]
    country = str(candidate.get("country") or participant.get("country") or "")

    product_id = (
        int(candidate["selectedProductId"])
        if candidate.get("selectedProductId")
        else None
    )
    public_key = participant["claimPublicKey"]

    def mark_ordering(winner: dict[str, Any]) -> None:
        winner["status"] = "ordering"
        winner.pop("error", None)

    if not await _mutate_winner(store, event_id, uid, mark_ordering):
        return 0

    ref_id = "".join(ch for ch in f"sd{event_id}{uid}" if ch.isalnum())[:100]
    try:
        result = await gift_provider(
            str(candidate.get("nickname") or participant.get("nickname") or "Winner"),
            country,
            ref_id,
            product_id,
        )
        encrypted = encrypt_gift_link(result["link"], public_key)
    except Exception as exc:
        def mark_failed(winner: dict[str, Any]) -> None:
            winner["status"] = "failed"
            winner["error"] = str(exc)[:160]

        await _mutate_winner(store, event_id, uid, mark_failed)
        raise

    admin_encrypted = None
    admin_key_id = str(snapshot.data.get("adminClaimKeyId") or "")
    if admin_key_id and snapshot.data.get("adminClaimPublicKey"):
        try:
            admin_encrypted = encrypt_gift_link(
                result["link"], snapshot.data["adminClaimPublicKey"]
            )
        except Exception as exc:
            log.warning("Admin claim key is invalid: %s", exc)

    whisper_status = "skipped"
    if participant.get("twitch"):
        try:
            await whisper_provider(
                uid,
                f"🎁 StreamDrop 선물이 도착했습니다: {result['link']}",
            )
            whisper_status = "sent"
        except Exception as exc:
            whisper_status = "failed"
            log.warning("Twitch whisper failed for winner %s: %s", uid, exc)

    def mark_ready(winner: dict[str, Any]) -> None:
        winner.update({
            "productName": result["product_name"],
            "orderId": str(result["order_id"]),
            "giftLink": "",
            "encryptedGift": encrypted,
            "status": "link_ready",
            "whisperStatus": whisper_status,
        })
        if admin_encrypted:
            winner["encryptedAdminGift"] = admin_encrypted
            winner["adminGiftKeyId"] = admin_key_id
        winner.pop("giftOptions", None)
        winner.pop("error", None)

    if not await _mutate_winner(store, event_id, uid, mark_ready):
        raise RuntimeError("event changed before encrypted claim link could be saved")
    log.info("SodaGift LINK ready for winner %s", uid)
    return 1


async def run_forever() -> None:
    if sodagift.mock_mode():
        raise RuntimeError("SODAGIFT_API_KEY is required for the fulfillment worker")
    log.info("Firestore fulfillment worker started for %s", config.FIRESTORE_EVENT_DOCUMENT)
    async with FirestoreEventStore() as store:
        while True:
            try:
                processed = await fulfill_once(store)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("Firestore winner fulfillment failed")
                processed = 0
            await asyncio.sleep(0.1 if processed else config.FIRESTORE_POLL_INTERVAL)
