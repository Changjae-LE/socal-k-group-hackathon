import Link from "next/link";
import { cookies } from "next/headers";
import { PROOF_COOKIE, open } from "@/lib/auth/cookies";
import { readClaimContext } from "@/lib/campaign/claim-context";
import { continueToCountry } from "@/app/actions/continue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Proof = { sub?: string };

const primaryButton: React.CSSProperties = {
  background: "#9146ff",
  color: "#fff",
  border: "none",
  padding: "0.65rem 1.15rem",
  borderRadius: 8,
  fontWeight: 600,
  fontSize: "1rem",
  cursor: "pointer",
};

export default async function ResultPage() {
  const store = await cookies();
  const proof = await open<Proof>(store.get(PROOF_COOKIE)?.value);

  if (!proof?.sub) {
    return (
      <main>
        <h1>No verified session</h1>
        <p>The proof session is missing or expired.</p>
        <p>
          <Link href="/">Start again</Link>
        </p>
      </main>
    );
  }

  // If the login was started from a winner's claim link, continue there — not the join flow.
  const claimToken = await readClaimContext();
  if (claimToken) {
    return (
      <main>
        <h1>Twitch authentication successful</h1>
        <p style={{ marginBottom: "0.25rem" }}>
          Verified as Twitch user <code>{proof.sub}</code>.
        </p>
        <p style={{ margin: "1.5rem 0" }}>
          <Link href={`/claim/${claimToken}`} style={{ ...primaryButton, display: "inline-block", textDecoration: "none" }}>
            Continue to your reward
          </Link>
        </p>
      </main>
    );
  }

  return (
    <main>
      <h1>Twitch authentication successful</h1>
      <p style={{ marginBottom: "0.25rem" }}>Twitch User ID:</p>
      <pre
        style={{
          fontSize: "1.25rem",
          background: "#f4f4f5",
          padding: "0.75rem 1rem",
          borderRadius: 8,
          overflowX: "auto",
        }}
      >
        {proof.sub}
      </pre>
      <p style={{ color: "#71717a", fontSize: "0.9rem" }}>
        Verified OIDC <code>sub</code> — RS256 signature, issuer, audience, expiration, and
        nonce were all checked server-side. Display name / username is never used as the
        identifier.
      </p>

      <form action={continueToCountry} style={{ margin: "1.5rem 0" }}>
        <button type="submit" style={primaryButton}>
          Continue
        </button>
      </form>

      <p>
        <Link href="/">Home</Link>
      </p>
    </main>
  );
}
