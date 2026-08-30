// Product-order-contract resolver (CLAUDE.md §11). Given a LIVE SodaGift catalog product and
// the campaign's reward policy, decide HOW that product would be ordered — or refuse.
//
// The ONLY thing that decides whether `item.custom_amount` is sent is the product's amount
// model (verified: #99001 fixed → FORBIDDEN, #50005 variable → REQUIRED). We never invent a
// request: if a safe contract can't be determined, we return `{ orderable: false, reason }`
// and the winner sees a fulfillment-unavailable state instead of a fabricated order.

import "server-only";
import type { SgProduct } from "@/lib/sodagift/schemas";
import type { RewardPolicy } from "@/lib/campaign/policy";

const ON_SALE = "ON_SALE";
const LINK = "LINK";

export type OrderContract =
  | {
      orderable: true;
      item: { id: number; custom_amount?: number };
      customAmountMode: "FORBIDDEN" | "REQUIRED";
      rewardAmount: number;
      rewardCurrency: string;
    }
  | { orderable: false; reason: string };

/** A single winner's target reward value, in the policy's reference currency. */
function policyTarget(policy: RewardPolicy | null): { amount: number; currency: string } | null {
  if (!policy) return null;
  switch (policy.kind) {
    case "TARGET_VALUE":
    case "BUDGET_PER_WINNER":
      return { amount: policy.amount, currency: policy.currency };
    case "VALUE_RANGE":
      return { amount: (policy.min + policy.max) / 2, currency: policy.currency };
    default:
      return null;
  }
}

export function resolveOrderContract(args: {
  product: SgProduct;
  policy: RewardPolicy | null;
  allowedProductTypes: string[];
  countryCode: string;
}): OrderContract {
  const { product: p, policy, allowedProductTypes, countryCode } = args;

  if (p.country_code !== countryCode) {
    return { orderable: false, reason: `This product isn't available in ${countryCode}.` };
  }
  if (p.availability !== ON_SALE) {
    return { orderable: false, reason: "This product is no longer on sale." };
  }
  if (!p.available_delivery_method.includes(LINK)) {
    return { orderable: false, reason: "This product no longer supports link delivery." };
  }
  if (allowedProductTypes.length > 0 && !allowedProductTypes.includes(p.type)) {
    return { orderable: false, reason: `Product type ${p.type} isn't allowed for this campaign.` };
  }

  const isFixed = p.amount != null && p.min_amount == null && p.max_amount == null;
  const isRange = p.amount == null && p.min_amount != null && p.max_amount != null;

  // FIXED — fully verified (probe 1.c, #99001). custom_amount MUST be omitted.
  if (isFixed) {
    return {
      orderable: true,
      item: { id: p.id },
      customAmountMode: "FORBIDDEN",
      rewardAmount: p.amount as number,
      rewardCurrency: p.currency,
    };
  }

  // RANGE — needs item.custom_amount. We only send one when we can determine a SAFE value:
  //  * the campaign policy target must be in the SAME currency as the product (there is no
  //    verified cross-currency conversion), and
  //  * the value must sit inside [min_amount, max_amount].
  // Otherwise refuse rather than guess an amount.
  if (isRange) {
    const target = policyTarget(policy);
    if (!target) {
      return {
        orderable: false,
        reason: "This reward needs a chosen amount and the campaign has no value policy to derive one.",
      };
    }
    if (target.currency !== p.currency) {
      return {
        orderable: false,
        reason:
          `Automatic amount selection for ${p.currency} products isn't supported yet ` +
          `(the campaign's reward policy is set in ${target.currency}).`,
      };
    }
    const min = p.min_amount as number;
    const max = p.max_amount as number;
    // Clamp into range, keep 2 decimals (SodaGift's accepted decimal scale is otherwise unverified).
    const amount = Math.round(Math.min(Math.max(target.amount, min), max) * 100) / 100;
    if (!(amount >= min && amount <= max)) {
      return { orderable: false, reason: "Couldn't determine a valid amount within the product's range." };
    }
    return {
      orderable: true,
      item: { id: p.id, custom_amount: amount },
      customAmountMode: "REQUIRED",
      rewardAmount: amount,
      rewardCurrency: p.currency,
    };
  }

  return { orderable: false, reason: "Unrecognized product amount model (neither fixed nor ranged)." };
}
