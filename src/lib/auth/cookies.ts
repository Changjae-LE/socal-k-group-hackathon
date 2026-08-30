// Short-lived encrypted (JWE) cookies for the Twitch OIDC proof (CLAUDE.md §17).
// `sl_oidc` holds the pending {state, nonce, pkceVerifier} during the round trip.
// `sl_proof` holds only the verified {sub} so the result page can display it.
// Server-only.

import { EncryptJWT, jwtDecrypt } from "jose";
import { env } from "@/lib/env";

export const OIDC_COOKIE = "sl_oidc";
export const PROOF_COOKIE = "sl_proof";

/** Path the OIDC round-trip cookie is scoped to (only sent to the callback). */
export const OIDC_COOKIE_PATH = "/api/auth/twitch";

function key(): Uint8Array {
  // env() guarantees >= 32 bytes; A256GCM needs exactly 32.
  return Buffer.from(env().AUTH_STATE_SECRET, "base64").subarray(0, 32);
}

/** Encrypt `payload` into a compact JWE with an absolute expiry. */
export async function seal(
  payload: Record<string, unknown>,
  ttlSeconds: number,
): Promise<string> {
  return new EncryptJWT(payload)
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .encrypt(key());
}

/** Decrypt + verify a JWE cookie. Returns null on any failure (missing/expired/tampered). */
export async function open<T = Record<string, unknown>>(
  jwe: string | undefined | null,
): Promise<T | null> {
  if (!jwe) return null;
  try {
    const { payload } = await jwtDecrypt(jwe, key(), { clockTolerance: 5 });
    return payload as T;
  } catch {
    return null;
  }
}

/** Cookie attributes. `Secure` only when APP_URL is https (so it works on http://localhost). */
export function cookieOptions(path: string, maxAgeSeconds: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: env().APP_URL.startsWith("https://"),
    path,
    maxAge: maxAgeSeconds,
  };
}
