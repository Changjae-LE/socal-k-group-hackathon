import Link from "next/link";
import { notFound } from "next/navigation";
import { listRecentCampaigns } from "@/lib/campaign/queries";
import { parseRewardPolicy, summarizeRewardPolicy } from "@/lib/campaign/policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function DevCampaignsPage() {
  if (process.env.NODE_ENV === "production") notFound();

  const campaigns = await listRecentCampaigns(50);

  return (
    <main>
      <h1>Dev: campaigns</h1>
      <p>
        <Link href="/dev/campaigns/new">+ create a campaign</Link>
      </p>
      {campaigns.length === 0 ? (
        <p>None yet. Create one, or run <code>npm run seed</code>.</p>
      ) : (
        <ul style={{ paddingLeft: "1rem" }}>
          {campaigns.map((c) => {
            const policy = parseRewardPolicy(c.rewardPolicy);
            return (
              <li key={c.id} style={{ marginBottom: "0.5rem" }}>
                <Link href={`/host/campaigns/${c.id}`}>
                  <strong>{c.name}</strong>
                </Link>{" "}
                <code>/c/{c.publicId}</code>
                <div style={{ color: "#71717a", fontSize: "0.85rem" }}>
                  {c.status} · {c.isGlobal ? "global" : c.eligibleCountries.join(",")} ·{" "}
                  {policy ? summarizeRewardPolicy(policy) : "—"} · {c.winnerCount} winner(s) ·{" "}
                  <Link href={`/host/campaigns/${c.id}`}>operate</Link> ·{" "}
                  <Link href={`/c/${c.publicId}/display`}>display</Link> ·{" "}
                  <Link href={`/c/${c.publicId}/result`}>result</Link>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
