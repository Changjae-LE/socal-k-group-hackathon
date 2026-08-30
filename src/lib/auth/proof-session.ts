// Helpers around the short-lived, encrypted, HttpOnly `sl_proof` cookie that carries
// ONLY the verified Twitch OIDC `sub` through the post-login proof flow.
// Does NOT change how `sl_proof` is minted by the OIDC callback.

import "server-only";
import { cookies } from "next/headers";
import { PROOF_COOKIE, cookieOptions, open, seal } from "@/lib/auth/cookies";

export type ProofSession = { sub: string };

/** Read + decrypt `sl_proof`. Returns null if missing / expired / tampered. */
export async function readProof(): Promise<ProofSession | null> {
  const store = await cookies();
  const payload = await open<{ sub?: unknown }>(store.get(PROOF_COOKIE)?.value);
  const sub = typeof payload?.sub === "string" ? payload.sub : "";
  return sub ? { sub } : null;
}

/**
 * Re-issue `sl_proof` with a fresh TTL, preserving the same verified `sub`.
 * MUST be called from a Server Action or Route Handler (it writes a cookie).
 * Returns the session, or null if there was no valid proof to refresh.
 */
export async function refreshProof(ttlSeconds: number): Promise<ProofSession | null> {
  const current = await readProof();
  if (!current) return null;
  const jwe = await seal({ sub: current.sub, typ: "participant_proof" }, ttlSeconds);
  const store = await cookies();
  store.set(PROOF_COOKIE, jwe, cookieOptions("/", ttlSeconds));
  return current;
}
