// Host Twitch OAuth (Authorization Code + PKCE) — scope `user:manage:whispers`.
// Completely separate from participant OIDC (src/lib/twitch/oidc.ts): different scope,
// different redirect URI, different tokens. Server-only. Never returns TWITCH_CLIENT_SECRET
// or the host tokens to a caller that would forward them to the browser.

import "server-only";
import { env, twitchCredentials } from "@/lib/env";

export const HOST_SCOPE = "user:manage:whispers";

/** The exact, fixed message for the one-shot test whisper. Do not parameterize. */
export const TEST_WHISPER_MESSAGE =
  "SodaGift Live test whisper. No reward has been issued.";

/** Build the Twitch /authorize URL for the HOST (whisper) authorization. */
export function buildHostAuthorizeUrl(params: {
  clientId: string;
  state: string;
  codeChallenge: string;
}): string {
  const e = env();
  const u = new URL(e.TWITCH_AUTHORIZE_URL);
  u.searchParams.set("client_id", params.clientId);
  u.searchParams.set("redirect_uri", e.TWITCH_HOST_REDIRECT_URI);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", HOST_SCOPE); // exactly user:manage:whispers
  u.searchParams.set("state", params.state);
  u.searchParams.set("code_challenge", params.codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("force_verify", "true");
  return u.toString();
}

type HostTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string[] | string;
  token_type?: string;
};

export type HostTokens = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scopes: string[];
};

/** Exchange the authorization code SERVER-SIDE. client_secret is used only here. */
export async function exchangeHostCode(
  code: string,
  codeVerifier: string,
): Promise<HostTokens> {
  const creds = twitchCredentials();
  if (!creds.configured) {
    throw new Error(`Twitch credentials not configured: ${creds.missing.join(", ")}`);
  }
  const e = env();
  const body = new URLSearchParams({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: e.TWITCH_HOST_REDIRECT_URI,
    code_verifier: codeVerifier,
  });

  const res = await fetch(e.TWITCH_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Host token exchange failed (HTTP ${res.status})${detail ? `: ${detail.slice(0, 300)}` : ""}`,
    );
  }
  const json = (await res.json()) as HostTokenResponse;
  if (!json.access_token) throw new Error("Host token response contained no access_token");

  const scopes = Array.isArray(json.scope)
    ? json.scope
    : typeof json.scope === "string"
      ? json.scope.split(" ").filter(Boolean)
      : [];

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? "",
    expiresIn: typeof json.expires_in === "number" ? json.expires_in : 0,
    scopes,
  };
}

export type HostIdentity = {
  userId: string;
  login: string;
  clientId: string;
  scopes: string[];
  expiresIn: number;
};

/**
 * Validate the host access token against Twitch and read its identity + scopes.
 * Uses the `OAuth` auth scheme (required by /oauth2/validate, not `Bearer`).
 */
export async function validateHostToken(accessToken: string): Promise<HostIdentity> {
  const e = env();
  const res = await fetch(e.TWITCH_VALIDATE_URL, {
    headers: { Authorization: `OAuth ${accessToken}` },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Twitch token validation failed (HTTP ${res.status})`);
  }
  const j = (await res.json()) as {
    client_id?: string;
    login?: string;
    user_id?: string;
    scopes?: string[];
    expires_in?: number;
  };
  if (!j.user_id || !j.client_id) {
    throw new Error("Twitch validate response missing user_id / client_id");
  }
  return {
    userId: j.user_id,
    login: j.login ?? "",
    clientId: j.client_id,
    scopes: Array.isArray(j.scopes) ? j.scopes : [],
    expiresIn: typeof j.expires_in === "number" ? j.expires_in : 0,
  };
}

export type WhisperResult = {
  httpStatus: number;
  accepted: boolean; // true only on HTTP 204 (Twitch accepted the request)
  twitchError?: { error?: string; status?: number; message?: string };
};

/**
 * POST https://api.twitch.tv/helix/whispers  (from_user_id / to_user_id are query params).
 * `fromUserId` MUST be the validated host token identity; `toUserId` is the manual test id.
 * Returns the HTTP status only — a 204 means Twitch ACCEPTED the request, NOT that the
 * recipient received the whisper (Twitch may silently drop whispers).
 */
export async function sendWhisper(args: {
  accessToken: string;
  clientId: string;
  fromUserId: string;
  toUserId: string;
  message: string;
}): Promise<WhisperResult> {
  const e = env();
  const url =
    `${e.TWITCH_HELIX_BASE}/whispers` +
    `?from_user_id=${encodeURIComponent(args.fromUserId)}` +
    `&to_user_id=${encodeURIComponent(args.toUserId)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      "Client-Id": args.clientId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message: args.message }),
    cache: "no-store",
  });

  if (res.status === 204) return { httpStatus: 204, accepted: true };

  let twitchError: WhisperResult["twitchError"];
  try {
    twitchError = (await res.json()) as WhisperResult["twitchError"];
  } catch {
    twitchError = { message: (await res.text().catch(() => "")).slice(0, 300) };
  }
  return { httpStatus: res.status, accepted: false, twitchError };
}
