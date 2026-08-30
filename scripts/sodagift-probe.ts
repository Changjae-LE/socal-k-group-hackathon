/**
 * scripts/sodagift-probe.ts  —  DEV ONLY, run locally by the project owner.
 *
 * Purpose: capture and validate the SodaGift SANDBOX contract so the Phase 1
 * Zod schemas are built from real data, not guesses.
 *
 * It ONLY performs read-only GET calls:
 *   - GET /v1/accounts/balance
 *   - GET /v1/products
 * and then inspects the product schema, `available_delivery_method`, and
 * `recipient_info_provided_by`.
 *
 * It DOES NOT create an order. It never prints the API key.
 *
 * Auth: SODA-API-KEY: <key>  header on every request. No Authorization: Bearer.
 *
 * Run (from C:\soda):
 *   npx --yes tsx scripts/sodagift-probe.ts
 *
 * Requires: Node 18+ (global fetch). Reads SODAGIFT_BASE_URL / SODAGIFT_API_KEY
 * from .env.local (or the real environment, which takes precedence).
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(REPO_ROOT, "scratchpad", "sodagift-probe");

// ---------------------------------------------------------------------------
// env loading (.env.local), without adding a dependency
// ---------------------------------------------------------------------------
function loadEnvLocal(): void {
  const p = join(REPO_ROOT, ".env.local");
  if (!existsSync(p)) return;
  for (const raw of readFileSync(p, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadEnvLocal();

const BASE_URL = (process.env.SODAGIFT_BASE_URL ?? "").replace(/\/+$/, "");
const API_KEY = process.env.SODAGIFT_API_KEY ?? "";

if (!BASE_URL || !API_KEY) {
  console.error(
    "Missing SODAGIFT_BASE_URL or SODAGIFT_API_KEY (set them in .env.local).",
  );
  process.exit(1);
}

const maskedKey =
  API_KEY.length > 12
    ? `${API_KEY.slice(0, 13)}…${API_KEY.slice(-4)} (len ${API_KEY.length})`
    : `set (len ${API_KEY.length})`;

/** Remove the key if it ever appears in any string we are about to print/write. */
function redact(s: string): string {
  return API_KEY ? s.split(API_KEY).join("<SODA-API-KEY:redacted>") : s;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
async function sodaGet(path: string): Promise<{
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  bodyText: string;
  json: unknown;
}> {
  const url = `${BASE_URL}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "SODA-API-KEY": API_KEY, // <-- verified auth mechanism, no Bearer
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    const bodyText = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(bodyText);
    } catch {
      /* leave as null; keep bodyText */
    }
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k] = v));
    return { status: res.status, ok: res.ok, headers, bodyText, json };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// helpers for schema inspection
// ---------------------------------------------------------------------------
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Best-effort: find the product array regardless of envelope shape. */
function extractProductArray(root: unknown): unknown[] {
  if (Array.isArray(root)) return root;
  if (isObj(root)) {
    for (const key of ["data", "products", "items", "results", "content", "list"]) {
      const v = root[key];
      if (Array.isArray(v)) return v;
      if (isObj(v) && Array.isArray(v.products)) return v.products as unknown[];
      if (isObj(v) && Array.isArray(v.items)) return v.items as unknown[];
    }
    // single object that looks like a product
    if ("id" in root || "product_id" in root || "productId" in root) return [root];
  }
  return [];
}

/** Recursively collect all values seen for a given key name, anywhere in the tree. */
function collectValuesForKey(node: unknown, keyName: string, acc: Set<string>): void {
  if (Array.isArray(node)) {
    for (const el of node) collectValuesForKey(el, keyName, acc);
    return;
  }
  if (!isObj(node)) return;
  for (const [k, v] of Object.entries(node)) {
    if (k === keyName) {
      if (Array.isArray(v)) v.forEach((x) => acc.add(JSON.stringify(x)));
      else acc.add(JSON.stringify(v));
    }
    collectValuesForKey(v, keyName, acc);
  }
}

function keyUnion(items: unknown[]): string[] {
  const s = new Set<string>();
  for (const it of items) if (isObj(it)) Object.keys(it).forEach((k) => s.add(k));
  return [...s].sort();
}

function typeShape(items: unknown[]): Record<string, string> {
  const shape: Record<string, Set<string>> = {};
  for (const it of items) {
    if (!isObj(it)) continue;
    for (const [k, v] of Object.entries(it)) {
      (shape[k] ??= new Set()).add(
        v === null ? "null" : Array.isArray(v) ? "array" : typeof v,
      );
    }
  }
  return Object.fromEntries(
    Object.entries(shape).map(([k, set]) => [k, [...set].sort().join(" | ")]),
  );
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  console.log("SodaGift sandbox probe");
  console.log("  base URL :", BASE_URL);
  console.log("  api key  :", maskedKey);
  console.log("  auth hdr : SODA-API-KEY (no Authorization: Bearer)");
  console.log("  out dir  :", OUT_DIR);
  console.log("");

  // 1) balance -------------------------------------------------------------
  console.log("== GET /v1/accounts/balance ==");
  const balance = await sodaGet("/v1/accounts/balance");
  console.log("  HTTP", balance.status);
  console.log("  body:", redact(balance.bodyText).slice(0, 800));
  writeFileSync(
    join(OUT_DIR, "balance.raw.json"),
    redact(balance.bodyText || "null"),
  );
  console.log("");

  // 2) products ---------------------------------------------------------------
  console.log("== GET /v1/products ==");
  const products = await sodaGet("/v1/products");
  console.log("  HTTP", products.status);
  writeFileSync(
    join(OUT_DIR, "products.raw.json"),
    redact(products.bodyText || "null"),
  );

  if (!products.ok || products.json == null) {
    console.error(
      "  products call did not return usable JSON; inspect products.raw.json",
    );
    process.exitCode = 1;
    return;
  }

  const arr = extractProductArray(products.json);
  console.log("  product count:", arr.length);
  console.log("  envelope top-level keys:", isObj(products.json) ? Object.keys(products.json) : "(array)");

  const union = keyUnion(arr);
  const shape = typeShape(arr);
  console.log("");
  console.log("  product field union:");
  for (const k of union) console.log(`    - ${k}: ${shape[k] ?? "?"}`);

  // 3) delivery methods + recipient_info_provided_by ------------------------
  const deliveryMethods = new Set<string>();
  const recipientInfoProvidedBy = new Set<string>();
  collectValuesForKey(products.json, "available_delivery_method", deliveryMethods);
  collectValuesForKey(products.json, "availableDeliveryMethod", deliveryMethods);
  collectValuesForKey(products.json, "recipient_info_provided_by", recipientInfoProvidedBy);
  collectValuesForKey(products.json, "recipientInfoProvidedBy", recipientInfoProvidedBy);

  console.log("");
  console.log("  distinct available_delivery_method values:");
  console.log(
    deliveryMethods.size
      ? [...deliveryMethods].map((v) => `    - ${v}`).join("\n")
      : "    (key not found — check products.raw.json for the real field name)",
  );
  console.log("");
  console.log("  distinct recipient_info_provided_by values:");
  console.log(
    recipientInfoProvidedBy.size
      ? [...recipientInfoProvidedBy].map((v) => `    - ${v}`).join("\n")
      : "    (key not found — check products.raw.json for the real field name)",
  );

  // 4) per-product summary -------------------------------------------------
  const perProduct = arr.map((p) => {
    const o = isObj(p) ? p : {};
    return {
      id: o.id ?? o.product_id ?? o.productId ?? null,
      name: o.name ?? o.product_name ?? o.title ?? null,
      brand: o.brand ?? o.brand_name ?? null,
      currency: o.currency ?? o.currency_code ?? null,
      price: o.price ?? o.face_value ?? o.amount ?? null,
      available_delivery_method:
        o.available_delivery_method ?? o.availableDeliveryMethod ?? null,
      recipient_info_provided_by:
        o.recipient_info_provided_by ?? o.recipientInfoProvidedBy ?? null,
    };
  });
  writeFileSync(
    join(OUT_DIR, "products.per-product-summary.json"),
    redact(JSON.stringify(perProduct, null, 2)),
  );

  // 5) machine-readable summary for the Phase 1 review --------------------
  const summary = {
    capturedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    balance: {
      httpStatus: balance.status,
      body: (() => {
        try {
          return JSON.parse(redact(balance.bodyText));
        } catch {
          return redact(balance.bodyText);
        }
      })(),
    },
    products: {
      httpStatus: products.status,
      envelopeTopLevelKeys: isObj(products.json)
        ? Object.keys(products.json)
        : null,
      count: arr.length,
      fieldUnion: union,
      fieldTypes: shape,
      distinctAvailableDeliveryMethod: [...deliveryMethods].map((s) => JSON.parse(s)),
      distinctRecipientInfoProvidedBy: [...recipientInfoProvidedBy].map((s) =>
        JSON.parse(s),
      ),
      sampleProduct: arr[0] ?? null,
    },
    notes: [
      "No order was created. LINK order payload intentionally NOT probed.",
      "If a *_delivery_method / recipient_info_* key was not found, the real field name differs — read products.raw.json.",
    ],
  };
  writeFileSync(
    join(OUT_DIR, "summary.json"),
    redact(JSON.stringify(summary, null, 2)),
  );

  console.log("");
  console.log("Wrote:");
  console.log("  ", join(OUT_DIR, "balance.raw.json"));
  console.log("  ", join(OUT_DIR, "products.raw.json"));
  console.log("  ", join(OUT_DIR, "products.per-product-summary.json"));
  console.log("  ", join(OUT_DIR, "summary.json"));
  console.log("");
  console.log("Next: paste summary.json (or the 4 files) back for Phase 1 schema review.");
}

main().catch((err) => {
  console.error("probe failed:", redact(String(err?.stack ?? err)));
  process.exit(1);
});
