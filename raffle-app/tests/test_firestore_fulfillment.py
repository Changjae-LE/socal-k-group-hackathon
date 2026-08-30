import base64
import copy
import json
import unittest
from unittest.mock import mock_open, patch

import httpx
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.services import sodagift
from app.services.firestore_fulfillment import (
    EventSnapshot,
    FirestoreEventStore,
    _decode_value,
    _encode_value,
    fulfill_once,
    reset_failed_winners,
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
                    "twitch": True,
                    "claimPublicKey": public_jwk(private_key),
                }
            },
            "winners": [{
                "uid": "123",
                "nickname": "winner",
                "country": "KR",
                "giftLink": "",
                "status": "order_approved",
                "selectedProductId": 42,
            }],
        })
        real_link = "https://sandbox.example/claim/secret-token"

        async def gift_provider(
            _name: str,
            _country: str,
            ref_id: str,
            product_id: int,
        ) -> dict[str, str]:
            self.assertEqual(ref_id, "sdevent01123")
            self.assertEqual(product_id, 42)
            return {
                "order_id": "987",
                "product_name": "Test Gift",
                "link": real_link,
            }

        async def failed_whisper(_user_id: str, _message: str) -> None:
            raise RuntimeError("recipient blocks whispers")

        processed = await fulfill_once(
            store,
            gift_provider=gift_provider,
            whisper_provider=failed_whisper,
        )

        self.assertEqual(processed, 1)
        winner = store.data["winners"][0]
        self.assertEqual(winner["status"], "link_ready")
        self.assertEqual(winner["giftLink"], "")
        self.assertEqual(winner["productName"], "Test Gift")
        self.assertEqual(winner["whisperStatus"], "failed")
        self.assertNotIn(real_link, str(winner))
        self.assertEqual(decrypt_claim(private_key, winner["encryptedGift"]), real_link)

    async def test_twitch_winner_receives_claim_link_by_whisper(self) -> None:
        private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        store = FakeStore({
            "status": "drawn",
            "eventId": "event-twitch",
            "participants": {
                "777": {
                    "nickname": "twitch-winner",
                    "country": "CA",
                    "twitch": True,
                    "claimPublicKey": public_jwk(private_key),
                }
            },
            "winners": [{
                "uid": "777",
                "nickname": "twitch-winner",
                "country": "CA",
                "status": "order_approved",
                "selectedProductId": 60048,
            }],
        })
        real_link = "https://sandbox.example/claim/twitch-secret"
        sent = []

        async def gift_provider(
            _name: str,
            _country: str,
            _ref_id: str,
            product_id: int,
        ) -> dict[str, str]:
            self.assertEqual(product_id, 60048)
            return {
                "order_id": "888",
                "product_name": "Twitch Gift",
                "link": real_link,
            }

        async def whisper_provider(user_id: str, message: str) -> None:
            sent.append((user_id, message))

        await fulfill_once(
            store,
            gift_provider=gift_provider,
            whisper_provider=whisper_provider,
        )

        winner = store.data["winners"][0]
        self.assertEqual(winner["whisperStatus"], "sent")
        self.assertEqual(sent[0][0], "777")
        self.assertIn(real_link, sent[0][1])
        self.assertNotIn(real_link, str(winner))

    async def test_claim_requested_winner_creates_link_and_sends_whisper(self) -> None:
        private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        store = FakeStore({
            "status": "drawn",
            "eventId": "event-claim",
            "participants": {
                "55": {
                    "nickname": "claim-winner",
                    "country": "CA",
                    "twitch": True,
                    "claimPublicKey": public_jwk(private_key),
                }
            },
            "winners": [{
                "uid": "55",
                "nickname": "claim-winner",
                "country": "CA",
                "status": "claim_requested",
            }],
        })
        real_link = "https://biz-sandbox.sodagift.com/claim/real-link"
        sent = []

        async def gift_provider(
            _name: str,
            country: str,
            _ref_id: str,
            product_id: int | None,
        ) -> dict[str, str]:
            self.assertEqual(country, "CA")
            self.assertIsNone(product_id)
            return {
                "order_id": "33854",
                "product_name": "Demo Gift",
                "link": real_link,
            }

        async def whisper_provider(user_id: str, message: str) -> None:
            sent.append((user_id, message))

        processed = await fulfill_once(
            store,
            gift_provider=gift_provider,
            whisper_provider=whisper_provider,
        )

        self.assertEqual(processed, 1)
        winner = store.data["winners"][0]
        self.assertEqual(winner["status"], "link_ready")
        self.assertEqual(winner["whisperStatus"], "sent")
        self.assertEqual(sent[0][0], "55")
        self.assertIn(real_link, sent[0][1])
        self.assertEqual(decrypt_claim(private_key, winner["encryptedGift"]), real_link)

    async def test_pending_winner_waits_for_claim_button(self) -> None:
        private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        store = FakeStore({
            "status": "drawn",
            "eventId": "event-pending",
            "participants": {
                "9": {
                    "country": "US",
                    "twitch": True,
                    "claimPublicKey": public_jwk(private_key),
                }
            },
            "winners": [{"uid": "9", "country": "US", "status": "pending"}],
        })

        async def forbidden_provider(*_args) -> dict[str, str]:
            self.fail("pending winner must wait for the claim button")

        self.assertEqual(
            await fulfill_once(store, gift_provider=forbidden_provider),
            0,
        )
        self.assertEqual(store.data["winners"][0]["status"], "pending")

    async def test_dry_run_never_calls_gift_provider(self) -> None:
        private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        store = FakeStore({
            "status": "drawn",
            "eventId": "event02",
            "participants": {
                "1": {
                    "twitch": True,
                    "claimPublicKey": public_jwk(private_key),
                }
            },
            "winners": [{"uid": "1", "giftLink": "", "status": "claim_requested"}],
        })

        async def forbidden_provider(*_args: str) -> dict[str, str]:
            self.fail("dry run must not call SodaGift")

        self.assertEqual(await fulfill_once(store, forbidden_provider, dry_run=True), 1)
        self.assertEqual(store.data["winners"][0]["status"], "claim_requested")

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

    async def test_order_includes_custom_amount_for_ranged_product(self) -> None:
        class Response:
            def __init__(self, status_code: int, text: str, payload: dict | None = None) -> None:
                self.status_code = status_code
                self.text = text
                self._payload = payload or {}

            def json(self) -> dict:
                return self._payload

        class Client:
            def __init__(self) -> None:
                self.items = []

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_exc):
                return None

            async def post(self, _path: str, json: dict):
                self.items.append(copy.deepcopy(json["item"]))
                return Response(200, "", {"id": 321})

        client = Client()
        with patch("app.services.sodagift.httpx.AsyncClient", return_value=client):
            order_id = await sodagift._create_order(
                {
                    "id": 50008,
                    "amount": 1.0,
                    "min_amount": 1.0,
                    "max_amount": 999.0,
                },
                "winner",
                "ref123",
            )

        self.assertEqual(order_id, 321)
        self.assertEqual(client.items, [{"id": 50008, "custom_amount": 1.0}])

    async def test_failed_winner_requires_explicit_reset(self) -> None:
        store = FakeStore({
            "status": "drawn",
            "eventId": "event03",
            "participants": {},
            "winners": [{"uid": "1", "status": "failed", "error": "temporary"}],
        })

        self.assertEqual(await reset_failed_winners(store), 1)
        self.assertEqual(store.data["winners"][0]["status"], "claim_requested")
        self.assertNotIn("error", store.data["winners"][0])

    def test_brand_product_ranks_before_generic_prepaid_card(self) -> None:
        prepaid = sodagift._product_rank(
            {"name": "Virtual Prepaid Mastercard", "min_amount": 1, "max_amount": 999},
            1.0,
        )
        brand = sodagift._product_rank(
            {"name": "Tim Horton's E-Gift", "min_amount": 5, "max_amount": 100},
            5.0,
        )

        self.assertLess(brand, prepaid)

    def test_fixed_product_ranks_before_custom_amount_product(self) -> None:
        fixed = sodagift._product_rank(
            {"name": "Red Lobster Gift Card", "min_amount": None, "max_amount": None},
            10.0,
        )
        ranged = sodagift._product_rank(
            {"name": "Tim Horton's E-Gift", "min_amount": 5, "max_amount": 100},
            5.0,
        )

        self.assertLess(fixed, ranged)

    def test_order_log_never_persists_plain_claim_link(self) -> None:
        writer = mock_open()
        with patch("builtins.open", writer):
            sodagift._log_order({
                "order_id": "123",
                "link": "https://gift.example/private-claim-token",
            })

        payload = json.loads(writer().write.call_args.args[0])
        self.assertNotIn("link", payload)
        self.assertNotIn("private-claim-token", str(payload))
        self.assertTrue(payload["link_issued"])

    def test_firestore_value_round_trip(self) -> None:
        value = {"items": [{"ok": True, "count": 2}], "empty": [], "none": None}
        self.assertEqual(_decode_value(_encode_value(value)), value)


if __name__ == "__main__":
    unittest.main()
