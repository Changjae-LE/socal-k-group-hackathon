"""추첨 로직: 암호학적 난수로 N명 무작위 선정."""
import secrets

from app.state import Participant, Winner

_rng = secrets.SystemRandom()


def draw_winners(participants: dict[str, Participant], count: int) -> list[Winner]:
    pool = list(participants.values())
    count = max(1, min(count, len(pool)))
    picked = _rng.sample(pool, count)
    return [
        Winner(twitch_user_id=p.twitch_user_id, nickname=p.nickname, country=p.country)
        for p in picked
    ]
