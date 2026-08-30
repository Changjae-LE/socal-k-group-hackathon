import unittest
from unittest.mock import AsyncMock, patch

from app import state
from app.routes import admin
from app.services import sodagift


class FulfillmentTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        state.reset()

    async def test_link_is_sent_only_to_winning_participant(self):
        participant = state.Participant(
            twitch_user_id="dev-user-1",
            nickname="winner",
            country="US",
        )
        winner = state.Winner(
            twitch_user_id=participant.twitch_user_id,
            nickname=participant.nickname,
            country=participant.country,
        )
        state.current.participants[participant.twitch_user_id] = participant
        state.current.winners = [winner]

        gift = {
            "order_id": "1234",
            "product_name": "Sandbox Gift",
            "link": "https://example.test/private-claim",
        }
        send_participant = AsyncMock()

        with (
            patch.object(
                sodagift,
                "get_gift_link",
                new=AsyncMock(return_value=gift),
            ) as get_gift_link,
            patch.object(
                admin.hub,
                "send_participant",
                new=send_participant,
            ),
            patch.object(
                admin,
                "_push_admin_state",
                new=AsyncMock(),
            ),
        ):
            await admin._fulfill_winners()

        get_gift_link.assert_awaited_once()
        send_participant.assert_awaited_once_with(
            participant.twitch_user_id,
            {
                "type": "gift",
                "product_name": gift["product_name"],
                "link": gift["link"],
            },
        )
        self.assertEqual(winner.status, "link_ready")
        self.assertEqual(winner.gift_link, gift["link"])

        # Admin/overlay data can indicate readiness but never reveal the secret.
        admin_view = winner.admin_view()
        self.assertTrue(admin_view["has_link"])
        self.assertNotIn("gift_link", admin_view)
        self.assertNotIn("link", winner.public())


if __name__ == "__main__":
    unittest.main()
