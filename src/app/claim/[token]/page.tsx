import Link from "next/link";
import { notFound } from "next/navigation";
import { readProof } from "@/lib/auth/proof-session";
import { loadClaim, sameTwitchUser } from "@/lib/campaign/claim";
import { campaignCatalogFilter } from "@/lib/campaign/queries";
import { parseRewardPolicy } from "@/lib/campaign/policy";
import {
  countryLabel,
  listProducts,
  productsForCountry,
  toPublicProduct,
  type PublicProduct,
} from "@/lib/sodagift/catalog";
import { resolveOrderContract } from "@/lib/sodagift/order-contract";
import { decryptSecret } from "@/lib/crypto/secretbox";
import { startClaimLogin, claimReward } from "./actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const twitchBtn: React.CSSProperties = {
  background: "#9146ff",
  color: "#fff",
  border: "none",
  padding: "0.7rem 1.15rem",
  borderRadius: 8,
  fontWeight: 600,
  fontSize: "1rem",
  cursor: "pointer",
};
const greenBtn: React.CSSProperties = { ...twitchBtn, background: "#16a34a", marginTop: "1rem" };
const card: React.CSSProperties = {
  border: "1px solid #e4e4e7",
  borderRadius: 10,
  padding: "0.8rem",
  background: "#fff",
};
const banner: React.CSSProperties = {
  padding: "0.55rem 0.9rem",
  background: "#fef2f2",
  border: "1px solid #fca5a5",
  borderRadius: 8,
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
  return p.currency;
}

const ERRORS: Record<string, string> = {
  pick_a_reward: "Choose a reward first.",
  not_found: "This claim link is not valid.",
  expired: "This claim link has expired. Ask the host to re-send it.",
  identity_mismatch: "This claim link isn't associated with your Twitch account.",
  product_unavailable: "That reward is no longer available. Pick another.",
  in_progress: "This reward is already being processed. Refresh in a moment.",
};
function humanError(e: string): string {
  if (ERRORS[e]) return ERRORS[e];
  if (e.startsWith("order_failed")) return `The reward order could not be created (${e}). You can try again.`;
  return e; // order-contract reasons are already human-readable
}

