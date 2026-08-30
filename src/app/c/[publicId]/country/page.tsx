import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { readProof } from "@/lib/auth/proof-session";
import { readCampaignContext } from "@/lib/campaign/context";
import {
  campaignCatalogFilter,
  getCampaignByPublicId,
  isJoinable,
} from "@/lib/campaign/queries";
import { listProducts, selectableCountries } from "@/lib/sodagift/catalog";
import { SodaGiftNotConfiguredError } from "@/lib/sodagift/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const submitButton: React.CSSProperties = {
  background: "#9146ff",
  color: "#fff",
  border: "none",
  padding: "0.6rem 1.1rem",
  borderRadius: 8,
  fontWeight: 600,
  cursor: "pointer",
};

export default async function CampaignCountryPage({
  params,
}: {
  params: Promise<{ publicId: string }>;
}) {
  const { publicId } = await params;

  // Campaign identity is authoritative from the DB, not from the cookie or the URL alone.
  const campaign = await getCampaignByPublicId(publicId);
  if (!campaign) notFound();
  if (!isJoinable(campaign)) redirect(`/c/${campaign.publicId}`);

  // Participant identity: verified OIDC sub.
  const session = await readProof();
  if (!session) redirect(`/c/${campaign.publicId}`);

  // The cookie is only a transport hint; require it to match this campaign.
  const ctx = await readCampaignContext();
  if (ctx !== campaign.publicId) redirect(`/c/${campaign.publicId}`);

  let countries;
  try {
    countries = selectableCountries(await listProducts(), campaignCatalogFilter(campaign));
  } catch (err) {
    const notConfigured = err instanceof SodaGiftNotConfiguredError;
    return (
      <Shell campaignName={campaign.name} sub={session.sub}>
        <p style={{ color: "#b91c1c" }}>
          {notConfigured
            ? "SodaGift is not configured (SODAGIFT_API_KEY missing)."
            : "Could not load the SodaGift catalog. Please try again shortly."}
        </p>
        <p>
          <Link href={`/c/${campaign.publicId}`}>Back</Link>
        </p>
      </Shell>
    );
  }

  return (
    <Shell campaignName={campaign.name} sub={session.sub}>
      <h2 style={{ fontSize: "1.1rem" }}>Select your country</h2>
      {countries.length === 0 ? (
        <p>
          No countries are currently available for this campaign (no <code>ON_SALE</code>{" "}
          products with <code>LINK</code> delivery matching its rules).
        </p>
      ) : (
        <form
          method="GET"
          action={`/c/${campaign.publicId}/rewards`}
          style={{ marginTop: "1rem", display: "flex", gap: "0.75rem", flexWrap: "wrap" }}
        >
          <select
            name="country"
            defaultValue=""
            required
            style={{
              padding: "0.55rem 0.7rem",
              borderRadius: 8,
              border: "1px solid #d4d4d8",
              fontSize: "1rem",
              minWidth: 240,
            }}
          >
            <option value="" disabled>
              Choose a country…
            </option>
            {countries.map((c) => (
              <option key={c.code} value={c.code}>
                {c.label} ({c.code}) — {c.productCount} reward
                {c.productCount === 1 ? "" : "s"}
              </option>
            ))}
          </select>
          <button type="submit" style={submitButton}>
            Show rewards
          </button>
        </form>
      )}
      <p style={{ marginTop: "1.5rem", color: "#71717a", fontSize: "0.9rem" }}>
        Countries are derived live from the SodaGift catalog (ON_SALE + LINK, matching this
        campaign&apos;s rules). Nothing is hardcoded.
      </p>
      <p>
        <Link href={`/c/${campaign.publicId}`}>Back to campaign</Link>
      </p>
    </Shell>
  );
}

function Shell({
  campaignName,
  sub,
  children,
}: {
  campaignName: string;
  sub: string;
  children: React.ReactNode;
}) {
  return (
    <main>
      <h1>{campaignName}</h1>
      <p style={{ color: "#52525b", fontSize: "0.9rem", marginTop: "0.25rem" }}>
        Signed in as Twitch user <code>{sub}</code>
      </p>
      {children}
    </main>
  );
}
