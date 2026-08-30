// Twitch OpenID Connect Authorization Code + PKCE — proof helpers (CLAUDE.md §17).
// Server-only. Does not store Twitch access/refresh tokens (participant needs no API access).

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { env, twitchCredentials } from "@/lib/env";

/** URL-safe random token (base64url). 32 bytes -> 43 chars. */
export function randomUrlToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** PKCE S256 pair. Verifier is 43 chars (RFC 7636 allows 43-128). */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Constant-time string comparison (for state and nonce). */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Build the Twitch /authorize URL for a minimal-identity (`openid`) participant login. */
export function buildAuthorizeUrl(params: {
  clientId: string;
  state: string;
  nonce: string;
  codeChallenge: string;
}): string {
  const e = env();
  const u = new URL(e.TWITCH_AUTHORIZE_URL);
  u.searchParams.set("client_id", params.clientId);
  u.searchParams.set("redirect_uri", e.TWITCH_REDIRECT_URI);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid"); // minimum identity only
  u.searchParams.set("state", params.state);
  u.searchParams.set("nonce", params.nonce);
  u.searchParams.set("code_challenge", params.codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("force_verify", "true");
  return u.toString();
}

type TwitchTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
  token_type?: string;
  scope?: string[] | string;
};

/**
 * Exchange the authorization code SERVER-SIDE. TWITCH_CLIENT_SECRET is used only here.
 * Returns just the id_token; access/refresh tokens are intentionally discarded.
 */
export async function exchangeCode(
  code: string,
  codeVerifier: string,
): Promise<{ idToken: string }> {
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
    redirect_uri: e.TWITCH_REDIRECT_URI,
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
      `Twitch token exchange failed (HTTP ${res.status})${
        detail ? `: ${detail.slice(0, 300)}` : ""
      }`,
    );
  }

  const json = (await res.json()) as TwitchTokenResponse;
  if (!json.id_token) throw new Error("Twitch token response contained no id_token");
  return { idToken: json.id_token };
}

let jwks: JWTVerifyGetKey | null = null;
function getJwks(): JWTVerifyGetKey {
  if (!jwks) jwks = createRemoteJWKSet(new URL(env().TWITCH_JWKS_URI));
  return jwks;
}

/**
 * Validate the Twitch ID token: RS256 signature (JWKS), issuer, audience,
 * expiration/nbf/iat, and the OIDC nonce. Returns the verified `sub`.
 */
export async function verifyIdToken(
  idToken: string,
  expectedNonce: string,
): Promise<{ sub: string }> {
  const creds = twitchCredentials();
  if (!creds.configured) {
    throw new Error(`Twitch credentials not configured: ${creds.missing.join(", ")}`);
  }
  const e = env();

  const { payload } = await jwtVerify(idToken, getJwks(), {
    issuer: e.TWITCH_OIDC_ISSUER,
    audience: creds.clientId,
    algorithms: ["RS256"], // reject alg:none and anything else
    clockTolerance: 5,
  });

  const nonce = typeof payload.nonce === "string" ? payload.nonce : "";
  if (!nonce || !timingSafeEqualStr(nonce, expectedNonce)) {
    throw new Error("OIDC nonce mismatch");
  }

  const sub = typeof payload.sub === "string" ? payload.sub : "";
  if (!sub) throw new Error("ID token contained no sub");

  // Never trust display name / preferred_username as an identifier — only `sub`.
  return { sub };
}
