// GET /api/auth/host/callback  — finish Host Twitch OAuth.
// Verify state, exchange the code server-side, VALIDATE the token with Twitch, confirm the
// token belongs to the authenticated host and that `user:manage:whispers` was granted,
// then stash the temporary host session. Dev-only. All redirects anchored to APP_URL.

import { notFound } from "next/navigation";
import { NextResponse } from "next/server";
import { env, twitchCredentials } from "@/lib/env";
import { timingSafeEqualStr } from "@/lib/twitch/oidc";
import { HOST_SCOPE, exchangeHostCode, validateHostToken } from "@/lib/twitch/host-oauth";
import {
  HOST_SESSION_COOKIE,
  HOST_SESSION_COOKIE_PATH,
  HOST_SESSION_TTL,
  HOST_STATE_COOKIE,
  HOST_STATE_COOKIE_PATH,
  cookieOptions,
  readHostOAuthState,
  sealHostSession,
} from "@/lib/auth/host-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function redirectToDevHost(query: Record<string, string>) {
  const url = new URL("/dev/host", env().APP_URL); // canonical external origin, not request.url
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = NextResponse.redirect(url);
  // Always retire the single-use state cookie on the way out.
  res.cookies.delete({ name: HOST_STATE_COOKIE, path: HOST_STATE_COOKIE_PATH });
  return res;
}

export async function GET(request: Request) {
  if (process.env.NODE_ENV === "production") notFound();

  const params = new URL(request.url).searchParams;

  if (params.get("error")) return redirectToDevHost({ e: params.get("error") ?? "twitch_error" });

  const code = params.get("code");
  const returnedState = params.get("state");
  if (!code || !returnedState) return redirectToDevHost({ e: "missing_code_or_state" });

  const pending = await readHostOAuthState();
  if (!pending) return redirectToDevHost({ e: "session_expired" });
  if (!timingSafeEqualStr(returnedState, pending.state)) {
    return redirectToDevHost({ e: "state_mismatch" });
  }

  const creds = twitchCredentials();
  if (!creds.configured) return redirectToDevHost({ e: "not_configured" });

  let tokens;
  let identity;
  try {
    tokens = await exchangeHostCode(code, pending.pkceVerifier);
    identity = await validateHostToken(tokens.accessToken);
  } catch (err) {
    console.error("host oauth exchange/validate failed:", (err as Error).message);
    return redirectToDevHost({ e: "exchange_failed" });
  }

  // The token must belong to our app, and the whisper scope must actually be present.
  if (identity.clientId !== creds.clientId) return redirectToDevHost({ e: "wrong_client" });
  if (!identity.scopes.includes(HOST_SCOPE)) return redirectToDevHost({ e: "missing_scope" });

  const expiresAt =
    Math.floor(Date.now() / 1000) + (identity.expiresIn || tokens.expiresIn || 3600);

  const sealed = await sealHostSession({
    hostUserId: identity.userId, // <-- the ONLY source of from_user_id
    hostLogin: identity.login,
    scopes: identity.scopes,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt,
  });

  const res = redirectToDevHost({ connected: "1" });
  res.cookies.set(
    HOST_SESSION_COOKIE,
    sealed,
    cookieOptions(HOST_SESSION_COOKIE_PATH, HOST_SESSION_TTL),
  );
  return res;
}
