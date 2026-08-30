// Country-agnostic reward policy stored on Campaign.rewardPolicy (Json).
// The `currency` is a REFERENCE currency for cross-country comparison; each winner's
// actual product currency is their country's.

import { z } from "zod";

export const RewardPolicy = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("TARGET_VALUE"),
    amount: z.number().positive(),
    currency: z.string().length(3),
  }),
  z.object({
    kind: z.literal("VALUE_RANGE"),
    min: z.number().positive(),
    max: z.number().positive(),
    currency: z.string().length(3),
  }),
  z.object({
    kind: z.literal("BUDGET_PER_WINNER"),
    amount: z.number().positive(),
    currency: z.string().length(3),
  }),
]);

export type RewardPolicy = z.infer<typeof RewardPolicy>;

/** Parse an unknown JSON value (e.g. from the DB) into a RewardPolicy, or null. */
export function parseRewardPolicy(value: unknown): RewardPolicy | null {
  const r = RewardPolicy.safeParse(value);
  return r.success ? r.data : null;
}

export function summarizeRewardPolicy(p: RewardPolicy): string {
  switch (p.kind) {
    case "TARGET_VALUE":
      return `~${p.amount} ${p.currency} per winner`;
    case "VALUE_RANGE":
      return `${p.min}–${p.max} ${p.currency} per winner`;
    case "BUDGET_PER_WINNER":
      return `budget ${p.amount} ${p.currency} per winner`;
  }
}
