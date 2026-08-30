// `sl_claim` — short-lived encrypted HttpOnly cookie carrying ONLY the raw claim token
// across the Twitch OIDC hop when a winner opens /claim/<token> while signed out.
// The token is the winner's own bearer secret; it is never authoritative on its own —
// /claim always re-verifies the authenticated Twitch user against Winner.participant.

import "server-only";
import { cookies } from "next/headers";
import { cookieOptions, open, seal } from "@/lib/auth/cookies";
import { CLAIM_TOKEN_RE } from "@/lib/campaign/claim";

export const CLAIM_COOKIE = "sl_claim";
const TTL_SECONDS = 15 * 60;

export async function setClaimContext(rawToken: string): Promise<void> {
  if (!CLAIM_TOKEN_RE.test(rawToken)) throw new Error("malformed claim token");
  const jwe = await seal({ t: rawToken, typ: "claim_ctx" }, TTL_SECONDS);
  (await cookies()).set(CLAIM_COOKIE, jwe, cookieOptions("/", TTL_SECONDS));
}

export async function readClaimContext(): Promise<string | null> {
  const payload = await open<{ t?: unknown }>((await cookies()).get(CLAIM_COOKIE)?.value);
  const t = typeof payload?.t === "string" ? payload.t : "";
  return CLAIM_TOKEN_RE.test(t) ? t : null;
}

export async function clearClaimContext(): Promise<void> {
  (await cookies()).delete({ name: CLAIM_COOKIE, path: "/" });
}
