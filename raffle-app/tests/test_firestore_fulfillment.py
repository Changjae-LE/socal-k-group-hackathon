import base64
import copy
import json
import unittest

import httpx
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.services.firestore_fulfillment import (
    EventSnapshot,
    FirestoreEventStore,
    _decode_value,
    _encode_value,
    fulfill_once,
)


def b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def unb64url(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def public_jwk(private_key: rsa.RSAPrivateKey) -> dict[str, str]:
    numbers = private_key.public_key().public_numbers()
    return {
        "kty": "RSA",
        "alg": "RSA-OAEP-256",
        "ext": True,
        "key_ops": ["encrypt"],
        "n": b64url(numbers.n.to_bytes((numbers.n.bit_length() + 7) // 8, "big")),
        "e": b64url(numbers.e.to_bytes((numbers.e.bit_length() + 7) // 8, "big")),
    }


def decrypt_claim(private_key: rsa.RSAPrivateKey, encrypted: dict[str, str]) -> str:
    aes_key = private_key.decrypt(
        unb64url(encrypted["wrappedKey"]),
        padding.OAEP(
            mgf=padding.MGF1(algorithm=hashes.SHA256()),
            algorithm=hashes.SHA256(),
            label=None,
        ),
    )
    clear = AESGCM(aes_key).decrypt(
        unb64url(encrypted["iv"]),
        unb64url(encrypted["ciphertext"]),
        None,
    )
    return clear.decode("utf-8")


class FakeStore:
    def __init__(self, data: dict) -> None:
        self.data = copy.deepcopy(data)
        self.version = 1

    async def get_event(self) -> EventSnapshot:
        return EventSnapshot(copy.deepcopy(self.data), f"v{self.version}")

    async def replace_winners(self, winners: list[dict], expected_update_time: str) -> bool:
        if expected_update_time != f"v{self.version}":
            return False
        self.data["winners"] = copy.deepcopy(winners)
        self.version += 1
        return True


class FulfillmentTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_link_is_encrypted_for_winner_device(self) -> None:
        private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        store = FakeStore({
            "status": "drawn",
            "eventId": "event01",
            "participants": {
                "123": {
                    "nickname": "winner",
                    "country": "KR",
                    "claimPublicKey": public_jwk(private_key),
                }
            },
            "winners": [{
                "uid": "123",
                "nickname": "winner",
                "country": "KR",
                "giftLink": "",
                "status": "pending",
            }],
        })
        real_link = "https://sandbox.example/claim/secret-token"

        async def gift_provider(_name: str, _country: str, ref_id: str) -> dict[str, str]:
            self.assertEqual(ref_id, "sdevent01123")
            return {
                "order_id": "987",
                "product_name": "Test Gift",
                "link": real_link,
            }

        processed = await fulfill_once(store, gift_provider=gift_provider)

        self.assertEqual(processed, 1)
        winner = store.data["winners"][0]
        self.assertEqual(winner["status"], "link_ready")
        self.assertEqual(winner["giftLink"], "")
        self.assertEqual(winner["productName"], "Test Gift")
        self.assertNotIn(real_link, str(winner))
        self.assertEqual(decrypt_claim(private_key, winner["encryptedGift"]), real_link)

    async def test_dry_run_never_calls_gift_provider(self) -> None:
        private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        store = FakeStore({
            "status": "drawn",
            "eventId": "event02",
            "participants": {"1": {"claimPublicKey": public_jwk(private_key)}},
            "winners": [{"uid": "1", "giftLink": "", "status": "pending"}],
        })

        async def forbidden_provider(*_args: str) -> dict[str, str]:
            self.fail("dry run must not call SodaGift")

        self.assertEqual(await fulfill_once(store, forbidden_provider, dry_run=True), 1)
        self.assertEqual(store.data["winners"][0]["status"], "pending")

    async def test_firestore_patch_updates_only_winners_with_precondition(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            self.assertEqual(request.method, "PATCH")
            self.assertEqual(request.url.params.get_list("updateMask.fieldPaths"), ["winners", "updatedAt"])
            self.assertEqual(request.url.params["currentDocument.updateTime"], "2026-01-01T00:00:00Z")
            body = json.loads(request.content)
            decoded = {
                key: _decode_value(value)
                for key, value in body["fields"].items()
            }
            self.assertEqual(decoded["winners"][0]["uid"], "7")
            return httpx.Response(200, json={})

        client = httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
            base_url="https://firestore.googleapis.com",
        )
        store = FirestoreEventStore(client)
        self.assertTrue(await store.replace_winners(
            [{"uid": "7", "status": "ordering"}],
            "2026-01-01T00:00:00Z",
        ))
        await client.aclose()

    def test_firestore_value_round_trip(self) -> None:
        value = {"items": [{"ok": True, "count": 2}], "empty": [], "none": None}
        self.assertEqual(_decode_value(_encode_value(value)), value)


if __name__ == "__main__":
    unittest.main()
