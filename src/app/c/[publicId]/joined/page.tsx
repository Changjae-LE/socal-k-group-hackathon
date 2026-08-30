import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { readProof } from "@/lib/auth/proof-session";
import { readCampaignContext } from "@/lib/campaign/context";
import { getCampaignByPublicId, getParticipant } from "@/lib/campaign/queries";
import { countryLabel } from "@/lib/sodagift/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function JoinedPage({
  params,
}: {
  params: Promise<{ publicId: string }>;
}) {
  const { publicId } = await params;

  const campaign = await getCampaignByPublicId(publicId);
  if (!campaign) notFound();

  const session = await readProof();
  if (!session) redirect(`/c/${campaign.publicId}`);

  const ctx = await readCampaignContext();
  if (ctx !== campaign.publicId) redirect(`/c/${campaign.publicId}`);

  // Load the single participation row (verified sub + server-resolved campaign id).
  const participant = await getParticipant(campaign.id, session.sub);
  if (!participant) redirect(`/c/${campaign.publicId}/country`);

  return (
    <main>
      <h1>Joined successfully</h1>
      <dl style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "0.4rem 1rem", marginTop: "1rem" }}>
        <dt style={{ color: "#71717a" }}>Campaign:</dt>
        <dd style={{ margin: 0, fontWeight: 600 }}>{campaign.name}</dd>

        <dt style={{ color: "#71717a" }}>Twitch User ID:</dt>
        <dd style={{ margin: 0 }}>
          <code>{session.sub}</code>
        </dd>

        <dt style={{ color: "#71717a" }}>Country:</dt>
        <dd style={{ margin: 0 }}>
          {countryLabel(participant.countryCode)} ({participant.countryCode})
        </dd>
      </dl>

      <p style={{ color: "#71717a", fontSize: "0.9rem", marginTop: "1rem" }}>
        Your Twitch User ID is the verified OIDC <code>sub</code> from your sign-in — it is
        never entered by hand. Winners will be drawn on the backend later.
      </p>

      <p>
        <Link href={`/c/${campaign.publicId}`}>Back to campaign</Link>
      </p>
    </main>
  );
}
