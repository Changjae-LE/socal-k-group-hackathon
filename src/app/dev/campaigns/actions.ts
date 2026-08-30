"use server";

import { notFound, redirect } from "next/navigation";
import { createCampaign } from "@/lib/campaign/queries";
import { RewardPolicy } from "@/lib/campaign/policy";

function devOnly() {
  if (process.env.NODE_ENV === "production") notFound();
}

function csv(v: FormDataEntryValue | null): string[] {
  return String(v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function createCampaignDevAction(formData: FormData): Promise<void> {
  devOnly();

  const isGlobal = formData.get("isGlobal") === "on";
  const kind = String(formData.get("policyKind") ?? "TARGET_VALUE");
  const currency = String(formData.get("policyCurrency") ?? "USD").toUpperCase();
  const num = (k: string) => Number(formData.get(k));

  let rawPolicy: unknown;
  if (kind === "VALUE_RANGE") {
    rawPolicy = { kind, min: num("policyMin"), max: num("policyMax"), currency };
  } else {
    rawPolicy = { kind, amount: num("policyAmount"), currency };
  }
  const rewardPolicy = RewardPolicy.parse(rawPolicy);

  const campaign = await createCampaign({
    name: String(formData.get("name") ?? ""),
    isGlobal,
    eligibleCountries: csv(formData.get("eligibleCountries")),
    allowedProductTypes: csv(formData.get("allowedProductTypes")),
    rewardPolicy,
    rewardSelectionMode:
      (formData.get("rewardSelectionMode") as
        | "PARTICIPANT_PRECHOICE"
        | "WINNER_CHOICE"
        | "BACKEND_SELECT"
        | null) ?? "BACKEND_SELECT",
    claimLinkMode:
      (formData.get("claimLinkMode") as "PROTECTED_TOKEN" | "SODAGIFT_DIRECT" | null) ??
      "PROTECTED_TOKEN",
    winnerCount: Number(formData.get("winnerCount") ?? 1),
    status: "OPEN",
  });

  redirect(`/c/${campaign.publicId}`);
}
