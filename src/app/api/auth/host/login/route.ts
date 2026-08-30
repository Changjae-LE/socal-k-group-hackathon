// GET /api/auth/host/login  — start Host Twitch OAuth (scope user:manage:whispers).
// Separate from participant OIDC. Dev-only.

import { notFound } from "next/navigation";
import { NextResponse } from "next/server";
import { env, twitchCredentials } from "@/lib/env";
import { pkcePair, randomUrlToken } from "@/lib/twitch/oidc";
import { buildHostAuthorizeUrl } from "@/lib/twitch/host-oauth";
import {
  HOST_STATE_COOKIE,
  HOST_STATE_COOKIE_PATH,
  HOST_STATE_TTL,
  cookieOptions,
  sealHostOAuthState,
} from "@/lib/auth/host-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function devErr(reason: string) {
  // Canonical external origin from APP_URL — never request.url (proxy/tunnel host).
  const url = new URL("/dev/host", env().APP_URL);
  url.searchParams.set("e", reason);
  return NextResponse.redirect(url);
}

export async function GET() {
  if (process.env.NODE_ENV === "production") notFound();

  const creds = twitchCredentials();
  if (!creds.configured) return devErr("not_configured");

  const state = randomUrlToken(32);
  const { verifier, challenge } = pkcePair();
  const sealed = await sealHostOAuthState({ state, pkceVerifier: verifier });

  const res = NextResponse.redirect(
    buildHostAuthorizeUrl({ clientId: creds.clientId, state, codeChallenge: challenge }),
  );
  res.cookies.set(
    HOST_STATE_COOKIE,
    sealed,
    cookieOptions(HOST_STATE_COOKIE_PATH, HOST_STATE_TTL),
  );
  return res;
}
