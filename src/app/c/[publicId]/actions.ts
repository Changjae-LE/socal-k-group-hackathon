"use server";

import { notFound, redirect } from "next/navigation";
import { readProof } from "@/lib/auth/proof-session";
import { readCampaignContext, setCampaignContext } from "@/lib/campaign/context";
import {
  campaignCatalogFilter,
  getCampaignByPublicId,
  isJoinable,
  joinCampaign,
} from "@/lib/campaign/queries";
import { isSelectableCountry, listProducts } from "@/lib/sodagift/catalog";

/**
 * "Continue with Twitch" on /c/[publicId].
 * Re-validates the campaign against the DB, stashes ONLY the publicId in the encrypted
 * `sl_campaign` cookie, then hands off to the (unmodified) Twitch OIDC login route.
 */
export async function startCampaignLogin(publicId: string): Promise<void> {
  const campaign = await getCampaignByPublicId(publicId);
  if (!campaign || !isJoinable(campaign)) {
    redirect(`/c/${encodeURIComponent(publicId)}`);
  }
  await setCampaignContext(campaign.publicId);
  redirect("/api/auth/twitch/login");
}

/**
 * "Join Giveaway" on /c/[publicId]/rewards.
 *
 *  - twitchUserId  = verified OIDC `sub` (from the sl_proof cookie) ONLY — never from
 *                    form fields / query params / JS / display name.
 *  - campaignId    = resolved server-side from Campaign.publicId.
 *  - countryCode   = re-validated server-side against the campaign's eligible SodaGift
 *                    countries before anything is persisted.
 *
 * Duplicate joins return the existing participation; UNIQUE(campaignId, twitchUserId)
 * guarantees no second row.
 */
export async function joinGiveaway(publicId: string, countryParam: string): Promise<void> {
  // 1. Participant identity — verified OIDC sub only.
  const session = await readProof();
  if (!session) redirect(`/c/${encodeURIComponent(publicId)}`);

  // 2. Campaign — resolved from the DB by publicId; must be OPEN to join.
  const campaign = await getCampaignByPublicId(publicId);
  if (!campaign) notFound();
  if (!isJoinable(campaign)) {
    // CLOSED / DRAWN / DRAFT — joining is rejected.
    redirect(`/c/${campaign.publicId}`);
  }

  // 3. The sl_campaign cookie is a transport hint; it must match, but the DB row above is
  //    authoritative.
  const ctx = await readCampaignContext();
  if (ctx !== campaign.publicId) redirect(`/c/${campaign.publicId}`);

  // 4. Country — re-validate against the live catalog + campaign constraints.
  const countryCode = String(countryParam ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    redirect(`/c/${campaign.publicId}/country?e=bad_country`);
  }
  const eligible = isSelectableCountry(
    await listProducts(),
    countryCode,
    campaignCatalogFilter(campaign),
  );
  if (!eligible) redirect(`/c/${campaign.publicId}/country?e=bad_country`);

  // 5. Persist (idempotent).
  await joinCampaign({
    campaignId: campaign.id,
    twitchUserId: session.sub,
    countryCode,
  });

  redirect(`/c/${campaign.publicId}/joined`);
}
