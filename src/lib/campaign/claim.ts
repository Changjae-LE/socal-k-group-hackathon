// Claim-token hashing + lookup + constant-time identity check (CLAUDE.md §9).
// The raw token lives only in the /claim/<token> URL (delivered by Whisper) and, briefly,
// in the encrypted `sl_claim` cookie across the OIDC hop. Only its SHA-256 hash is stored.

import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db/prisma";

// base64url of 32 bytes = 43 chars; allow a little slack.
export const CLAIM_TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;

export function hashClaimToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Constant-time string equality (identity checks). */
export function sameTwitchUser(a: string, b: string): boolean {
  const ba = Buffer.from(String(a ?? ""), "utf8");
  const bb = Buffer.from(String(b ?? ""), "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Full claim bundle for /claim/<token>: token + winner + participant + campaign + reward. */
export async function loadClaim(rawToken: string) {
  if (!CLAIM_TOKEN_RE.test(rawToken)) return null;
  return prisma.claimToken.findUnique({
    where: { tokenHash: hashClaimToken(rawToken) },
    include: {
      winner: {
        include: {
          participant: { select: { twitchUserId: true, countryCode: true } },
          campaign: true,
          reward: true,
        },
      },
    },
  });
}

export type ClaimBundle = NonNullable<Awaited<ReturnType<typeof loadClaim>>>;
