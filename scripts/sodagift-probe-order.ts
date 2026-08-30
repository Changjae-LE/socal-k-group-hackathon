/**
 * scripts/sodagift-probe-order.ts  —  DEV ONLY, run locally by the project owner.
 *
 * WRITE PROBE. Creates real SodaGift SANDBOX orders to pin down the generic
 * POST /v1/orders request/response contract using the EMAIL + SENDER baseline.
 *
 * Approved plan (see CLAUDE.md §11 / §15 probe 1.b) — A + B + C1 only:
 *   product  auto-selected: ON_SALE, type GIFT_CARD, FIXED denomination,
 *            EMAIL + SENDER (+ LINK for reuse), NOT payment-card-like, USD preferred.
 *            #50005 "Virtual Universal Prepaid Mastercard CAD" is EXCLUDED — HTTP 500
 *            errorCode=unhandled_error; carries product-specific rules.
 *   custom_amount  PRODUCT-SPECIFIC, verified per product (NOT derivable from FIXED/RANGE):
 *            #50005 -> REQUIRED ("customAmount is required")
 *            #99001 -> FORBIDDEN ("customAmount must be null")
 *            Default for the auto-selected #99001 baseline: OMIT. Override per product with
 *            --custom-amount N / --no-custom-amount.
 *   A  create ONE EMAIL + SENDER order with the per-product custom_amount decision.
 *   B  repeat the byte-identical request with the SAME external_reference_id
 *      -> expect the SAME order back, no duplicate, no extra spend
 *   C1 GET /v1/orders/{id}   -- authoritative reconciliation (order id from create response)
 *   C2 GET /v1/orders?external_reference_id=...  -- OFF unless --try-list-lookup.
 *      List lookup needs element_size AND page; page indexing (0- vs 1-based) is UNKNOWN
 *      and must come from the SodaGift OpenAPI/docs — this script does NOT guess it.
 *      C2 never blocks the run.
 *   D / E  OPT-IN (--include-d / --include-e), NOT part of the approved run.
 *
 * Retry: 500 errorCode=unhandled_error is NOT retried (only order_retry_needed is).
 *
 * LINK delivery is a REQUIRED MVP contract and is investigated in the NEXT probe
 * (scripts/sodagift-probe-order-link.ts) once this baseline succeeds. This script
 * never sends a LINK payload — it is not yet known and must not be invented.
 *
 * SAFETY
 *  - DRY RUN by default. Without --confirm it selects the product(s), writes the
 *    exact request bodies it WOULD send, and exits WITHOUT creating anything.
 *  - --confirm is required to POST. Default run (A+B+C) creates exactly 1 order.
 *  - --max-amount (default 10, in the product's own currency units) aborts if the
 *    chosen product is more expensive; override with --product-id / --range-id.
 *  - The API key is never printed or written. Response values under keys that look
 *    like secrets (voucher/barcode/secret/token/apikey/otp/pin/redeem, or ending in
 *    code/url/uri/link/qr) are replaced with a "<redacted:type,len>" placeholder in
 *    console + files; key NAMES are kept so the LINK-URL field can be located later.
 *  - Debug fields are NOT redacted: error, errorCode, errorMessage, message, reason,
 *    detail(s), status, statusCode, path, field(s), external_reference_id.
 *  - external_reference_id is ALWAYS alphanumeric only: ^[A-Za-z0-9]{1,100}$
 *    (SodaGift sandbox rejects hyphens/underscores with HTTP 400).
 *
 * Auth: SODA-API-KEY: <key>  header on every request. No Authorization: Bearer.
 *
 * Requires Node 18+ (global fetch). Reads SODAGIFT_BASE_URL / SODAGIFT_API_KEY /
 * SODAGIFT_SENDER_NAME from .env.local (real env vars win).
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(REPO_ROOT, "scratchpad", "sodagift-probe-order");

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
type Args = {
  recipientEmail?: string;
  recipientName: string;
  senderName?: string;
  productId?: number;
  rangeId?: number;
  maxAmount: number;
  elementSize: number;
  customAmount?: number;        // --custom-amount N  -> force include with value N
  noCustomAmount: boolean;      // --no-custom-amount -> force omit
  tryListLookup: boolean;       // --try-list-lookup  -> also attempt C2 (exploratory)
  includeD: boolean;
  includeE: boolean;
  confirm: boolean;
  timeoutMs: number;
};

function parseArgs(argv: string[]): Args {
  const a: Args = {
    recipientName: "SodaGift Live Probe",
    maxAmount: 10,
    elementSize: 10,
    noCustomAmount: false,
    tryListLookup: false,
    includeD: false,
    includeE: false,
    confirm: false,
    timeoutMs: 20_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const next = () => argv[++i];
    switch (t) {
      case "--recipient-email": a.recipientEmail = next(); break;
      case "--recipient-name": a.recipientName = next(); break;
      case "--sender-name": a.senderName = next(); break;
      case "--product-id": a.productId = Number(next()); break;
      case "--range-id": a.rangeId = Number(next()); break;
      case "--max-amount": a.maxAmount = Number(next()); break;
      case "--element-size": a.elementSize = Number(next()); break;
      case "--custom-amount": a.customAmount = Number(next()); break;
      case "--no-custom-amount": a.noCustomAmount = true; break;
      case "--try-list-lookup": a.tryListLookup = true; break;
      case "--include-d": a.includeD = true; break;
      case "--include-e": a.includeE = true; break;
      case "--confirm": a.confirm = true; break;
      case "--timeout-ms": a.timeoutMs = Number(next()); break;
      case "--help":
      case "-h":
        console.log(
          "Usage: npx --yes tsx scripts/sodagift-probe-order.ts \\\n" +
            "  --recipient-email you@example.com [--recipient-name \"Name\"] \\\n" +
            "  [--sender-name \"SodaGift Live\"] [--product-id N] \\\n" +
            "  [--custom-amount N | --no-custom-amount]  (per-product; verified table used otherwise) \\\n" +
            "  [--try-list-lookup] [--range-id N] [--max-amount 10] [--element-size 10] \\\n" +
            "  [--include-d] [--include-e] [--confirm]\n\n" +
            "Without --confirm this is a DRY RUN (no orders created).\n" +
            "Approved run = A + B + C1 (GET /v1/orders/{id}). C2 (list lookup) is OFF unless --try-list-lookup.",
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
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
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
if (!ARGS.recipientEmail) fail("--recipient-email is required (use a mailbox you control).");
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ARGS.recipientEmail)) fail("--recipient-email is not a valid email.");

const maskedKey =
  API_KEY.length > 12 ? `${API_KEY.slice(0, 13)}…${API_KEY.slice(-4)} (len ${API_KEY.length})` : `set`;
const redactKey = (s: string) => (API_KEY ? s.split(API_KEY).join("<SODA-API-KEY:redacted>") : s);

// ---------------------------------------------------------------------------
// redaction of response payloads
// ---------------------------------------------------------------------------
// Keys we NEVER redact even if they look sensitive — debugging must stay useful.
// SodaGift error diagnostics (errorCode / message / etc.) are not secrets.
const KEEP_KEY =
  /^(error|errors|error_?code|error_?message|error_?description|message|messages|detail|details|reason|reasons|status|status_?code|http_?status|timestamp|path|field|fields|external_?reference_?id)$/i;
// Values genuinely worth hiding: API keys, tokens, gift/voucher codes, reward/claim URLs.
// `code$` also matches `errorCode`, but KEEP_KEY is checked first so error codes survive.
const SENSITIVE_KEY = /voucher|barcode|secret|token|password|api_?key|apikey|otp|pin|redeem|redemption|code$|url$|uri$|link$|qr$/i;
function isSensitiveKey(k: string): boolean {
  if (KEEP_KEY.test(k)) return false;
  return SENSITIVE_KEY.test(k);
}
function redactDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (isSensitiveKey(k) && typeof val === "string") {
        out[k] = `<redacted:string,len=${val.length}>`;
      } else if (isSensitiveKey(k) && val && typeof val === "object") {
        out[k] = "<redacted:object>";
      } else {
        out[k] = redactDeep(val);
      }
    }
    return out;
  }
  return v;
}
function sensitiveKeyPaths(v: unknown, base = "$"): string[] {
  const hits: string[] = [];
  const walk = (node: unknown, path: string) => {
    if (Array.isArray(node)) node.forEach((n, i) => walk(n, `${path}[${i}]`));
    else if (node && typeof node === "object") {
      for (const [k, val] of Object.entries(node as Record<string, unknown>)) {
        const p = `${path}.${k}`;
        if (isSensitiveKey(k)) hits.push(p);
        walk(val, p);
      }
    }
  };
  walk(v, base);
  return hits;
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
    sensitiveKeyPaths: r.json ? sensitiveKeyPaths(r.json) : [],
    body: r.json ? redactDeep(r.json) : redactKey(r.bodyText).slice(0, 4000),
  });
}

// ---------------------------------------------------------------------------
// product selection
// ---------------------------------------------------------------------------
type Product = {
  id: number; name: string; type: string; availability: string; currency: string;
  amount: number | null; min_amount: number | null; max_amount: number | null;
  available_delivery_method: string[]; recipient_info_provided_by: string[]; country_code: string;
  brand?: { name?: string } | null; validity?: number | null;
};
const isFixed = (p: Product) => p.amount != null && p.min_amount == null && p.max_amount == null;
const isRange = (p: Product) => p.amount == null && p.min_amount != null && p.max_amount != null;
const emailSender = (p: Product) =>
  p.available_delivery_method.includes("EMAIL") && p.recipient_info_provided_by.includes("SENDER");
// Exclude payment-card-like products from the baseline (may carry product-specific rules;
// #50005 "Virtual Universal Prepaid Mastercard CAD" returned HTTP 500 unhandled_error).
const CARD_LIKE = /mastercard|visa\b|prepaid|virtual (universal|promotional)|payment card|debit card/i;
const isCardLike = (p: Product) =>
  CARD_LIKE.test(p.name ?? "") || CARD_LIKE.test(p.brand?.name ?? "");
const relevantFields = (p: Product) => ({
  id: p.id,
  "brand.name": p.brand?.name ?? null,
  name: p.name,
  country_code: p.country_code,
  currency: p.currency,
  amount: p.amount,
  min_amount: p.min_amount,
  max_amount: p.max_amount,
  available_delivery_method: p.available_delivery_method,
  recipient_info_provided_by: p.recipient_info_provided_by,
  type: p.type,
  availability: p.availability,
  validity: p.validity ?? null,
});

// ---------------------------------------------------------------------------
// custom_amount is PRODUCT-SPECIFIC — verified empirically, NOT derivable from
// FIXED/RANGE. Known facts only; do not generalize:
//   #50005 -> custom_amount REQUIRED ("customAmount is required")
//   #99001 -> custom_amount MUST BE OMITTED/NULL ("customAmount must be null")
// The catalog /v1/products payload has no field describing this; source of truth
// is the SodaGift OpenAPI/docs or per-product probing.
// ---------------------------------------------------------------------------
const CUSTOM_AMOUNT_RULE: Record<number, "require" | "omit"> = {
  50005: "require",
  99001: "omit",
};
type CustomAmountDecision = { value: number | undefined; source: string };
function decideCustomAmount(p: Product): CustomAmountDecision {
  if (ARGS.noCustomAmount) return { value: undefined, source: "--no-custom-amount" };
  if (ARGS.customAmount !== undefined) return { value: ARGS.customAmount, source: "--custom-amount" };
  const rule = CUSTOM_AMOUNT_RULE[p.id];
  if (rule === "require") return { value: p.amount ?? undefined, source: `verified rule #${p.id}=require (value=catalog amount)` };
  if (rule === "omit") return { value: undefined, source: `verified rule #${p.id}=omit` };
  return { value: undefined, source: `UNVERIFIED for #${p.id} — defaulting to OMIT; confirm via OpenAPI or --custom-amount/--no-custom-amount` };
}

async function fetchProducts(): Promise<Product[]> {
  const r = await sodaFetch("GET", "/v1/products");
  if (!r.ok || !r.json || typeof r.json !== "object") fail(`GET /v1/products failed (HTTP ${r.status}).`);
  const list = (r.json as { products?: Product[] }).products;
  if (!Array.isArray(list)) fail("GET /v1/products: no `products` array.");
  return list;
}

function pickFixed(products: Product[]): Product {
  if (ARGS.productId) {
    const p = products.find((x) => x.id === ARGS.productId);
    if (!p) fail(`--product-id ${ARGS.productId} not found in catalog.`);
    if (!isFixed(p)) fail(`--product-id ${ARGS.productId} is not a FIXED product.`);
    if (!emailSender(p)) fail(`--product-id ${ARGS.productId} does not support EMAIL + SENDER.`);
    return p;
  }
  // deterministic baseline product:
  //   ON_SALE, type GIFT_CARD, FIXED denomination, EMAIL + SENDER, also LINK (so probe 1.c
  //   can reuse it), NOT payment-card-like.
  //   order: USD first, then lowest amount, then lowest id.
  const cands = products
    .filter(
      (p) =>
        p.availability === "ON_SALE" &&
        p.type === "GIFT_CARD" &&
        isFixed(p) &&
        emailSender(p) &&
        p.available_delivery_method.includes("LINK") &&
        !isCardLike(p),
    )
    .sort(
      (a, b) =>
        (a.currency === "USD" ? 0 : 1) - (b.currency === "USD" ? 0 : 1) ||
        a.amount! - b.amount! ||
        a.id - b.id,
    );
  if (!cands.length) fail("No ON_SALE FIXED GIFT_CARD with EMAIL+LINK+SENDER (non-card-like) found.");
  return cands[0];
}

function pickRange(products: Product[]): Product {
  if (ARGS.rangeId) {
    const p = products.find((x) => x.id === ARGS.rangeId);
    if (!p) fail(`--range-id ${ARGS.rangeId} not found.`);
    if (!isRange(p)) fail(`--range-id ${ARGS.rangeId} is not a RANGE product.`);
    if (!emailSender(p)) fail(`--range-id ${ARGS.rangeId} does not support EMAIL + SENDER.`);
    return p;
  }
  const cands = products
    .filter((p) => p.availability === "ON_SALE" && isRange(p) && emailSender(p))
    .sort((a, b) => (a.min_amount! - b.min_amount!) || (a.max_amount! - b.max_amount!) || (a.id - b.id));
  if (!cands.length) fail("No ON_SALE RANGE product with EMAIL + SENDER found.");
  return cands[0];
}

// ---------------------------------------------------------------------------
// request builders (documented EMAIL shape only)
// ---------------------------------------------------------------------------
// SodaGift rule (docs + sandbox 400): external_reference_id must match ^[A-Za-z0-9]{1,100}$
// — NO hyphen, underscore, space, or punctuation.
const EXTERNAL_REF_RE = /^[A-Za-z0-9]{1,100}$/;
const RUN_ID = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14) + randomBytes(3).toString("hex");
const REF = {
  ab: `probeemail${RUN_ID}`,
  d: `probeemaild${RUN_ID}`,
  e: `probeemaile${RUN_ID}`,
};
for (const v of Object.values(REF)) {
  if (!EXTERNAL_REF_RE.test(v)) fail(`generated external_reference_id is not alphanumeric-only: ${v}`);
}

function emailOrderBody(productId: number, externalReferenceId: string, customAmount?: number) {
  const item: Record<string, unknown> = { id: productId };
  if (customAmount !== undefined) item.custom_amount = customAmount;
  return {
    item,
    delivery: {
      method: "EMAIL",
      recipient: { name: ARGS.recipientName, email: ARGS.recipientEmail },
      sender: { name: SENDER_NAME },
    },
    // ASCII only, matches the request body the owner confirmed on the first run.
    message: "SodaGift Live sandbox contract probe -- please ignore.",
    external_reference_id: externalReferenceId,
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  console.log("SodaGift EMAIL order probe");
  console.log("  base URL :", BASE_URL);
  console.log("  api key  :", maskedKey, "(header: SODA-API-KEY)");
  console.log("  mode     :", ARGS.confirm ? "CONFIRMED — will create orders" : "DRY RUN — no orders");
  console.log("  recipient:", ARGS.recipientEmail, `(${ARGS.recipientName})`);
  console.log("  sender   :", SENDER_NAME);
  console.log("  run id   :", RUN_ID);
  console.log("");

  const products = await fetchProducts();
  const fixed = pickFixed(products);
  const range = ARGS.includeE ? pickRange(products) : null;

  if (fixed.amount! > ARGS.maxAmount) {
    fail(
      `chosen FIXED product ${fixed.id} costs ${fixed.amount} ${fixed.currency} > --max-amount ${ARGS.maxAmount}. ` +
        `Pass --product-id or raise --max-amount.`,
    );
  }
  if (range && range.min_amount! > ARGS.maxAmount) {
    fail(`chosen RANGE product ${range.id} min ${range.min_amount} ${range.currency} > --max-amount ${ARGS.maxAmount}.`);
  }

  // per-product custom_amount decision (verified table / CLI override / default omit)
  const ca = decideCustomAmount(fixed);

  const plannedOrders = 1 + (ARGS.includeD ? 1 : 0) + (ARGS.includeE ? 1 : 0);
  const selection = {
    mode: ARGS.confirm ? "confirmed" : "dry-run",
    runId: RUN_ID,
    plannedRealOrders: plannedOrders,
    externalReferenceIds: REF,
    fixedProduct: relevantFields(fixed),
    rangeProduct: range ? relevantFields(range) : null,
    customAmountDecision: { include: ca.value !== undefined, value: ca.value ?? null, source: ca.source },
    calls: {
      // custom_amount is per-product (verified): #50005 requires it, #99001 forbids it.
      A: emailOrderBody(fixed.id, REF.ab, ca.value),
      B: emailOrderBody(fixed.id, REF.ab, ca.value),
      // C1 = authoritative reconciliation. C2 = list lookup: OFF unless --try-list-lookup;
      // still returns 400 (needs `page` too — do NOT guess; check OpenAPI).
      C1: `GET /v1/orders/{id}`,
      C2: ARGS.tryListLookup
        ? `GET /v1/orders?external_reference_id=${REF.ab}&element_size=${ARGS.elementSize}  (exploratory; also needs 'page')`
        : "(skipped; pass --try-list-lookup)",
      D: ARGS.includeD ? emailOrderBody(fixed.id, REF.d, ca.value) : "(skipped; pass --include-d)",
      E: ARGS.includeE && range ? emailOrderBody(range.id, REF.e, range.min_amount!) : "(skipped; pass --include-e)",
    },
  };
  write("00-selection.json", selection);
  write("A-request.json", selection.calls.A);
  write("B-request.json", selection.calls.B);
  if (ARGS.includeD) write("D-request.json", selection.calls.D);
  if (ARGS.includeE && range) write("E-request.json", selection.calls.E);

  console.log("");
  console.log("Selected FIXED product (baseline):");
  console.log(JSON.stringify(relevantFields(fixed), null, 2));
  if (isCardLike(fixed)) console.log("WARNING: selected product looks payment-card-like — pass --product-id to override.");
  console.log(`custom_amount decision: ${ca.value !== undefined ? `include ${ca.value}` : "OMIT"}  (${ca.source})`);
  if (CUSTOM_AMOUNT_RULE[fixed.id] === undefined && ARGS.customAmount === undefined && !ARGS.noCustomAmount) {
    console.log("NOTE: this product's custom_amount rule is UNVERIFIED — see CLAUDE.md §11; check OpenAPI or use --custom-amount / --no-custom-amount.");
  }
  if (range) console.log(`Selected RANGE product : #${range.id} "${range.name}" ${range.min_amount}-${range.max_amount} ${range.currency}`);
  console.log("");
  console.log("Request body A/B (POST /v1/orders):");
  console.log(JSON.stringify(selection.calls.A, null, 2));
  console.log(`Planned REAL orders   : ${plannedOrders}  (A&B share one; C1 read-only${ARGS.tryListLookup ? "; C2 exploratory" : ""}${ARGS.includeD ? "; D=+1" : ""}${ARGS.includeE ? "; E=+1" : ""})`);

  if (!ARGS.confirm) {
    console.log("\nDRY RUN complete. Review 00-selection.json / *-request.json.");
    console.log("Re-run with --confirm to create the order(s).");
    return;
  }

  // ---- balance before ----
  const balBefore = await sodaFetch("GET", "/v1/accounts/balance");
  write("balance-before.json", { httpStatus: balBefore.status, body: redactDeep(balBefore.json) });

  // ---- A ----
  console.log(
    `\n== A: POST /v1/orders (custom_amount ${ca.value !== undefined ? "= " + ca.value + " " + fixed.currency : "OMITTED"}) ==`,
  );
  const A = await sodaFetch("POST", "/v1/orders", selection.calls.A);
  console.log("  HTTP", A.status);
  saveResponse("A", A);

  // ---- B (identical, same ref id) ----
  console.log("== B: POST /v1/orders (identical, same external_reference_id) ==");
  const B = await sodaFetch("POST", "/v1/orders", selection.calls.B);
  console.log("  HTTP", B.status);
  saveResponse("B", B);

  // ---- derive order id for C ----
  const pickId = (j: unknown): string | number | undefined => {
    const o = (j ?? {}) as Record<string, unknown>;
    return (o.id ?? o.order_id ?? o.orderId ?? (o.order as Record<string, unknown>)?.id) as
      | string
      | number
      | undefined;
  };
  const orderId = pickId(A.json) ?? pickId(B.json);

  // ---- C1: lookup by order id — the AUTHORITATIVE reconciliation path ----
  let cByIdStatus: number | "no-order-id" = "no-order-id";
  if (orderId !== undefined) {
    console.log(`== C1: GET /v1/orders/${orderId} ==`);
    const cById = await sodaFetch("GET", `/v1/orders/${encodeURIComponent(String(orderId))}`);
    cByIdStatus = cById.status;
    console.log("  HTTP", cById.status);
    saveResponse("C-by-id", cById);
  } else {
    write("C-by-id-response.json", { note: "no order id in A/B response (A/B did not succeed); inspect A/B-response.json" });
  }

  // ---- C2: lookup by external_reference_id — OFF by default, EXPLORATORY, never blocks ----
  // Verified: this endpoint needs BOTH `element_size` AND `page` (sandbox 400s:
  // "element_size is required", then "page is required"). We do NOT guess page indexing
  // (0- vs 1-based) — that must come from the SodaGift OpenAPI/docs. Enable with
  // --try-list-lookup only to capture the next raw error; it changes nothing else.
  let cByRefStatus: number | "error" | "skipped" = "skipped";
  if (ARGS.tryListLookup) {
    const cByRefPath =
      `/v1/orders?external_reference_id=${encodeURIComponent(REF.ab)}&element_size=${ARGS.elementSize}`;
    try {
      console.log(`== C2: GET ${cByRefPath}  (exploratory; 'page' not sent — see OpenAPI) ==`);
      const cByRef = await sodaFetch("GET", cByRefPath);
      cByRefStatus = cByRef.status;
      console.log("  HTTP", cByRef.status, cByRef.status >= 400 ? "(exploratory — does not block)" : "");
      saveResponse("C-by-reference", cByRef);
    } catch (e) {
      write("C-by-reference-response.json", { note: "request threw (non-blocking)", error: redactKey(String(e)) });
    }
  } else {
    console.log("== C2: skipped (list lookup needs element_size + page; pass --try-list-lookup to probe) ==");
  }

  // ---- D ---- (opt-in; not part of the approved run)
  if (ARGS.includeD) {
    console.log("== D: POST /v1/orders (same custom_amount decision as A, NEW ref id) ==");
    const D = await sodaFetch("POST", "/v1/orders", selection.calls.D);
    console.log("  HTTP", D.status);
    saveResponse("D", D);
  }

  // ---- E ----
  if (ARGS.includeE && range) {
    console.log("== E: POST /v1/orders (RANGE + custom_amount = min_amount, NEW ref id) ==");
    const E = await sodaFetch("POST", "/v1/orders", selection.calls.E);
    console.log("  HTTP", E.status);
    saveResponse("E", E);
  }

  // ---- balance after ----
  const balAfter = await sodaFetch("GET", "/v1/accounts/balance");
  write("balance-after.json", { httpStatus: balAfter.status, body: redactDeep(balAfter.json) });

  write("summary.json", {
    capturedAt: new Date().toISOString(),
    runId: RUN_ID,
    baseUrl: BASE_URL,
    externalReferenceIds: REF,
    fixedProductId: fixed.id,
    rangeProductId: range?.id ?? null,
    http: {
      A: A.status, B: B.status,
      C1_byId: cByIdStatus,
      C2_byReference: cByRefStatus,
      D: ARGS.includeD ? "see D-response.json" : "skipped",
      E: ARGS.includeE ? "see E-response.json" : "skipped",
    },
    selectedFixedProduct: relevantFields(fixed),
    customAmount: { include: ca.value !== undefined, value: ca.value ?? null, source: ca.source },
    request: { elementSize: ARGS.elementSize },
    listLookupContract:
      "UNRESOLVED — needs element_size AND page; page indexing (0- vs 1-based) TBD from SodaGift OpenAPI. Use GET /v1/orders/{id}.",
    orderIdFromA: pickId(A.json) ?? null,
    orderIdFromB: pickId(B.json) ?? null,
    idempotencyLooksOk: pickId(A.json) !== undefined && pickId(A.json) === pickId(B.json),
    balanceBefore: (balBefore.json as Record<string, unknown>)?.amount ?? null,
    balanceAfter: (balAfter.json as Record<string, unknown>)?.amount ?? null,
    notes: [
      "Baseline product: plain USD GIFT_CARD (payment-card-like products excluded after #50005 -> HTTP 500).",
      "custom_amount is PRODUCT-SPECIFIC: #50005 requires it, #99001 forbids it. Decision + source in `customAmount`.",
      "C1 (GET /v1/orders/{id}) is authoritative. C2 (list by external_reference_id) is OFF by default and never blocks.",
      "List lookup needs element_size AND page; page indexing not guessed — check OpenAPI.",
      "500 errorCode=unhandled_error is NOT retried (only order_retry_needed is).",
      "LINK delivery NOT probed here — separate probe, contract not yet known.",
      "Secret-looking values redacted in *-response.json; errorCode/message/status kept; key names kept.",
      "Paste summary.json + *-response.json + 00-selection.json back for the Phase 1 order-contract review.",
    ],
  });

  console.log("\nDone. Review scratchpad/sodagift-probe-order/ and paste the files back.");
}

main().catch((err) => {
  console.error("probe failed:", redactKey(String(err?.stack ?? err)));
  process.exit(1);
});
