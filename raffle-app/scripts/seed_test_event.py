"""AI 추천 로컬 테스트용 이벤트 시드.

팀 라이브 문서(events/live)는 건드리지 않고 별도 문서에 '추첨 완료' 상태의
가짜 이벤트(당첨자 1 + 취향 프로필 있는 낙첨자 2)를 만든다.

사용 (raffle-app에서):
  python scripts/seed_test_event.py            # events/test-recs에 시드
  python scripts/seed_test_event.py --delete   # 테스트 문서 삭제
  python scripts/seed_test_event.py --doc events/my-test
"""
import argparse
import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx

from app import config
from app.services.firestore_fulfillment import _encode_value

SEED = {
    "status": "drawn",
    "eventId": "testrecs1",
    "updatedAt": int(time.time() * 1000),
    "winners": [{"uid": "111", "nickname": "winner1", "country": "US",
                 "status": "link_ready", "orderId": "1"}],
    "participants": {
        "111": {"nickname": "winner1", "country": "US", "twitch": True, "joinedAt": 1},
        "222": {"nickname": "game_fan", "country": "KR", "twitch": True, "joinedAt": 2,
                "tasteProfile": [{"name": "faker", "category": "League of Legends"},
                                 {"name": "lck_official", "category": "League of Legends"}]},
        "333": {"nickname": "food_fan", "country": "US", "twitch": True, "joinedAt": 3,
                "tasteProfile": [{"name": "mukbang_tv", "category": "Food & Drink"},
                                 {"name": "cookingqueen", "category": "Just Chatting"}]},
    },
}


async def main() -> int:
    parser = argparse.ArgumentParser(description="Seed a drawn test event for AI-recs local testing")
    parser.add_argument("--doc", default="events/test-recs", help="Firestore document path (default: events/test-recs)")
    parser.add_argument("--delete", action="store_true", help="Delete the test document instead of seeding")
    args = parser.parse_args()

    if args.doc == "events/live":
        parser.error("events/live는 팀 라이브 문서입니다 — 테스트용 문서를 쓰세요")

    base = (f"https://firestore.googleapis.com/v1/projects/{config.FIREBASE_PROJECT_ID}"
            f"/databases/(default)/documents")
    async with httpx.AsyncClient(timeout=15) as client:
        if args.delete:
            r = await client.delete(f"{base}/{args.doc}", params={"key": config.FIREBASE_WEB_API_KEY})
            print(f"deleted {args.doc}: {r.status_code}")
            return 0
        body = {"fields": {k: _encode_value(v) for k, v in SEED.items()}}
        r = await client.patch(f"{base}/{args.doc}", params={"key": config.FIREBASE_WEB_API_KEY}, json=body)
        r.raise_for_status()

    print(f"seeded {args.doc} (drawn, 당첨자 1명 + 낙첨자 2명: game_fan/KR, food_fan/US)")
    print(f"\n다음 단계:")
    print(f"  1) 워커: FIRESTORE_EVENT_DOCUMENT={args.doc} python scripts/fulfill_firestore_winners.py")
    print(f"  2) UI:   python3 -m http.server 8090 --directory hosting")
    print(f"     브라우저: http://localhost:8090/join.html?local=1&edoc={args.doc}")
    print(f"     콘솔에서 낙첨자 세션 주입:")
    print("     localStorage.setItem('sd_session', JSON.stringify({uid:'222',nick:'game_fan',country:'KR',eventId:'testrecs1',twitch:true})); location.reload();")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
