import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { readProof } from "@/lib/auth/proof-session";
import { readCampaignContext } from "@/lib/campaign/context";
import {
  campaignCatalogFilter,
  getCampaignByPublicId,
  getParticipant,
  isJoinable,
} from "@/lib/campaign/queries";
import { joinGiveaway } from "../actions";
import {
  countryLabel,
  isSelectableCountry,
  listProducts,
  productsForCountry,
  toPublicProduct,
  type PublicProduct,
} from "@/lib/sodagift/catalog";
import { SodaGiftNotConfiguredError } from "@/lib/sodagift/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const card: React.CSSProperties = {
  border: "1px solid #e4e4e7",
  borderRadius: 10,
  padding: "0.9rem",
  background: "#fff",
  display: "flex",
  gap: "0.9rem",
};

function money(currency: string, n: number): string {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).format(n);
  } catch {
    return `${n} ${currency}`;
  }
}

function priceLabel(p: PublicProduct): string {
  if (p.amountKind === "FIXED" && p.amount != null) return money(p.currency, p.amount);
  if (p.amountKind === "RANGE" && p.minAmount != null && p.maxAmount != null) {
    return `${money(p.currency, p.minAmount)} – ${money(p.currency, p.maxAmount)}`;
  }
  return `— ${p.currency}`;
}

export default async function CampaignRewardsPage({
  params,
  searchParams,
}: {
  params: Promise<{ publicId: string }>;
  searchParams: Promise<{ country?: string }>;
}) {
  const { publicId } = await params;

  const campaign = await getCampaignByPublicId(publicId);
  if (!campaign) notFound();
  if (!isJoinable(campaign)) redirect(`/c/${campaign.publicId}`);

  const session = await readProof();
  if (!session) redirect(`/c/${campaign.publicId}`);

  const ctx = await readCampaignContext();
  if (ctx !== campaign.publicId) redirect(`/c/${campaign.publicId}`);

  const { country } = await searchParams;
  const code = (country ?? "").trim().toUpperCase();
  const filter = campaignCatalogFilter(campaign);

  if (!code) {
    return (
      <Shell campaignName={campaign.name} sub={session.sub} heading="Available rewards">
        <p>No country selected.</p>
        <p>
          <Link href={`/c/${campaign.publicId}/country`}>Choose a country</Link>
        </p>
      </Shell>
    );
  }

  let allProducts;
  try {
    allProducts = await listProducts();
  } catch (err) {
    const notConfigured = err instanceof SodaGiftNotConfiguredError;
    return (
      <Shell campaignName={campaign.name} sub={session.sub} heading="Available rewards">
        <p style={{ color: "#b91c1c" }}>
          {notConfigured
            ? "SodaGift is not configured (SODAGIFT_API_KEY missing)."
            : "Could not load the SodaGift catalog. Please try again shortly."}
        </p>
        <p>
          <Link href={`/c/${campaign.publicId}/country`}>Back</Link>
        </p>
      </Shell>
    );
  }

  // Re-validate the selected country server-side against the live catalog + campaign rules.
  if (!isSelectableCountry(allProducts, code, filter)) {
    return (
      <Shell campaignName={campaign.name} sub={session.sub} heading="Available rewards">
        <p>
          <strong>{code}</strong> is not a selectable country for this campaign.
        </p>
        <p>
          <Link href={`/c/${campaign.publicId}/country`}>Choose a different country</Link>
        </p>
      </Shell>
    );
  }

  const products = productsForCountry(allProducts, code, filter).map(toPublicProduct);
  const existing = await getParticipant(campaign.id, session.sub);

  return (
    <Shell
      campaignName={campaign.name}
      sub={session.sub}
      heading={`Available rewards in ${countryLabel(code)} (${code})`}
    >
      <p style={{ color: "#71717a", fontSize: "0.9rem" }}>
        {products.length} product{products.length === 1 ? "" : "s"} · filter:{" "}
        <code>country_code == &quot;{code}&quot;</code> ·{" "}
        <code>availability == &quot;ON_SALE&quot;</code> ·{" "}
        <code>available_delivery_method includes &quot;LINK&quot;</code>
        {campaign.allowedProductTypes.length > 0
          ? ` · type ∈ {${campaign.allowedProductTypes.join(", ")}}`
          : ""}
      </p>

      <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: "0.75rem" }}>
        {products.map((p) => (
          <li key={p.id} style={card}>
            {p.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={p.imageUrl}
                alt=""
                width={72}
                height={72}
                loading="lazy"
                referrerPolicy="no-referrer"
                style={{
                  width: 72,
                  height: 72,
                  objectFit: "cover",
                  borderRadius: 8,
                  background: "#f4f4f5",
                  flex: "0 0 auto",
                }}
              />
            ) : (
              <div
                style={{
                  width: 72,
                  height: 72,
                  borderRadius: 8,
                  background: "#f4f4f5",
                  flex: "0 0 auto",
                }}
              />
            )}
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>
                {p.brandName ? `${p.brandName} — ` : ""}
                {p.name}
              </div>
              <div style={{ color: "#3f3f46", marginTop: 2 }}>
                {priceLabel(p)}{" "}
                <span style={{ color: "#a1a1aa" }}>({p.amountKind.toLowerCase()})</span>
              </div>
              <div style={{ color: "#71717a", fontSize: "0.85rem", marginTop: 4 }}>
                {p.productType} · {p.countryCode} · delivery: {p.deliveryMethods.join(", ")}
              </div>
            </div>
          </li>
        ))}
      </ul>

      {products.length === 0 ? <p>No matching rewards.</p> : null}

      <section
        style={{
          marginTop: "1.5rem",
          padding: "1rem 1.15rem",
          border: "1px solid #e4e4e7",
          borderRadius: 10,
          background: "#fff",
        }}
      >
        {existing ? (
          <>
            <p style={{ margin: 0, fontWeight: 600, color: "#166534" }}>
              You have already joined this giveaway.
            </p>
            <p style={{ margin: "0.35rem 0 0", color: "#3f3f46", fontSize: "0.9rem" }}>
              Country on record: <strong>{countryLabel(existing.countryCode)}</strong> (
              {existing.countryCode}).{" "}
              <Link href={`/c/${campaign.publicId}/joined`}>View confirmation</Link>
            </p>
          </>
        ) : (
          <form action={joinGiveaway.bind(null, campaign.publicId, code)}>
            <p style={{ margin: "0 0 0.6rem", color: "#3f3f46" }}>
              Enter as <strong>{countryLabel(code)}</strong> ({code}). Your Twitch identity is
              taken from your verified sign-in — nothing to type.
            </p>
            <button
              type="submit"
              style={{
                background: "#16a34a",
                color: "#fff",
                border: "none",
                padding: "0.7rem 1.2rem",
                borderRadius: 8,
                fontWeight: 700,
                fontSize: "1rem",
                cursor: "pointer",
              }}
            >
              Join Giveaway
            </button>
          </form>
        )}
      </section>

      <p style={{ marginTop: "1.25rem" }}>
        <Link href={`/c/${campaign.publicId}/country`}>Pick another country</Link>
      </p>
    </Shell>
  );
}

function Shell({
  campaignName,
  sub,
  heading,
  children,
}: {
  campaignName: string;
  sub: string;
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <main>
      <h1>{heading}</h1>
      <p style={{ color: "#52525b", fontSize: "0.9rem", marginTop: "0.25rem" }}>
        Campaign <strong>{campaignName}</strong> · signed in as Twitch user <code>{sub}</code>
      </p>
      {children}
    </main>
  );
}
