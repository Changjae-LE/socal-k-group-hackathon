// GET /api/auth/twitch/callback?code&state  (or ?error=...)
// Validate state, exchange the code server-side, verify the ID token (signature, iss,
// aud, exp, nonce), then stash only the verified `sub` in a short-lived proof cookie
// and redirect to /auth/result. Any failure fails closed to /auth/error.

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { env } from "@/lib/env";
import {
  OIDC_COOKIE,
  OIDC_COOKIE_PATH,
  PROOF_COOKIE,
  cookieOptions,
  open,
  seal,
} from "@/lib/auth/cookies";
import { exchangeCode, timingSafeEqualStr, verifyIdToken } from "@/lib/twitch/oidc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROOF_TTL_SECONDS = 300; // just long enough to view the result page

type PendingAuth = {
  state: string;
  nonce: string;
  pkceVerifier: string;
};

function fail(request: Request, reason: string) {
  // Anchor to the canonical external origin (APP_URL), not request.url — behind a
  // reverse proxy / tunnel the Host header (hence request.url) is the internal
  // localhost origin, which would send the browser to a dead address.
  const url = new URL("/auth/error", env().APP_URL);
  url.searchParams.set("reason", reason);
  const res = NextResponse.redirect(url);
  res.cookies.delete({ name: OIDC_COOKIE, path: OIDC_COOKIE_PATH });
  return res;
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;

  // 1. Twitch-side error (e.g. the user declined).
  const twitchError = params.get("error");
  if (twitchError) return fail(request, twitchError);

  const code = params.get("code");
  const returnedState = params.get("state");
  if (!code || !returnedState) return fail(request, "missing_code_or_state");

  // 2. Load + decrypt the pending-auth cookie.
  const store = await cookies();
  const pending = await open<PendingAuth>(store.get(OIDC_COOKIE)?.value);
  if (!pending?.state || !pending.nonce || !pending.pkceVerifier) {
    return fail(request, "session_expired");
  }

  // 3. Validate OAuth state (constant-time). Cookie is single-use from here on.
  if (!timingSafeEqualStr(returnedState, pending.state)) {
    return fail(request, "state_mismatch");
  }

  // 4. Exchange the code server-side and validate the ID token.
  let sub: string;
  try {
    const { idToken } = await exchangeCode(code, pending.pkceVerifier);
    ({ sub } = await verifyIdToken(idToken, pending.nonce));
  } catch (err) {
    console.error("twitch callback verification failed:", (err as Error).message);
    return fail(request, "verification_failed");
  }

  // 5. Success — hand only the verified sub to the result page.
  // Redirect to the canonical external origin (APP_URL), not request.url — behind a
  // reverse proxy / tunnel the Host header (and thus request.url) is the internal
  // localhost origin, which would send the browser to a dead address.
  const proof = await seal({ sub, typ: "participant_proof" }, PROOF_TTL_SECONDS);
  const res = NextResponse.redirect(new URL("/auth/result", env().APP_URL));
  res.cookies.delete({ name: OIDC_COOKIE, path: OIDC_COOKIE_PATH });
  res.cookies.set(PROOF_COOKIE, proof, cookieOptions("/", PROOF_TTL_SECONDS));
  return res;
}
