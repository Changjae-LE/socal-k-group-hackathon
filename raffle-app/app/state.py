"""인메모리 이벤트 상태. 단일 이벤트, 리셋 시 새 EventState로 교체."""
import asyncio
import secrets
import time
from dataclasses import dataclass, field


@dataclass
class Participant:
    twitch_user_id: str
    nickname: str
    country: str = ""
    joined_at: float = field(default_factory=time.time)
    # 낙첨자 AI 추천: none -> sent | failed
    recs: list[dict] | None = None
    recs_status: str = "none"

    def public(self) -> dict:
        return {"nickname": self.nickname, "country": self.country}


@dataclass
class Winner:
    twitch_user_id: str
    nickname: str
    country: str
    order_id: str | None = None
    product_name: str | None = None
    gift_link: str | None = None
    # pending -> ordering -> link_ready | failed
    status: str = "pending"
    # skipped | sending | sent | failed
    whisper_status: str = "skipped"
    error: str | None = None

    def admin_view(self) -> dict:
        return {
            "twitch_user_id": self.twitch_user_id,
            "nickname": self.nickname,
            "country": self.country,
            "order_id": self.order_id,
            "product_name": self.product_name,
            "status": self.status,
            "whisper_status": self.whisper_status,
            "error": self.error,
            "has_link": bool(self.gift_link),
        }

    def public(self) -> dict:
        return {"nickname": self.nickname, "country": self.country}


class EventState:
    def __init__(self) -> None:
        self.event_id: str = secrets.token_hex(4)
        self.status: str = "idle"  # idle | open | drawn
        self.participants: dict[str, Participant] = {}
        self.winners: list[Winner] = []

    def summary(self) -> dict:
        return {
            "type": "state",
            "event_id": self.event_id,
            "status": self.status,
            "count": len(self.participants),
        }


current = EventState()
lock = asyncio.Lock()


def reset() -> EventState:
    global current
    current = EventState()
    return current
