/**
 * scripts/sodagift-probe-order-link.ts  —  DEV ONLY, run locally by the project owner.
 *
 * WRITE PROBE. Creates AT MOST ONE real SodaGift SANDBOX order with delivery.method = "LINK"
 * to lock down the LINK contract for the MVP (Twitch winner -> SodaGift LINK order ->
 * voucher URL -> Twitch Whisper).
 *
 * Request shape is taken ONLY from official SodaGift docs (no invented fields):
 *   https://docs.sodagift.com/reference/v1createorder-1   (POST /v1/orders schema)
 *   https://docs.sodagift.com/docs/delivery-methods        (LINK requires recipient.name + sender.name)
 *   https://docs.sodagift.com/reference/getorderbyid-1     (order_item.delivery.link holds the voucher URL)
 *
 *   {
 *     "item": { "id": <product id> },              // custom_amount omitted: #99001 forbids it
 *     "delivery": {
 *       "method": "LINK",
 *       "recipient": { "name": "<recipient name>" },// LINK: name only, NO email/phone/address
 *       "sender":    { "name": "<sender name>" }    // LINK: name required
 *     },
 *     "message": "<optional, <=2000>",
 *     "external_reference_id": "<alphanumeric 1-100>"
 *   }
 *
 * Steps:
 *   L   POST /v1/orders (the ONE real order). 4xx -> capture + STOP, zero orders created.
 *   G1  GET /v1/orders/{id} immediately  -> capture full response, find order_item.delivery.link
 *   G2  GET /v1/orders/{id} after a short delay -> observe order_item status transition
 *   Bi  (opt-in --with-idempotency-check) repeat L byte-identical, same external_reference_id
 *       -> must return the SAME order id, create/charge nothing (already verified for EMAIL).
 *
 * SAFETY
 *  - DRY RUN by default. --confirm required to POST.
 *  - Creates AT MOST ONE real order (Bi is idempotent -> 0 additional).
 *  - The voucher URL (order_item.delivery.link) is a bearer secret: its VALUE is redacted
 *    in all output; its JSON path + structure (scheme/host/segments/length/siblings) are
 *    reported. --reveal-link writes the raw URL to link-url.txt (gitignored) for deliberate
 *    inspection.
 *  - No Twitch Whisper. No LINK-specific fields beyond the documented shape.
 *
 * Auth: SODA-API-KEY header on every request. No Authorization: Bearer.
 * Requires Node 18+ (global fetch). Reads SODAGIFT_BASE_URL / SODAGIFT_API_KEY /
 * SODAGIFT_SENDER_NAME from .env.local (real env vars win).
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(REPO_ROOT, "scratchpad", "sodagift-probe-order-link");

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
type Args = {
  productId: number;
  recipientName: string;
  senderName?: string;
  customAmount?: number;      // only if a future product needs it; #99001 must omit
  message: string;
  pollDelayMs: number;
  withIdempotencyCheck: boolean;
  revealLink: boolean;
  confirm: boolean;
  timeoutMs: number;
};

function parseArgs(argv: string[]): Args {
  const a: Args = {
    productId: 99001,
    recipientName: "SodaGift Live Winner",
    message: "SodaGift Live sandbox LINK contract probe -- please ignore.",
    pollDelayMs: 5000,
    withIdempotencyCheck: false,
    revealLink: false,
    confirm: false,
    timeoutMs: 20_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const next = () => argv[++i];
    switch (t) {
      case "--product-id": a.productId = Number(next()); break;
      case "--recipient-name": a.recipientName = next(); break;
      case "--sender-name": a.senderName = next(); break;
      case "--custom-amount": a.customAmount = Number(next()); break;
      case "--message": a.message = next(); break;
      case "--poll-delay-ms": a.pollDelayMs = Number(next()); break;
      case "--with-idempotency-check": a.withIdempotencyCheck = true; break;
      case "--reveal-link": a.revealLink = true; break;
      case "--confirm": a.confirm = true; break;
      case "--timeout-ms": a.timeoutMs = Number(next()); break;
      case "--help":
      case "-h":
        console.log(
          "Usage: npx --yes tsx scripts/sodagift-probe-order-link.ts \\\n" +
            "  [--product-id 99001] [--recipient-name \"Name\"] [--sender-name \"SodaGift Live\"] \\\n" +
            "  [--message \"...\"] [--poll-delay-ms 5000] [--with-idempotency-check] \\\n" +
            "  [--reveal-link] [--confirm]\n\n" +
            "Without --confirm this is a DRY RUN (no order created).\n" +
            "Creates AT MOST ONE real Sandbox order.",
        );
        process.exit(0);
    }
  }
  return a;
}
const ARGS = parseArgs(process.argv.slice(2));

// ---------------------------------------------------------------------------
// env
// ---------------------------------------------------------------------------
function loadEnvLocal(): void {
  const p = join(REPO_ROOT, ".env.local");
  if (!existsSync(p)) return;
  for (const raw of readFileSync(p, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
loadEnvLocal();

const BASE_URL = (process.env.SODAGIFT_BASE_URL ?? "").replace(/\/+$/, "");
const API_KEY = process.env.SODAGIFT_API_KEY ?? "";
const SENDER_NAME = ARGS.senderName ?? process.env.SODAGIFT_SENDER_NAME ?? "SodaGift Live";

function fail(msg: string): never {
  console.error("ERROR: " + msg);
  process.exit(1);
}
if (!BASE_URL || !API_KEY) fail("Missing SODAGIFT_BASE_URL or SODAGIFT_API_KEY (.env.local).");

const maskedKey =
  API_KEY.length > 12 ? `${API_KEY.slice(0, 13)}…${API_KEY.slice(-4)} (len ${API_KEY.length})` : "set";
const redactKey = (s: string) => (API_KEY ? s.split(API_KEY).join("<SODA-API-KEY:redacted>") : s);

// ---------------------------------------------------------------------------
// redaction — hide secret values, keep debug + structure. `link`/`url` values hidden.
// ---------------------------------------------------------------------------
const KEEP_KEY =
  /^(error|errors|error_?code|error_?message|error_?description|message|messages|detail|details|reason|reasons|status|status_?code|http_?status|created_?at|updated_?at|expired_?at|expires_?at|valid_?until|expiry_?date|method|name|currency|amount|id|external_?reference_?id|page_?number|element_?size|result_?size|total_?size)$/i;
const SENSITIVE_KEY =
  /voucher|barcode|secret|token|password|api_?key|apikey|otp|pin|redeem|redemption|code$|url$|uri$|link$|qr$/i;
const isSensitiveKey = (k: string) => (KEEP_KEY.test(k) ? false : SENSITIVE_KEY.test(k));

function redactDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (isSensitiveKey(k) && typeof val === "string") out[k] = `<redacted:string,len=${val.length}>`;
      else if (isSensitiveKey(k) && val && typeof val === "object") out[k] = "<redacted:object>";
      else out[k] = redactDeep(val);
    }
    return out;
  }
  return v;
}
function keyPaths(v: unknown, pred: (k: string) => boolean, base = "$"): string[] {
  const hits: string[] = [];
  const walk = (n: unknown, path: string) => {
    if (Array.isArray(n)) n.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (n && typeof n === "object")
      for (const [k, val] of Object.entries(n as Record<string, unknown>)) {
        const p = `${path}.${k}`;
        if (pred(k)) hits.push(p);
        walk(val, p);
      }
  };
  walk(v, base);
  return hits;
}
/** Find every string value that looks like an http(s) URL, with its JSON path. */
function findUrls(v: unknown, base = "$"): { path: string; value: string }[] {
  const hits: { path: string; value: string }[] = [];
  const walk = (n: unknown, path: string) => {
    if (typeof n === "string" && /^https?:\/\//i.test(n)) hits.push({ path, value: n });
    else if (Array.isArray(n)) n.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (n && typeof n === "object")
      for (const [k, val] of Object.entries(n as Record<string, unknown>)) walk(val, `${path}.${k}`);
  };
  walk(v, base);
  return hits;
}
function analyzeUrl(u: string) {
  try {
    const url = new URL(u);
    return {
      scheme: url.protocol.replace(":", ""),
      host: url.host,
      pathSegments: url.pathname.split("/").filter(Boolean).length,
      pathTemplate: url.pathname.replace(/\/[^/]{6,}/g, "/****"),
      hasQuery: url.search.length > 0,
      queryKeys: [...url.searchParams.keys()],
      length: u.length,
    };
  } catch {
    return { scheme: "?", host: "?", pathSegments: 0, pathTemplate: "?", hasQuery: false, queryKeys: [], length: u.length };
  }
}
/** siblings of the object that directly contains `link`/`code`/`shipping` — expiry/flags live here */
function deliverySiblings(v: unknown): Record<string, unknown> | null {
  let found: Record<string, unknown> | null = null;
  const walk = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && typeof n === "object") {
      const o = n as Record<string, unknown>;
      if ("link" in o || ("method" in o && ("code" in o || "shipping" in o || "recipient" in o))) {
        found = Object.fromEntries(
          Object.entries(o).map(([k, val]) => [
            k,
            isSensitiveKey(k) ? (typeof val === "string" ? `<redacted:len=${val.length}>` : "<redacted>") : val,
          ]),
        );
      }
      Object.values(o).forEach(walk);
    }
  };
  walk(v);
  return found;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
