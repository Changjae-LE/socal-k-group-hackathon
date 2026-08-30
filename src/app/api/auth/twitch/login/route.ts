// GET /api/auth/twitch/login
// Start the participant OIDC flow: generate state + nonce (+ PKCE), stash them in a
// short-lived encrypted cookie, and 302 to Twitch. If Twitch credentials are not
// configured, redirect to /auth/error instead of starting a broken login.

import { NextResponse } from "next/server";
import { env, twitchCredentials } from "@/lib/env";
import { OIDC_COOKIE, OIDC_COOKIE_PATH, cookieOptions, seal } from "@/lib/auth/cookies";
import { buildAuthorizeUrl, pkcePair, randomUrlToken } from "@/lib/twitch/oidc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATE_TTL_SECONDS = 600; // 10 minutes to complete the round trip

export async function GET(request: Request) {
  const creds = twitchCredentials();
  if (!creds.configured) {
    // Canonical external origin from APP_URL (not request.url — see callback route).
    const url = new URL("/auth/error", env().APP_URL);
    url.searchParams.set("reason", "not_configured");
    url.searchParams.set("missing", creds.missing.join(","));
    return NextResponse.redirect(url);
  }

  const state = randomUrlToken(32);
  const nonce = randomUrlToken(32);
  const { verifier, challenge } = pkcePair();

  const sealed = await seal(
    { state, nonce, pkceVerifier: verifier, flow: "PARTICIPANT_OIDC_PROOF" },
    STATE_TTL_SECONDS,
  );

  const res = NextResponse.redirect(
    buildAuthorizeUrl({
      clientId: creds.clientId,
      state,
      nonce,
      codeChallenge: challenge,
    }),
  );
  res.cookies.set(OIDC_COOKIE, sealed, cookieOptions(OIDC_COOKIE_PATH, STATE_TTL_SECONDS));
  return res;
}
