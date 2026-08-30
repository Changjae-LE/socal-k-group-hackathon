// Server-only SodaGift catalog access for the country-selection proof.
// - listProducts(): GET /v1/products (cached in-memory, short TTL)
// - selectableCountries(): countries DERIVED from the live catalog (never hardcoded)
// - productsForCountry(): the exact MVP filter (country + ON_SALE + LINK)
// - toPublicProduct(): non-sensitive display shape (no key, no pricing internals,
//   no custom_amount ordering hint)

import "server-only";
import { sodaGetJson } from "@/lib/sodagift/client";
import { parseProducts, type SgProduct } from "@/lib/sodagift/schemas";

const MVP_DELIVERY_METHOD = "LINK";
const ON_SALE = "ON_SALE";
const CACHE_TTL_MS = 15 * 60_000;

type Cache = { at: number; products: SgProduct[] };
let cache: Cache | null = null;

/** Full catalog, cached in-process for CACHE_TTL_MS. Server-side only. */
export async function listProducts(opts: { force?: boolean } = {}): Promise<SgProduct[]> {
  if (!opts.force && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.products;
  }
  const raw = await sodaGetJson("/v1/products");
  const { products, dropped } = parseProducts(raw);
  if (dropped > 0) {
    console.warn(`SodaGift catalog: dropped ${dropped} unparseable product row(s)`);
  }
  cache = { at: Date.now(), products };
  return products;
}

// ISO code -> English region name. This is the ONLY code->name mapping; there is no
// maintained supported-country list.
const REGION_NAMES = new Intl.DisplayNames(["en"], { type: "region" });
export function countryLabel(code: string): string {
  try {
    return REGION_NAMES.of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * Campaign-derived catalog constraints. All optional; the defaults are the MVP invariant
 * (ON_SALE + LINK, any type, any country).
 */
export type CampaignCatalogFilter = {
  requiredDeliveryMethod?: string; // default "LINK"
  allowedProductTypes?: string[]; // [] / undefined = any SodaGift `type`
  eligibleCountries?: string[]; // [] / undefined = any country (global campaign)
};

function matches(p: SgProduct, f: CampaignCatalogFilter): boolean {
  if (p.availability !== ON_SALE) return false;
  if (!p.available_delivery_method.includes(f.requiredDeliveryMethod ?? MVP_DELIVERY_METHOD)) {
    return false;
  }
  if (f.allowedProductTypes && f.allowedProductTypes.length > 0 && !f.allowedProductTypes.includes(p.type)) {
    return false;
  }
  if (f.eligibleCountries && f.eligibleCountries.length > 0 && !f.eligibleCountries.includes(p.country_code)) {
    return false;
  }
  return true;
}

export type CountryOption = { code: string; label: string; productCount: number };

/** Countries DERIVED from the live catalog for a campaign's constraints — never hardcoded. */
export function selectableCountries(
  products: SgProduct[],
  filter: CampaignCatalogFilter = {},
): CountryOption[] {
  const count = new Map<string, number>();
  for (const p of products) {
    if (!matches(p, filter)) continue;
    count.set(p.country_code, (count.get(p.country_code) ?? 0) + 1);
  }
  return [...count.entries()]
    .map(([code, productCount]) => ({ code, label: countryLabel(code), productCount }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** True if `code` is currently selectable for the campaign. */
export function isSelectableCountry(
  products: SgProduct[],
  code: string,
  filter: CampaignCatalogFilter = {},
): boolean {
  return products.some((p) => p.country_code === code && matches(p, filter));
}

/** Products shown for a selected country: country match + the campaign's catalog constraints. */
export function productsForCountry(
  products: SgProduct[],
  countryCode: string,
  filter: CampaignCatalogFilter = {},
): SgProduct[] {
  return products.filter((p) => p.country_code === countryCode && matches(p, filter));
}

/** Non-sensitive product view for the browser. No API key. No pricing internals. */
export type PublicProduct = {
  id: number;
  name: string;
  brandName: string | null;
  imageUrl: string | null;
  countryCode: string;
  currency: string;
  amount: number | null;
  minAmount: number | null;
  maxAmount: number | null;
  amountKind: "FIXED" | "RANGE" | "UNKNOWN"; // catalog info only — NOT a custom_amount rule
  deliveryMethods: string[];
  productType: string;
};

export function toPublicProduct(p: SgProduct): PublicProduct {
  const amountKind: PublicProduct["amountKind"] =
    p.amount != null
      ? "FIXED"
      : p.min_amount != null && p.max_amount != null
        ? "RANGE"
        : "UNKNOWN";
  return {
    id: p.id,
    name: p.name,
    brandName: p.brand?.name ?? null,
    imageUrl: p.image_url && p.image_url.length > 0 ? p.image_url : null,
    countryCode: p.country_code,
    currency: p.currency,
    amount: p.amount,
    minAmount: p.min_amount,
    maxAmount: p.max_amount,
    amountKind,
    deliveryMethods: p.available_delivery_method,
    productType: p.type,
  };
}
