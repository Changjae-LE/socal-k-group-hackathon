"use server";

import { redirect } from "next/navigation";
import { refreshProof } from "@/lib/auth/proof-session";
import { clearCampaignContext, readCampaignContext } from "@/lib/campaign/context";
import { getCampaignByPublicId, isJoinable } from "@/lib/campaign/queries";

// Extend the proof session so the multi-step browse fits comfortably.
// This only changes the cookie's TTL — not the OIDC verification flow.
const PROOF_TTL_SECONDS = 30 * 60;

/** [ Continue ] on /auth/result — hand off to the campaign-scoped country page. */
export async function continueToCountry(): Promise<void> {
  const session = await refreshProof(PROOF_TTL_SECONDS);
  if (!session) redirect("/");

  // Campaign context is a hint from the `sl_campaign` cookie — re-validate against the DB.
  const publicId = await readCampaignContext();
  if (!publicId) redirect("/"); // identity proven, but no campaign to continue into

  const campaign = await getCampaignByPublicId(publicId);
  if (!campaign || !isJoinable(campaign)) {
    await clearCampaignContext();
    redirect("/");
  }

  redirect(`/c/${campaign.publicId}/country`);
}
