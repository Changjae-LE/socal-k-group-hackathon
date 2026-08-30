// Zod schemas for the SodaGift catalog (from real sandbox data — CLAUDE.md §11).
// Lenient (`.passthrough()`); delivery/recipient arrays are `string[]` (data-driven).
// Parsing is per-row + drop-invalid so one bad product can't break the whole list.

import { randomBytes } from "node:crypto";
import { z } from "zod";

// Idempotency key for POST /v1/orders. SodaGift enforces STRICTLY alphanumeric
// (sandbox 400s on a hyphen) — no `-`, `_`, space. Reused unchanged on every retry (§11).
export const SG_EXTERNAL_REF_RE = /^[A-Za-z0-9]{1,100}$/;
export function newExternalReferenceId(): string {
  return "sgl" + randomBytes(16).toString("hex"); // 35 chars, alphanumeric
}

export const SgBrand = z
  .object({
    id: z.number().int().optional(),
    name: z.string().optional(),
    name_ko: z.string().nullish(),
    name_ja: z.string().nullish(),
    image_url: z.string().nullish(),
  })
  .passthrough();

export const SgCategory = z
  .object({
    id: z.number().int().optional(),
    name: z.string().optional(),
  })
  .passthrough();

export const SgProduct = z
  .object({
    id: z.number().int(),
    name: z.string(),
    name_ko: z.string().nullish(),
    name_ja: z.string().nullish(),
    country_code: z.string().min(2).max(3),
    availability: z.string(), // sandbox: "ON_SALE"
    currency: z.string().min(3).max(3),
    amount: z.number().nullable(),
    min_amount: z.number().nullable(),
    max_amount: z.number().nullable(),
    image_url: z.string().nullish(),
    validity: z.number().nullish(),
    type: z.string(), // GIFT_CARD | MERCHANDISE | DIGITAL_VOUCHER (+ future)
    available_delivery_method: z.array(z.string()),
    recipient_info_provided_by: z.array(z.string()).optional(),
    brand: SgBrand.nullish(),
    category: SgCategory.nullish(),
  })
  .passthrough();

export type SgProduct = z.infer<typeof SgProduct>;

export const SgProductsEnvelope = z
  .object({
    products: z.array(z.unknown()),
    total_elements: z.number().int().optional(),
  })
  .passthrough();

/** Parse the /v1/products envelope; keep only rows that match SgProduct. */
export function parseProducts(raw: unknown): { products: SgProduct[]; dropped: number } {
  const env = SgProductsEnvelope.safeParse(raw);
  if (!env.success) {
    throw new Error("SodaGift /v1/products: unexpected envelope shape");
  }
  const products: SgProduct[] = [];
  let dropped = 0;
  for (const row of env.data.products) {
    const parsed = SgProduct.safeParse(row);
    if (parsed.success) products.push(parsed.data);
    else dropped += 1;
  }
  return { products, dropped };
}
