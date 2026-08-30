import Link from "next/link";
import { notFound } from "next/navigation";
import { getCampaignByPublicId, isJoinable } from "@/lib/campaign/queries";
import { parseRewardPolicy, summarizeRewardPolicy } from "@/lib/campaign/policy";
import { statusLabel } from "@/lib/format";
import { env } from "@/lib/env";
import { startCampaignLogin } from "./actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const twitchButton: React.CSSProperties = {
  background: "#9146ff",
  color: "#fff",
  border: "none",
  padding: "0.7rem 1.15rem",
  borderRadius: 8,
  fontWeight: 600,
  fontSize: "1rem",
  cursor: "pointer",
};

export default async function CampaignPage({
  params,
}: {
  params: Promise<{ publicId: string }>;
}) {
  const { publicId } = await params;
  const campaign = await getCampaignByPublicId(publicId);
  if (!campaign) notFound();

  const policy = parseRewardPolicy(campaign.rewardPolicy);
  const publicUrl = `${env().APP_URL}/c/${campaign.publicId}`;
  const joinable = isJoinable(campaign);

  return (
    <main>
      <h1>{campaign.name}</h1>
      <p style={{ color: "#52525b" }}>
        {campaign.isGlobal
          ? "Open to participants worldwide (where SodaGift rewards are available)."
          : `Eligible countries: ${campaign.eligibleCountries.join(", ") || "—"}`}
      </p>

      <ul style={{ color: "#3f3f46", lineHeight: 1.7 }}>
        <li>Reward: {policy ? summarizeRewardPolicy(policy) : "—"}</li>
        <li>Delivery: {campaign.requiredDeliveryMethod}</li>
        <li>Winners: {campaign.winnerCount}</li>
        <li>Status: {campaign.status} ({statusLabel(campaign.status)})</li>
      </ul>

      {joinable ? (
        <form action={startCampaignLogin.bind(null, campaign.publicId)} style={{ margin: "1.5rem 0" }}>
          <button type="submit" style={twitchButton}>
            Continue with Twitch
          </button>
        </form>
      ) : campaign.status === "DRAWN" ? (
        <p style={{ margin: "1.5rem 0" }}>
          Winners have been drawn.{" "}
          <Link href={`/c/${campaign.publicId}/result`}>See the results</Link>.
        </p>
      ) : (
        <p style={{ margin: "1.5rem 0", color: "#b91c1c" }}>
          Entries are closed for this campaign.
        </p>
      )}

      <section
        style={{
          marginTop: "2rem",
          padding: "1rem 1.15rem",
          border: "1px solid #e4e4e7",
          borderRadius: 10,
          background: "#fff",
        }}
      >
        <h2 style={{ fontSize: "1rem", marginTop: 0 }}>Display on stream</h2>
        <p style={{ margin: "0 0 0.75rem", color: "#71717a", fontSize: "0.9rem" }}>
          The QR code encodes only this public URL.
        </p>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`/api/c/${campaign.publicId}/qr.png`}
          alt={`QR code for ${publicUrl}`}
          width={220}
          height={220}
          style={{ width: 220, height: 220, imageRendering: "pixelated" }}
        />
        <p style={{ marginBottom: 0 }}>
          <code>{publicUrl}</code>
        </p>
      </section>
    </main>
  );
}
