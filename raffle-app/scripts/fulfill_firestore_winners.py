"""Run the local Firestore -> SodaGift fulfillment bridge.

Usage from raffle-app:
  python scripts/fulfill_firestore_winners.py --dry-run
  python scripts/fulfill_firestore_winners.py
"""

import argparse
import asyncio
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services import sodagift
from app.services.firestore_fulfillment import (
    FirestoreEventStore,
    fulfill_once,
    reset_failed_winners,
    run_forever,
)


async def main() -> int:
    parser = argparse.ArgumentParser(description="Fulfill Firebase winners with encrypted SodaGift LINKs")
    parser.add_argument("--dry-run", action="store_true", help="Only count eligible winners; create no orders")
    parser.add_argument("--once", action="store_true", help="Process at most one winner, then exit")
    parser.add_argument("--retry-failed", action="store_true", help="Reset failed winners to pending before processing")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

    if args.dry_run:
        async with FirestoreEventStore() as store:
            count = await fulfill_once(store, dry_run=True)
        print(f"eligible winners: {count}")
        return 0

    if sodagift.mock_mode():
        parser.error("SODAGIFT_API_KEY is not configured")

    if args.retry_failed:
        async with FirestoreEventStore() as store:
            reset_count = await reset_failed_winners(store)
        print(f"reset failed winners: {reset_count}")

    if args.once:
        async with FirestoreEventStore() as store:
            processed = await fulfill_once(store)
        print(f"processed winners: {processed}")
        return 0

    await run_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
