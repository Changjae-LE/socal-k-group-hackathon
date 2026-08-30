import { notFound } from "next/navigation";
import { createCampaignDevAction } from "../actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const field: React.CSSProperties = {
  display: "block",
  marginTop: "0.25rem",
  padding: "0.45rem 0.6rem",
  borderRadius: 6,
  border: "1px solid #d4d4d8",
  width: "100%",
  maxWidth: 360,
  fontSize: "0.95rem",
};
const label: React.CSSProperties = { display: "block", marginTop: "1rem", fontWeight: 600 };

export default function DevNewCampaignPage() {
  if (process.env.NODE_ENV === "production") notFound();

  return (
    <main>
      <h1>Dev: create campaign</h1>
      <p style={{ color: "#b91c1c", fontSize: "0.9rem" }}>
        Unauthenticated dev-only form (blocked when <code>NODE_ENV=production</code>). Host
        authentication will replace this later.
      </p>

      <form action={createCampaignDevAction}>
        <label style={label}>
          Name
          <input name="name" required minLength={2} maxLength={120} style={field} defaultValue="Sample Global Giveaway" />
        </label>

        <label style={{ ...label, fontWeight: 400 }}>
          <input type="checkbox" name="isGlobal" defaultChecked /> Global (any country the
          catalog supports)
        </label>

        <label style={label}>
          Eligible countries (CSV, only if not global)
          <input name="eligibleCountries" placeholder="US,KR,JP" style={field} />
        </label>

        <label style={label}>
          Allowed product types (CSV, blank = any)
          <input name="allowedProductTypes" defaultValue="GIFT_CARD" style={field} />
        </label>

        <label style={label}>
          Reward policy kind
          <select name="policyKind" style={field} defaultValue="TARGET_VALUE">
            <option value="TARGET_VALUE">TARGET_VALUE</option>
            <option value="VALUE_RANGE">VALUE_RANGE</option>
            <option value="BUDGET_PER_WINNER">BUDGET_PER_WINNER</option>
          </select>
        </label>
        <label style={label}>
          amount (TARGET_VALUE / BUDGET_PER_WINNER)
          <input name="policyAmount" type="number" step="0.01" defaultValue="5" style={field} />
        </label>
        <label style={label}>
          min / max (VALUE_RANGE)
          <input name="policyMin" type="number" step="0.01" placeholder="min" style={field} />
        </label>
        <input name="policyMax" type="number" step="0.01" placeholder="max" style={field} />
        <label style={label}>
          currency (reference)
          <input name="policyCurrency" defaultValue="USD" maxLength={3} style={field} />
        </label>

        <label style={label}>
          Reward selection mode
          <select name="rewardSelectionMode" style={field} defaultValue="BACKEND_SELECT">
            <option value="BACKEND_SELECT">BACKEND_SELECT (C)</option>
            <option value="PARTICIPANT_PRECHOICE">PARTICIPANT_PRECHOICE (A)</option>
            <option value="WINNER_CHOICE">WINNER_CHOICE (B)</option>
          </select>
        </label>

        <label style={label}>
          Claim-link mode
          <select name="claimLinkMode" style={field} defaultValue="PROTECTED_TOKEN">
            <option value="PROTECTED_TOKEN">PROTECTED_TOKEN (default, option B)</option>
            <option value="SODAGIFT_DIRECT">SODAGIFT_DIRECT (option A)</option>
          </select>
        </label>

        <label style={label}>
          Winner count
          <input name="winnerCount" type="number" min={1} max={10000} defaultValue="3" style={field} />
        </label>

        <button
          type="submit"
          style={{
            marginTop: "1.5rem",
            background: "#18181b",
            color: "#fff",
            border: "none",
            padding: "0.6rem 1.1rem",
            borderRadius: 8,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Create campaign
        </button>
      </form>
    </main>
  );
}
