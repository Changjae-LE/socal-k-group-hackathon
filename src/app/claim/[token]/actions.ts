"use server";

import { redirect } from "next/navigation";
import { readProof } from "@/lib/auth/proof-session";
import { clearClaimContext, setClaimContext } from "@/lib/campaign/claim-context";
import { fulfillClaim } from "@/lib/campaign/fulfillment";

/** "Verify with Twitch" on /claim/[token] — stash the token, hand off to participant OIDC. */
export async function startClaimLogin(token: string): Promise<void> {
  await setClaimContext(token);
  redirect("/api/auth/twitch/login");
}

/** "Claim this reward" — the verified winner picked a product from their country's catalog. */
export async function claimReward(token: string, formData: FormData): Promise<void> {
  const session = await readProof();
  if (!session) {
    await setClaimContext(token);
    redirect("/api/auth/twitch/login");
  }

  const productId = Number(formData.get("productId"));
  if (!Number.isInteger(productId) || productId <= 0) {
    redirect(`/claim/${encodeURIComponent(token)}?e=pick_a_reward`);
  }

  const result = await fulfillClaim({ rawToken: token, sub: session.sub, productId });

  if (result.ok) {
    await clearClaimContext();
    redirect(`/claim/${encodeURIComponent(token)}?ok=1`);
  }
  redirect(`/claim/${encodeURIComponent(token)}?e=${encodeURIComponent(result.error)}`);
}
