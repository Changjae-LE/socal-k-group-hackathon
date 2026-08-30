// Temporary, encrypted, HttpOnly cookies for the Host OAuth + test-whisper proof.
// NONE of these touch the participant cookies (sl_oidc / sl_proof / sl_campaign).
// No database — host tokens live only inside `sl_host`, decrypted server-side only.
//
//   sl_hoststate   — { state, pkceVerifier }         during the OAuth round trip
//   sl_host        — { hostUserId, hostLogin, scopes, accessToken, refreshToken, expiresAt }
//   sl_hostwhisper — last send result (NO token) for one-shot display on /dev/host
//
// Route handlers set/clear these on the NextResponse they return (proven pattern, matches
// the participant routes). Server Actions / RSC use `next/headers` for reads and for the
// whisper-result write.

import "server-only";
import { cookies } from "next/headers";
import { cookieOptions, open, seal } from "@/lib/auth/cookies";

export const HOST_STATE_COOKIE = "sl_hoststate";
export const HOST_STATE_COOKIE_PATH = "/api/auth/host";
export const HOST_STATE_TTL = 10 * 60; // 10 min

export const HOST_SESSION_COOKIE = "sl_host";
export const HOST_SESSION_COOKIE_PATH = "/";
export const HOST_SESSION_TTL = 60 * 60; // 60 min — enough for the proof; not permanent

export const HOST_WHISPER_COOKIE = "sl_hostwhisper";
export const HOST_WHISPER_COOKIE_PATH = "/dev/host";
export const HOST_WHISPER_TTL = 5 * 60;

export { cookieOptions };

// ---- OAuth round-trip state ------------------------------------------------
export type HostOAuthState = { state: string; pkceVerifier: string };

export function sealHostOAuthState(v: HostOAuthState): Promise<string> {
  return seal({ ...v, typ: "host_oauth_state" }, HOST_STATE_TTL);
}
export async function readHostOAuthState(): Promise<HostOAuthState | null> {
  const p = await open<{ state?: unknown; pkceVerifier?: unknown }>(
    (await cookies()).get(HOST_STATE_COOKIE)?.value,
  );
  return typeof p?.state === "string" && typeof p.pkceVerifier === "string"
    ? { state: p.state, pkceVerifier: p.pkceVerifier }
    : null;
}

// ---- temporary host session ----------------------------------------------------
export type HostSession = {
  hostUserId: string;
  hostLogin: string;
  scopes: string[];
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch seconds
};

export function sealHostSession(s: HostSession): Promise<string> {
  return seal({ ...s, typ: "host_session" }, HOST_SESSION_TTL);
}
export async function readHostSession(): Promise<HostSession | null> {
  const p = await open<Partial<HostSession>>(
    (await cookies()).get(HOST_SESSION_COOKIE)?.value,
  );
  if (
    !p ||
    typeof p.hostUserId !== "string" ||
    typeof p.accessToken !== "string" ||
    !Array.isArray(p.scopes)
  ) {
    return null;
  }
  return {
    hostUserId: p.hostUserId,
    hostLogin: typeof p.hostLogin === "string" ? p.hostLogin : "",
    scopes: p.scopes as string[],
    accessToken: p.accessToken,
    refreshToken: typeof p.refreshToken === "string" ? p.refreshToken : "",
    expiresAt: typeof p.expiresAt === "number" ? p.expiresAt : 0,
  };
}

// ---- last whisper result (no token) ------------------------------------------
export type WhisperOutcome = {
  at: number;
  httpStatus: number;
  accepted: boolean;
  toUserId: string;
  detail?: string;
};

/** Called from the Server Action, where next/headers cookie writes are reliable. */
export async function setWhisperOutcome(o: WhisperOutcome): Promise<void> {
  const jwe = await seal({ ...o, typ: "host_whisper_result" }, HOST_WHISPER_TTL);
  (await cookies()).set(
    HOST_WHISPER_COOKIE,
    jwe,
    cookieOptions(HOST_WHISPER_COOKIE_PATH, HOST_WHISPER_TTL),
  );
}
export async function readWhisperOutcome(): Promise<WhisperOutcome | null> {
  const p = await open<Partial<WhisperOutcome>>(
    (await cookies()).get(HOST_WHISPER_COOKIE)?.value,
  );
  return p && typeof p.httpStatus === "number" && typeof p.at === "number"
    ? {
        at: p.at,
        httpStatus: p.httpStatus,
        accepted: !!p.accepted,
        toUserId: typeof p.toUserId === "string" ? p.toUserId : "",
        detail: typeof p.detail === "string" ? p.detail : undefined,
      }
    : null;
}
