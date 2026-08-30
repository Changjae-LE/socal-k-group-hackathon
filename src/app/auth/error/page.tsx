import Link from "next/link";

export const dynamic = "force-dynamic";

const MESSAGES: Record<string, string> = {
  not_configured:
    "Twitch credentials are not set. Add TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET to .env.local from the Twitch Developer Console, then restart the dev server.",
  session_expired:
    "The sign-in session was missing or expired. Please start again.",
  state_mismatch:
    "OAuth state did not match (possible CSRF, or a stale/duplicate tab). Please start again.",
  missing_code_or_state: "Twitch did not return an authorization code. Please try again.",
  verification_failed:
    "The Twitch ID token could not be verified (signature, issuer, audience, expiry, or nonce). Please try again.",
  access_denied: "You declined the Twitch authorization.",
};

export default async function AuthErrorPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string; missing?: string }>;
}) {
  const { reason, missing } = await searchParams;
  const message =
    (reason && MESSAGES[reason]) || "Authentication could not be completed.";

  return (
    <main>
      <h1>Twitch sign-in failed</h1>
      <p>{message}</p>
      {reason === "not_configured" && missing ? (
        <p>
          Missing: <code>{missing.split(",").join(", ")}</code>
        </p>
      ) : null}
      {reason && reason !== "not_configured" ? (
        <p style={{ color: "#71717a", fontSize: "0.9rem" }}>
          reason: <code>{reason}</code>
        </p>
      ) : null}
      <p>
        <Link href="/">Back to start</Link>
      </p>
    </main>
  );
}