type Resp = { status: number; ok: boolean; headers: Record<string, string>; bodyText: string; json: unknown };
async function sodaFetch(method: string, path: string, body?: unknown): Promise<Resp> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ARGS.timeoutMs);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        "SODA-API-KEY": API_KEY,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const bodyText = await res.text();
    let json: unknown = null;
    try { json = JSON.parse(bodyText); } catch { /* keep text */ }
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k] = v));
    return { status: res.status, ok: res.ok, headers, bodyText, json };
  } finally {
    clearTimeout(timer);
  }
}
function write(name: string, data: unknown): void {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  writeFileSync(join(OUT_DIR, name), redactKey(text));
  console.log("  wrote", name);
}
function saveResponse(tag: string, r: Resp): void {
  write(`${tag}-response.json`, {
    httpStatus: r.status,
    ok: r.ok,
    headers: r.headers,
    sensitiveKeyPaths: r.json ? keyPaths(r.json, isSensitiveKey) : [],
    urlPaths: r.json ? findUrls(r.json).map((h) => h.path) : [],
    body: r.json ? redactDeep(r.json) : redactKey(r.bodyText).slice(0, 4000),
  });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// request builder — documented LINK shape only
// ---------------------------------------------------------------------------
const EXTERNAL_REF_RE = /^[A-Za-z0-9]{1,100}$/;
const RUN_ID = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14) + randomBytes(3).toString("hex");
const REF = `probelink${RUN_ID}`;
if (!EXTERNAL_REF_RE.test(REF)) fail(`generated external_reference_id not alphanumeric-only: ${REF}`);

