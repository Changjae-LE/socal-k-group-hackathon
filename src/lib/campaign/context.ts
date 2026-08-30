// `sl_campaign` — the short-lived, encrypted, HttpOnly cookie that carries ONLY the
// campaign `publicId` across the Twitch OAuth redirect. It is a hint, never authoritative:
// every page re-validates the publicId against the database (campaign exists + joinable).
//
// Kept conceptually separate from `sl_proof` (which carries the verified OIDC `sub`).
// Identity  = sl_proof.sub  = twitchUserId
// Campaign  = validated Campaign.publicId  (this cookie is only a transport hint)

import "server-only";
import { cookies } from "next/headers";
import { cookieOptions, open, seal } from "@/lib/auth/cookies";
import { isWellFormedPublicId } from "@/lib/campaign/publicId";

export const CAMPAIGN_COOKIE = "sl_campaign";
const TTL_SECONDS = 15 * 60; // enough to complete Twitch auth, no more

/** Set from a Server Action on /c/[publicId] before redirecting into Twitch login. */
export async function setCampaignContext(publicId: string): Promise<void> {
  if (!isWellFormedPublicId(publicId)) throw new Error("malformed publicId");
  const jwe = await seal({ publicId, typ: "campaign_ctx" }, TTL_SECONDS);
  const store = await cookies();
  store.set(CAMPAIGN_COOKIE, jwe, cookieOptions("/", TTL_SECONDS));
}

/** Returns the publicId hint, or null. NOT authoritative — re-validate against the DB. */
export async function readCampaignContext(): Promise<string | null> {
  const store = await cookies();
  const payload = await open<{ publicId?: unknown }>(store.get(CAMPAIGN_COOKIE)?.value);
  const publicId = typeof payload?.publicId === "string" ? payload.publicId : "";
  return publicId && isWellFormedPublicId(publicId) ? publicId : null;
}

export async function clearCampaignContext(): Promise<void> {
  const store = await cookies();
  store.delete({ name: CAMPAIGN_COOKIE, path: "/" });
}
