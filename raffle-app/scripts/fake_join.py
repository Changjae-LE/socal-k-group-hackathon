"""가짜 참가자 N명 시뮬레이션 (DEBUG=1 필요).

사용: python scripts/fake_join.py [인원수] [서버URL]
"""
import asyncio
import random
import sys

import httpx

N = int(sys.argv[1]) if len(sys.argv) > 1 else 20
BASE = (sys.argv[2] if len(sys.argv) > 2 else "http://localhost:8000").rstrip("/")
COUNTRIES = ["KR", "US", "JP", "SG", "TW", "TH", "PH", "VN", "GB", "FR"]
NICKS = ["luna", "kai", "momo", "ray", "jin", "sky", "neo", "ari", "leo", "mia"]


async def join_one(client_id: int) -> None:
    nick = f"{random.choice(NICKS)}{client_id:02d}"
    async with httpx.AsyncClient(base_url=BASE, follow_redirects=True, timeout=10) as c:
        r = await c.get("/join/dev", params={"nick": nick})
        r.raise_for_status()
        r = await c.post("/join/enter", data={"country": random.choice(COUNTRIES)})
        r.raise_for_status()
        print(f"joined: {nick}")


async def main() -> None:
    for i in range(N):
        await join_one(i)
        await asyncio.sleep(random.uniform(0.05, 0.3))  # 오버레이 카운트 연출


asyncio.run(main())