function linkOrderBody() {
  const item: Record<string, unknown> = { id: ARGS.productId };
  if (ARGS.customAmount !== undefined) item.custom_amount = ARGS.customAmount; // #99001: leave omitted
  return {
    item,
    delivery: {
      method: "LINK",
      recipient: { name: ARGS.recipientName }, // LINK: name only (docs)
      sender: { name: SENDER_NAME },           // LINK: name required (docs)
    },
    message: ARGS.message,
    external_reference_id: REF,
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const body = linkOrderBody();

  console.log("SodaGift LINK order probe");
  console.log("  base URL :", BASE_URL);
  console.log("  api key  :", maskedKey, "(header: SODA-API-KEY)");
  console.log("  mode     :", ARGS.confirm ? "CONFIRMED — will create ONE order" : "DRY RUN — no order");
  console.log("  product  :", ARGS.productId, "(custom_amount", ARGS.customAmount ?? "OMITTED", ")");
  console.log("  recipient:", ARGS.recipientName, "(name only — LINK needs no email/phone)");
  console.log("  sender   :", SENDER_NAME);
  console.log("  run id   :", RUN_ID);
  console.log("");
  console.log("Request body L (POST /v1/orders):");
  console.log(JSON.stringify(body, null, 2));
  write("00-plan.json", {
    mode: ARGS.confirm ? "confirmed" : "dry-run",
    runId: RUN_ID,
    externalReferenceId: REF,
    productId: ARGS.productId,
    maxRealOrders: 1,
    steps: ["L POST", "G1 GET {id}", `G2 GET {id} (+${ARGS.pollDelayMs}ms)`,
      ARGS.withIdempotencyCheck ? "Bi POST (same ref id, idempotent)" : "Bi skipped"],
    requestBodyL: body,
  });
  write("L-request.json", body);

  if (!ARGS.confirm) {
    console.log("\nDRY RUN complete. Re-run with --confirm to create ONE LINK order.");
    return;
  }

  // ---- balance before ----
  const balBefore = await sodaFetch("GET", "/v1/accounts/balance");
  write("balance-before.json", { httpStatus: balBefore.status, body: redactDeep(balBefore.json) });

  // ---- L: the ONE real order ----
  console.log("\n== L: POST /v1/orders (method=LINK) ==");
  const L = await sodaFetch("POST", "/v1/orders", body);
  console.log("  HTTP", L.status);
  saveResponse("L", L);

  if (!L.ok) {
    write("summary.json", {
      capturedAt: new Date().toISOString(),
      runId: RUN_ID,
      externalReferenceId: REF,
      result: "LINK create FAILED — no order created, STOPPED (no retries, no field guessing).",
      httpStatus: L.status,
      errorBody: L.json ? redactDeep(L.json) : redactKey(L.bodyText).slice(0, 2000),
      requestBodyL: body,
      note: "Inspect L-response.json. Adjust only per the SodaGift error message / docs — do not invent fields.",
    });
    const balAfterFail = await sodaFetch("GET", "/v1/accounts/balance");
    write("balance-after.json", { httpStatus: balAfterFail.status, body: redactDeep(balAfterFail.json) });
    console.log("\nL failed; stopped. See L-response.json + summary.json.");
    return;
  }

  const pickId = (j: unknown): string | number | undefined => {
    const o = (j ?? {}) as Record<string, unknown>;
    return (o.id ?? o.order_id ?? o.orderId ?? (o.order as Record<string, unknown>)?.id) as any;
  };
  const orderId = pickId(L.json);

  // ---- G1: read the created order ----
  let g1: Resp | null = null;
  if (orderId !== undefined) {
    console.log(`== G1: GET /v1/orders/${orderId} ==`);
    g1 = await sodaFetch("GET", `/v1/orders/${encodeURIComponent(String(orderId))}`);
    console.log("  HTTP", g1.status);
    saveResponse("G1", g1);
  } else {
    write("G1-response.json", { note: "no order id in L response; inspect L-response.json" });
  }

  // ---- G2: read again after a delay to watch order_item status move ----
  let g2: Resp | null = null;
  if (orderId !== undefined) {
    console.log(`   (waiting ${ARGS.pollDelayMs}ms…)`);
    await sleep(ARGS.pollDelayMs);
    console.log(`== G2: GET /v1/orders/${orderId} ==`);
    g2 = await sodaFetch("GET", `/v1/orders/${encodeURIComponent(String(orderId))}`);
    console.log("  HTTP", g2.status);
    saveResponse("G2", g2);
  }

  // ---- Bi: idempotency check (opt-in) — repeat identical POST, same ref id ----
  let bi: Resp | null = null;
  if (ARGS.withIdempotencyCheck) {
    console.log("== Bi: POST /v1/orders (identical, same external_reference_id) ==");
    bi = await sodaFetch("POST", "/v1/orders", body);
    console.log("  HTTP", bi.status);
    saveResponse("Bi", bi);
  }

  // ---- balance after ----
  const balAfter = await sodaFetch("GET", "/v1/accounts/balance");
  write("balance-after.json", { httpStatus: balAfter.status, body: redactDeep(balAfter.json) });

  // ---- analyse the voucher URL from whichever GET carries it ----
  const source = (g2?.json ?? g1?.json ?? L.json) as unknown;
  const urls = findUrls(source);
  const linkAnalysis = urls.map((u) => ({ path: u.path, ...analyzeUrl(u.value) }));
  if (ARGS.revealLink && urls.length) {
    write("link-url.txt", urls.map((u) => `${u.path}\n${u.value}`).join("\n\n"));
  }

  const balBeforeAmt = (balBefore.json as Record<string, unknown>)?.amount ?? null;
  const balAfterAmt = (balAfter.json as Record<string, unknown>)?.amount ?? null;

  write("summary.json", {
    capturedAt: new Date().toISOString(),
    runId: RUN_ID,
    externalReferenceId: REF,
    result: "LINK create OK",
    answers: {
      "1_request_body": body,
      "2_recipient": "sent { name } only (per docs: LINK requires recipient.name; no email/phone). See L-response for acceptance.",
      "3_sender": "sent { name } (per docs: LINK requires sender.name).",
      "4_create_response_http": L.status,
      "4_create_response_shape": L.json ? redactDeep(L.json) : null,
      "5_url_json_paths": linkAnalysis, // path + scheme/host/segments/length/query — value redacted
      "6_status_behavior": {
        createOrderStatus: (L.json as any)?.status ?? null,
        createItemStatus: (L.json as any)?.order_item?.status ?? null,
        g1: g1 ? keyPaths(g1.json, (k) => /^status$/i.test(k)).map((p) => p) : null,
        g1_raw_status_hint: g1?.json ? redactDeep(g1.json) : null,
        g2_raw_status_hint: g2?.json ? redactDeep(g2.json) : null,
      },
      "7_redemption_metadata": deliverySiblings(source),
    },
    idempotency: bi
      ? {
          sameOrderId: pickId(bi.json) === orderId,
          biOrderId: pickId(bi.json) ?? null,
          lOrderId: orderId ?? null,
        }
      : "skipped (--with-idempotency-check to run)",
    balance: { before: balBeforeAmt, after: balAfterAmt, delta: (balAfterAmt as number) - (balBeforeAmt as number) },
    files: ["L-response.json", "G1-response.json", "G2-response.json",
      ARGS.withIdempotencyCheck ? "Bi-response.json" : null,
      ARGS.revealLink ? "link-url.txt" : null].filter(Boolean),
    notes: [
      "The voucher URL value is redacted; --reveal-link writes it to link-url.txt (gitignored).",
      "No Twitch Whisper sent. No LINK-specific fields beyond the documented shape.",
      "Paste summary.json + G1/G2-response.json back for the LINK contract review.",
    ],
  });

  console.log("\nDone. Review scratchpad/sodagift-probe-order-link/ and paste the files back.");
}

main().catch((err) => {
  console.error("probe failed:", redactKey(String(err?.stack ?? err)));
  process.exit(1);
});
