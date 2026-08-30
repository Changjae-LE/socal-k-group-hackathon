import json
import unittest
from unittest.mock import mock_open, patch

from app import config
from app.services import sodagift


class FakeResponse:
    def __init__(self, status_code: int, body: dict):
        self.status_code = status_code
        self._body = body

    def json(self) -> dict:
        return self._body


class FakeClient:
    def __init__(self, *, get_responses=None, post_responses=None):
        self.get_responses = list(get_responses or [])
        self.post_responses = list(post_responses or [])
        self.get_calls = []
        self.post_calls = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def get(self, path, params=None):
        self.get_calls.append((path, params))
        return self.get_responses.pop(0)

    async def post(self, path, json=None):
        self.post_calls.append((path, json))
        return self.post_responses.pop(0)


class SodaGiftTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        sodagift.clear_cache()

    async def test_select_product_uses_link_filter_paging_and_availability(self):
        catalog = FakeResponse(
            200,
            {
                "products": [
                    {
                        "id": 1,
                        "name": "Not linkable",
                        "availability": "ON_SALE",
                        "available_delivery_method": ["EMAIL"],
                        "amount": 1,
                    },
                    {
                        "id": 2,
                        "name": "Link Gift",
                        "availability": "ON_SALE",
                        "available_delivery_method": ["LINK"],
                        "amount": 5,
                    },
                ]
            },
        )
        available = FakeResponse(200, {"id": 2, "status": "ON_SALE"})
        client = FakeClient(get_responses=[catalog, available])

        with (
            patch.object(config, "SODAGIFT_CHECK_AVAILABILITY", True),
            patch.object(sodagift.httpx, "AsyncClient", return_value=client),
        ):
            product = await sodagift.select_product("US")

        self.assertEqual(product["id"], 2)
        self.assertEqual(
            client.get_calls[0],
            (
                "/v1/products",
                {
                    "country_code": "US",
                    "delivery_method": "LINK",
                    "page": 0,
                    "size": 100,
                },
            ),
        )
        self.assertEqual(
            client.get_calls[1],
            ("/v1/products/2/availability", None),
        )

    async def test_create_order_uses_link_and_idempotency_key(self):
        client = FakeClient(
            post_responses=[
                FakeResponse(200, {"id": 1234, "status": "COMPLETED"})
            ]
        )
        product = {"id": 77, "name": "Gift", "min_amount": 10}

        with patch.object(sodagift.httpx, "AsyncClient", return_value=client):
            order_id = await sodagift._create_order(
                product,
                "winner",
                "sdabc123",
            )

        self.assertEqual(order_id, 1234)
        path, body = client.post_calls[0]
        self.assertEqual(path, "/v1/orders")
        self.assertEqual(body["delivery"]["method"], "LINK")
        self.assertEqual(body["delivery"]["recipient"]["name"], "winner")
        self.assertEqual(body["external_reference_id"], "sdabc123")
        self.assertEqual(body["item"]["custom_amount"], 10)

    async def test_fetch_link_reads_private_delivery_link(self):
        client = FakeClient(
            get_responses=[
                FakeResponse(
                    200,
                    {
                        "id": 1234,
                        "status": "COMPLETED",
                        "order_items": [
                            {
                                "status": "PENDING",
                                "delivery": {
                                    "method": "LINK",
                                    "link": "https://example.test/private-claim",
                                },
                            }
                        ],
                    },
                )
            ]
        )

        with patch.object(sodagift.httpx, "AsyncClient", return_value=client):
            link = await sodagift._fetch_link(1234)

        self.assertEqual(link, "https://example.test/private-claim")

    def test_order_log_redacts_link_and_recipient(self):
        output = mock_open()
        with patch("builtins.open", output):
            sodagift._log_order(
                {
                    "mode": "sandbox",
                    "country": "US",
                    "order_id": 1234,
                    "product_name": "Gift",
                    "nickname": "private-user",
                    "link": "https://example.test/private-claim",
                }
            )

        payload = json.loads(output().write.call_args.args[0])
        self.assertEqual(payload["order_id"], 1234)
        self.assertNotIn("nickname", payload)
        self.assertNotIn("link", payload)


if __name__ == "__main__":
    unittest.main()