export default async function ClaimPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ ok?: string; e?: string }>;
}) {
  const { token } = await params;
  const { ok, e } = await searchParams;

  const claim = await loadClaim(token);
  if (!claim) notFound();

  const winner = claim.winner;
  const campaign = winner.campaign;
  const countryCode = winner.participant.countryCode;
  const session = await readProof();

  // 1. Not signed in → verify with Twitch.
  if (!session) {
    return (
      <main>
        <h1>Claim your reward</h1>
        <p>
          You won <strong>{campaign.name}</strong>. Verify your Twitch account to choose and
          claim your reward.
        </p>
        <form action={startClaimLogin.bind(null, token)} style={{ marginTop: "1.25rem" }}>
          <button type="submit" style={twitchBtn}>
            Verify with Twitch
          </button>
        </form>
      </main>
    );
  }

  // 2. Identity gate — constant-time compare against Winner.participant.twitchUserId.
  if (!sameTwitchUser(session.sub, winner.participant.twitchUserId)) {
    return (
      <main>
        <h1>Not your claim link</h1>
        <p style={banner}>This claim link isn&apos;t associated with your Twitch account.</p>
      </main>
    );
  }

  // 3. Expired and never used.
  if (claim.consumedAt == null && claim.expiresAt.getTime() < Date.now()) {
    return (
      <main>
        <h1>Link expired</h1>
        <p style={banner}>Ask the host to re-send your reward link.</p>
      </main>
    );
  }

  const reward = winner.reward;

  // 4. Already fulfilled → reveal the stored voucher URL to the verified winner only.
  if (
    reward &&
    (reward.status === "ORDER_CREATED" || reward.status === "FULFILLED") &&
    reward.rewardUrlEnc
  ) {
    let url = "";
    try {
      url = decryptSecret(reward.rewardUrlEnc);
    } catch {
      url = "";
    }
    return (
      <main>
        <h1>Your reward is ready 🎉</h1>
        <p style={{ color: "#52525b" }}>{campaign.name}</p>
        {url ? (
          <p style={{ marginTop: "1rem" }}>
            <a href={url} target="_blank" rel="noreferrer" style={{ ...greenBtn, display: "inline-block", textDecoration: "none", marginTop: 0 }}>
              Open your reward
            </a>
          </p>
        ) : (
          <p style={banner}>The reward link could not be read. Contact the host.</p>
        )}
        <p style={{ color: "#71717a", fontSize: "0.85rem", marginTop: "1rem" }}>
          Keep this link private — anyone who has it can open the reward.
        </p>
      </main>
    );
  }

  if (ok) {
    // fulfillClaim succeeded but the URL wasn't stored (rare) — tell them to refresh.
    return (
      <main>
        <h1>Reward on its way</h1>
        <p>Your reward order was created. Refresh this page in a few seconds for the link.</p>
        <p>
          <Link href={`/claim/${encodeURIComponent(token)}`}>Refresh</Link>
        </p>
      </main>
    );
  }

  // 5. Pick a product from the winner's own country catalog.
  let rows: { pub: PublicProduct; orderable: boolean }[] = [];
  try {
    const catalog = await listProducts();
    const policy = parseRewardPolicy(campaign.rewardPolicy);
    rows = productsForCountry(catalog, countryCode, campaignCatalogFilter(campaign)).map((p) => ({
      pub: toPublicProduct(p),
      orderable: resolveOrderContract({
        product: p,
        policy,
        allowedProductTypes: campaign.allowedProductTypes,
        countryCode,
      }).orderable,
    }));
  } catch {
    return (
      <main>
        <h1>Choose your reward</h1>
        <p style={banner}>Could not load the reward catalog. Please try again shortly.</p>
      </main>
    );
  }

  const orderable = rows.filter((r) => r.orderable);
  const hiddenCount = rows.length - orderable.length;

  return (
    <main>
      <h1>Choose your reward</h1>
      <p style={{ color: "#52525b" }}>
        {campaign.name} · {countryLabel(countryCode)} ({countryCode})
      </p>
      {e ? <p style={banner}>{humanError(e)}</p> : null}

      {orderable.length === 0 ? (
        <p style={{ color: "#b91c1c", marginTop: "1rem" }}>
          No rewards can be fulfilled automatically for {countryLabel(countryCode)} right now.
          The host can see this on their dashboard.
        </p>
      ) : (
        <form action={claimReward.bind(null, token)} style={{ marginTop: "1rem" }}>
          <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: "0.6rem" }}>
            {orderable.map(({ pub }) => (
              <li key={pub.id} style={card}>
                <label style={{ display: "flex", gap: "0.7rem", alignItems: "center", cursor: "pointer" }}>
                  <input type="radio" name="productId" value={pub.id} required />
                  {pub.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={pub.imageUrl}
                      alt=""
                      width={48}
                      height={48}
                      referrerPolicy="no-referrer"
                      style={{ width: 48, height: 48, objectFit: "cover", borderRadius: 6, background: "#f4f4f5" }}
                    />
                  ) : null}
                  <span style={{ minWidth: 0 }}>
                    <strong>
                      {pub.brandName ? `${pub.brandName} — ` : ""}
                      {pub.name}
                    </strong>
                    <br />
                    <span style={{ color: "#3f3f46" }}>
                      {priceLabel(pub)} · {pub.productType}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <button type="submit" style={greenBtn}>
            Claim this reward
          </button>
        </form>
      )}

      {hiddenCount > 0 ? (
        <p style={{ color: "#a1a1aa", fontSize: "0.8rem", marginTop: "1rem" }}>
          {hiddenCount} catalog item{hiddenCount === 1 ? "" : "s"} for your country {hiddenCount === 1 ? "is" : "are"} hidden
          because their SodaGift ordering contract can&apos;t be determined automatically yet.
        </p>
      ) : null}
    </main>
  );
}
