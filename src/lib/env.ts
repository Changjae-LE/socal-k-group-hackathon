// Server-only environment access for the Twitch OIDC proof (CLAUDE.md §17).
// Never import this from a Client Component. Next.js loads `.env.local` into
// `process.env` for the Node runtime automatically.

import { z } from "zod";

/** A base64 string that decodes to at least 32 bytes (A256GCM key material). */
const base64Min32 = z
  .string()
  .min(1, "required")
  .refine((v) => {
    try {
      return Buffer.from(v, "base64").length >= 32;
    } catch {
      return false;
    }
  }, "must be base64 of at least 32 bytes");

const CoreEnv = z.object({
  APP_URL: z.string().url().default("http://localhost:3000"),
  AUTH_STATE_SECRET: base64Min32,
  // AES-256-GCM key for secrets at rest (SodaGift voucher URL). Separate from AUTH_STATE_SECRET.
  TOKEN_ENCRYPTION_KEY: base64Min32,
  TWITCH_REDIRECT_URI: z
    .string()
    .url()
    .default("http://localhost:3000/api/auth/twitch/callback"),
  TWITCH_OIDC_ISSUER: z.string().url().default("https://id.twitch.tv/oauth2"),
  TWITCH_AUTHORIZE_URL: z
    .string()
    .url()
    .default("https://id.twitch.tv/oauth2/authorize"),
  TWITCH_TOKEN_URL: z.string().url().default("https://id.twitch.tv/oauth2/token"),
  TWITCH_JWKS_URI: z.string().url().default("https://id.twitch.tv/oauth2/keys"),
  TWITCH_VALIDATE_URL: z
    .string()
    .url()
    .default("https://id.twitch.tv/oauth2/validate"),
  TWITCH_HELIX_BASE: z.string().url().default("https://api.twitch.tv/helix"),
  // Host OAuth (scope user:manage:whispers) — SEPARATE from the participant OIDC redirect.
  TWITCH_HOST_REDIRECT_URI: z
    .string()
    .url()
    .default("http://localhost:3000/api/auth/host/callback"),
});

export type CoreEnv = z.infer<typeof CoreEnv>;

let cached: CoreEnv | null = null;

/** Validated core env. Throws a readable error if `AUTH_STATE_SECRET` is missing/short. */
export function env(): CoreEnv {
  if (cached) return cached;
  const parsed = CoreEnv.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(
      `Invalid environment (.env.local): ${issues}. ` +
        `Generate AUTH_STATE_SECRET with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    );
  }
  cached = parsed.data;
  return cached;
}

/**
 * Twitch OAuth client credentials. These are NOT invented here — they must be
 * filled into `.env.local` from the Twitch Developer Console. Until then the
 * proof refuses to start a Twitch login (see the login route).
 */
export type TwitchCredentials =
  | { configured: true; clientId: string; clientSecret: string }
  | { configured: false; missing: string[] };

export function twitchCredentials(): TwitchCredentials {
  const clientId = process.env.TWITCH_CLIENT_ID?.trim() ?? "";
  const clientSecret = process.env.TWITCH_CLIENT_SECRET?.trim() ?? "";
  const missing: string[] = [];
  if (!clientId) missing.push("TWITCH_CLIENT_ID");
  if (!clientSecret) missing.push("TWITCH_CLIENT_SECRET");
  if (missing.length > 0) return { configured: false, missing };
  return { configured: true, clientId, clientSecret };
}

/**
 * SodaGift Sandbox config. `SODAGIFT_API_KEY` is server-only and must never reach
 * client JavaScript. `SODAGIFT_BASE_URL` has a safe default.
 */
export type SodaGiftConfig =
  | { configured: true; baseUrl: string; apiKey: string }
  | { configured: false; missing: string[] };

export function sodagift(): SodaGiftConfig {
  const baseUrl = (
    process.env.SODAGIFT_BASE_URL?.trim() || "https://biz-sandbox-api.sodagift.com"
  ).replace(/\/+$/, "");
  const apiKey = process.env.SODAGIFT_API_KEY?.trim() ?? "";
  if (!apiKey) return { configured: false, missing: ["SODAGIFT_API_KEY"] };
  return { configured: true, baseUrl, apiKey };
}

/** Display name sent as `delivery.sender.name` on SodaGift orders. Safe default. */
export function sodagiftSenderName(): string {
  return process.env.SODAGIFT_SENDER_NAME?.trim() || "SodaGift Live";
}

/** Claim-link lifetime. Default 7 days (CLAUDE.md §12: CLAIM_TOKEN_TTL_HOURS). */
export function claimTokenTtlHours(): number {
  const n = Number(process.env.CLAIM_TOKEN_TTL_HOURS);
  return Number.isFinite(n) && n > 0 ? n : 168;
}

/** PostgreSQL connection string (read by Prisma). Lives in `.env` so the Prisma CLI sees it. */
export function databaseUrl(): string {
  const url = process.env.DATABASE_URL?.trim() ?? "";
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Start Postgres with `docker compose up -d` and put " +
        "DATABASE_URL in .env (see .env.example).",
    );
  }
  return url;
}
