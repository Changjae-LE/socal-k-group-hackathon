import Link from "next/link";
import { notFound } from "next/navigation";
import {
  countParticipants,
  getCampaignById,
  getFulfillmentView,
  getWinners,
  participantCountryBreakdown,
} from "@/lib/campaign/queries";
import { countryLabel } from "@/lib/sodagift/catalog";
import { maskTwitchId, statusLabel } from "@/lib/format";
import { env } from "@/lib/env";
import {
  closeEntriesAction,
  drawWinnersAction,
  reopenEntriesAction,
  sendWhispersAction,
} from "./actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OK: Record<string, string> = {
  closed: "Entries closed.",
  reopened: "Entries reopened.",
  drawn: "Winners drawn.",
  already_drawn: "Already drawn — showing the existing winners.",
};

const btn = (bg: string): React.CSSProperties => ({
  background: bg,
  color: "#fff",
  border: "none",
  padding: "0.55rem 1rem",
  borderRadius: 8,
  fontWeight: 700,
  cursor: "pointer",
});

export default async function HostCampaignPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ e?: string; ok?: string }>;
}) {
  if (process.env.NODE_ENV === "production") notFound();

  const { id } = await params;
  const { e, ok } = await searchParams;

  const campaign = await getCampaignById(id);
  if (!campaign) notFound();

  const [count, breakdown, winners, fulfillment] = await Promise.all([
    countParticipants(campaign.id),
    participantCountryBreakdown(campaign.id),
    getWinners(campaign.id),
    campaign.status === "DRAWN" ? getFulfillmentView(campaign.id) : Promise.resolve([]),
  ]);

  const publicUrl = `${env().APP_URL}/c/${campaign.publicId}`;
  const displayUrl = `${env().APP_URL}/c/${campaign.publicId}/display`;
  const resultUrl = `${env().APP_URL}/c/${campaign.publicId}/result`;

  return (
    <main>
      <p style={{ color: "#b91c1c", fontSize: "0.85rem" }}>
        Dev-only operator page (blocked when <code>NODE_ENV=production</code>). Host
        authentication will gate this later. No Twitch-ID input anywhere.
      </p>

      <h1>{campaign.name}</h1>

      {ok ? (
        <p style={{ padding: "0.55rem 0.9rem", background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 8 }}>
          {OK[ok] ?? ok}
        </p>
      ) : null}
      {e ? (
        <p style={{ padding: "0.55rem 0.9rem", background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8 }}>
          {e}
        </p>
      ) : null}

      <ul style={{ lineHeight: 1.9 }}>
        <li>Status: <strong>{campaign.status}</strong> ({statusLabel(campaign.status)})</li>
        <li>Participants: <strong>{count}</strong></li>
        <li>Winners to draw: <strong>{campaign.winnerCount}</strong></li>
        <li>Public campaign URL: <code>{publicUrl}</code></li>
        <li>QR display page: <a href={displayUrl} target="_blank" rel="noreferrer"><code>{displayUrl}</code></a></li>
        <li>Result page: <a href={resultUrl} target="_blank" rel="noreferrer"><code>{resultUrl}</code></a></li>
      </ul>

      <h2 style={{ fontSize: "1.05rem" }}>Countries</h2>
      {breakdown.length === 0 ? (
        <p style={{ color: "#71717a" }}>No participants yet.</p>
      ) : (
        <ul>
          {breakdown.map((b) => (
            <li key={b.countryCode}>
              {countryLabel(b.countryCode)} ({b.countryCode}) — {b.count}
            </li>
          ))}
        </ul>
      )}

      <h2 style={{ fontSize: "1.05rem" }}>Operations</h2>
      <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
        {campaign.status === "OPEN" ? (
          <form action={closeEntriesAction.bind(null, campaign.id)}>
            <button type="submit" style={btn("#3f3f46")}>Close Entries</button>
          </form>
        ) : null}

        {campaign.status === "CLOSED" ? (
          <>
            <form action={reopenEntriesAction.bind(null, campaign.id)}>
              <button type="submit" style={btn("#3f3f46")}>Reopen Entries</button>
            </form>
            <form action={drawWinnersAction.bind(null, campaign.id)}>
              <button type="submit" style={btn("#16a34a")}>Draw Winners</button>
            </form>
          </>
        ) : null}

        {campaign.status === "DRAWN" ? (
          <span style={{ color: "#166534", fontWeight: 700 }}>
            Draw complete — result is final.
          </span>
        ) : null}

        {campaign.status === "DRAFT" ? (
          <span style={{ color: "#71717a" }}>Campaign is still a draft.</span>
        ) : null}
      </div>

      {winners.length > 0 ? (
        <>
          <h2 style={{ fontSize: "1.05rem", marginTop: "1.5rem" }}>Winners</h2>
          <ol style={{ paddingLeft: "1.1rem" }}>
            {winners.map((w) => (
              <li key={w.id}>
                #{w.drawSequence} — <code>{maskTwitchId(w.participant.twitchUserId)}</code>{" "}
                · {countryLabel(w.participant.countryCode)} ({w.participant.countryCode})
              </li>
            ))}
          </ol>
        </>
      ) : null}

      {campaign.status === "DRAWN" ? (
        <>
          <h2 style={{ fontSize: "1.05rem", marginTop: "1.5rem" }}>Fulfillment</h2>
          <p style={{ color: "#71717a", fontSize: "0.85rem", margin: "0 0 0.6rem" }}>
            Each winner is Whispered a private <code>{env().APP_URL}/claim/&lt;token&gt;</code> link
            (never shown here — it is the winner&apos;s bearer secret). The winner verifies their
            Twitch identity, picks a reward from <strong>their own country&apos;s</strong> SodaGift
            catalog, and the LINK order is created server-side. No product id is entered by hand.
          </p>
          <form action={sendWhispersAction.bind(null, campaign.id)} style={{ marginBottom: "0.8rem" }}>
            <button type="submit" style={btn("#9146ff")}>Send / Retry Whispers</button>{" "}
            <span style={{ color: "#71717a", fontSize: "0.85rem" }}>
              needs a Host Twitch account connected at <code>/dev/host</code>
            </span>
          </form>
          <ol style={{ paddingLeft: "1.1rem", lineHeight: 1.8 }}>
            {fulfillment.map((w) => {
              const whisper = w.whisperAttempts[0];
              return (
                <li key={w.id}>
                  #{w.drawSequence} — <code>{maskTwitchId(w.participant.twitchUserId)}</code> ·{" "}
                  {countryLabel(w.participant.countryCode)} ({w.participant.countryCode}) · reward:{" "}
                  <strong>{w.reward?.status ?? "—"}</strong>
                  {w.reward?.unavailableReason ? ` (${w.reward.unavailableReason})` : ""}
                  {w.reward?.sodagiftOrderId ? ` · order ${w.reward.sodagiftOrderId}` : ""}
                  {" · whisper: "}
                  {whisper
                    ? `${whisper.status}${whisper.twitchHttpStatus ? ` (HTTP ${whisper.twitchHttpStatus})` : ""}`
                    : "not sent"}
                </li>
              );
            })}
          </ol>
        </>
      ) : null}

      <p style={{ marginTop: "1.5rem" }}>
        <Link href="/dev/campaigns">All campaigns</Link>
        {" · "}
        <Link href={`/host/campaigns/${campaign.id}`}>Refresh</Link>
      </p>
    </main>
  );
}
