import { notFound } from "next/navigation";
import { countParticipants, getCampaignByPublicId } from "@/lib/campaign/queries";
import { statusLabel } from "@/lib/format";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Public — NO participant authentication required to view.
export default async function DisplayPage({
  params,
}: {
  params: Promise<{ publicId: string }>;
}) {
  const { publicId } = await params;
  const campaign = await getCampaignByPublicId(publicId);
  if (!campaign) notFound();

  const count = await countParticipants(campaign.id);
  const joinUrl = `${env().APP_URL}/c/${campaign.publicId}`; // the ONLY thing the QR encodes

  return (
    <>
      {/* simple server-side poll: refresh the participant count every 10s */}
      <meta httpEquiv="refresh" content="10" />

      <div style={{ maxWidth: 900, width: "100%" }}>
        <div style={{ fontSize: "clamp(1.6rem, 5vw, 3.5rem)", fontWeight: 800, lineHeight: 1.1 }}>
          {campaign.name}
        </div>

        <div
          style={{
            margin: "3vh auto",
            background: "#fff",
            padding: "min(4vw, 32px)",
            borderRadius: 20,
            display: "inline-block",
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/c/${campaign.publicId}/qr.png`}
            alt={`QR code — ${joinUrl}`}
            width={520}
            height={520}
            style={{ width: "min(60vh, 520px)", height: "min(60vh, 520px)", imageRendering: "pixelated" }}
          />
        </div>

        <div style={{ fontSize: "clamp(1.4rem, 4vw, 2.6rem)", fontWeight: 700 }}>Scan to join</div>

        <div style={{ marginTop: "2vh", fontSize: "clamp(1.1rem, 3vw, 1.8rem)", color: "#d4d4d8" }}>
          {count} participant{count === 1 ? "" : "s"} · {statusLabel(campaign.status)}
        </div>

        <div style={{ marginTop: "1.5vh", fontSize: "clamp(0.9rem, 2vw, 1.2rem)", color: "#a1a1aa" }}>
          {joinUrl}
        </div>
      </div>
    </>
  );
}
