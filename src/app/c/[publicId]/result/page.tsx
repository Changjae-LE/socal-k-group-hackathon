import Link from "next/link";
import { notFound } from "next/navigation";
import {
  countParticipants,
  getCampaignByPublicId,
  getWinners,
} from "@/lib/campaign/queries";
import { countryLabel } from "@/lib/sodagift/catalog";
import { maskTwitchId } from "@/lib/format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Public results. Never exposes SodaGift URLs, tokens, claim tokens, or secrets —
// this page reads only Winner + Participant (twitchUserId shown MASKED, countryCode).
export default async function ResultPage({
  params,
}: {
  params: Promise<{ publicId: string }>;
}) {
  const { publicId } = await params;
  const campaign = await getCampaignByPublicId(publicId);
  if (!campaign) notFound();

  if (campaign.status !== "DRAWN") {
    const count = await countParticipants(campaign.id);
    return (
      <main>
        <h1>{campaign.name}</h1>
        <p style={{ fontSize: "1.15rem", fontWeight: 600 }}>Waiting for results</p>
        <p style={{ color: "#71717a" }}>
          {count} participant{count === 1 ? "" : "s"} so far · status {campaign.status}.
        </p>
        <p>
          <Link href={`/c/${campaign.publicId}`}>Back to campaign</Link>
        </p>
      </main>
    );
  }

  const winners = await getWinners(campaign.id);

  return (
    <main>
      <h1>Giveaway Results</h1>
      <p style={{ color: "#52525b" }}>{campaign.name}</p>

      <ol style={{ listStyle: "none", padding: 0, display: "grid", gap: "0.75rem", marginTop: "1rem" }}>
        {winners.map((w) => (
          <li
            key={w.id}
            style={{
              border: "1px solid #e4e4e7",
              borderRadius: 10,
              padding: "0.8rem 1rem",
              background: "#fff",
            }}
          >
            <div style={{ fontWeight: 700 }}>Winner #{w.drawSequence}</div>
            <div style={{ color: "#3f3f46", marginTop: 2 }}>
              Twitch identity: <code>{maskTwitchId(w.participant.twitchUserId)}</code>{" "}
              <span style={{ color: "#a1a1aa", fontSize: "0.85rem" }}>
                (masked — no display name persisted yet)
              </span>
            </div>
            <div style={{ color: "#3f3f46" }}>
              Country: {countryLabel(w.participant.countryCode)} ({w.participant.countryCode})
            </div>
          </li>
        ))}
      </ol>

      {winners.length === 0 ? <p>No winners recorded.</p> : null}

      <p style={{ marginTop: "1.25rem" }}>
        <Link href={`/c/${campaign.publicId}`}>Back to campaign</Link>
      </p>
    </main>
  );
}
