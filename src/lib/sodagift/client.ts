// Server-only SodaGift Sandbox HTTP client.
// Auth header is `SODA-API-KEY: <key>` on every request (NOT `Authorization: Bearer`).
// The API key is never logged and never returned to a caller.

import "server-only";
import { sodagift } from "@/lib/env";

const DEFAULT_TIMEOUT_MS = 15_000;

export class SodaGiftError extends Error {
  readonly status: number;
  /** `errorCode` from the `{ errorCode, message }` body, when present (drives retry policy). */
  readonly errorCode?: string;
  constructor(message: string, status: number, errorCode?: string) {
    super(message);
    this.name = "SodaGiftError";
    this.status = status;
    this.errorCode = errorCode;
  }
}

export class SodaGiftNotConfiguredError extends SodaGiftError {
  constructor() {
    super("SodaGift is not configured (SODAGIFT_API_KEY missing in .env.local)", 0);
    this.name = "SodaGiftNotConfiguredError";
  }
}

/** GET a SodaGift JSON endpoint. Returns parsed JSON; throws SodaGiftError on non-2xx. */
export async function sodaGetJson<T = unknown>(
  path: string,
  init: { timeoutMs?: number } = {},
): Promise<T> {
  const cfg = sodagift();
  if (!cfg.configured) throw new SodaGiftNotConfiguredError();

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    init.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  try {
    const res = await fetch(`${cfg.baseUrl}${path}`, {
      method: "GET",
      headers: {
        "SODA-API-KEY": cfg.apiKey, // server-only; never forwarded to the browser
        Accept: "application/json",
      },
      signal: controller.signal,
      cache: "no-store",
    });

    const text = await res.text();
    if (!res.ok) {
      // Body may contain { errorCode, message } — safe to surface, no secrets.
      throw new SodaGiftError(
        `GET ${path} -> HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ""}`,
        res.status,
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new SodaGiftError(`GET ${path} -> non-JSON response`, res.status);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST a SodaGift JSON endpoint. Returns parsed JSON; on non-2xx throws SodaGiftError with
 * `status` and the `{ errorCode, message }` body's `errorCode` attached (retry policy — §11).
 */
export async function sodaPostJson<T = unknown>(
  path: string,
  body: unknown,
  init: { timeoutMs?: number } = {},
): Promise<T> {
  const cfg = sodagift();
  if (!cfg.configured) throw new SodaGiftNotConfiguredError();

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    init.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  try {
    const res = await fetch(`${cfg.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "SODA-API-KEY": cfg.apiKey, // server-only; never forwarded to the browser
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });

    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* keep null */
    }

    if (!res.ok) {
      const errorCode =
        json && typeof json === "object" && typeof (json as { errorCode?: unknown }).errorCode === "string"
          ? (json as { errorCode: string }).errorCode
          : undefined;
      const detail = text ? `: ${text.slice(0, 300)}` : "";
      throw new SodaGiftError(`POST ${path} -> HTTP ${res.status}${detail}`, res.status, errorCode);
    }
    if (json === null) throw new SodaGiftError(`POST ${path} -> non-JSON response`, res.status);
    return json as T;
  } finally {
    clearTimeout(timer);
  }
}
