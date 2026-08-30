import { notFound } from "next/navigation";
import { TEST_WHISPER_MESSAGE, HOST_SCOPE } from "@/lib/twitch/host-oauth";
import { readHostSession, readWhisperOutcome } from "@/lib/auth/host-session";
import { sendTestWhisper } from "./actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  not_configured: "Twitch client credentials are missing in .env.local.",
  not_connected: "Connect a Host Twitch account first.",
  session_expired: "The host OAuth round-trip expired. Try connecting again.",
  state_mismatch: "OAuth state mismatch. Try connecting again.",
  missing_code_or_state: "Twitch did not return an authorization code.",
  exchange_failed: "Could not exchange the code or validate the token.",
  wrong_client: "The returned token does not belong to this app.",
  missing_scope: `The host did not grant ${HOST_SCOPE}. Re-connect and approve it.`,
  bad_recipient: "Recipient must be a numeric Twitch user ID (digits only).",
  self: "Recipient must be a different account than the host.",
  cooldown: "A whisper was just sent — wait a few seconds before sending again.",
  twitch_error: "Twitch returned an error on the authorization request.",
  access_denied: "Host authorization was declined.",
};

const btn: React.CSSProperties = {
  background: "#9146ff",
  color: "#fff",
  border: "none",
  padding: "0.6rem 1.1rem",
  borderRadius: 8,
  fontWeight: 600,
  cursor: "pointer",
};

export default async function DevHostPage({
  searchParams,
}: {
  searchParams: Promise<{ e?: string; connected?: string }>;
}) {
  if (process.env.NODE_ENV === "production") notFound();

  const { e, connected } = await searchParams;
  const session = await readHostSession();
  const outcome = await readWhisperOutcome();
  const hasScope = !!session?.scopes.includes(HOST_SCOPE);

  return (
    <main>
      <h1>Dev: Host OAuth + one test Whisper</h1>
      <div
        style={{
          margin: "0.5rem 0 1rem",
          padding: "0.75rem 1rem",
          border: "1px solid #fca5a5",
          background: "#fef2f2",
          borderRadius: 8,
          fontSize: "0.9rem",
        }}
      >
        <strong>Isolated Twitch Whisper API test — NOT product behaviour.</strong> Dev-only
        (blocked when <code>NODE_ENV=production</code>). The manual recipient user-ID field
        below exists <em>only</em> to probe the whisper endpoint. In the real V1 flow the
        Host <strong>never</strong> types a Twitch ID: the winner&apos;s{" "}
        <code>twitchUserId</code> is read automatically from the database (captured from the
        participant&apos;s verified OIDC <code>sub</code> when they joined via the campaign
        QR). Separate from participant OIDC; not connected to winner selection or SodaGift.
      </div>

      {e ? (
        <p style={{ padding: "0.6rem 0.9rem", background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8 }}>
          {ERRORS[e] ?? `Error: ${e}`}
        </p>
      ) : null}
      {connected ? (
        <p style={{ padding: "0.6rem 0.9rem", background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 8 }}>
          Host Twitch account connected.
        </p>
      ) : null}

      <h2 style={{ fontSize: "1.05rem", marginTop: "1.5rem" }}>1. Host connection</h2>
      {!session ? (
        <p>
          <a href="/api/auth/host/login" style={btn}>
            Connect Host Twitch account
          </a>{" "}
          <span style={{ color: "#71717a", fontSize: "0.9rem" }}>
            — requests scope <code>{HOST_SCOPE}</code>
          </span>
        </p>
      ) : (
        <>
          <ul style={{ lineHeight: 1.8 }}>
            <li>
              login: <code>{session.hostLogin || "—"}</code>
            </li>
            <li>
              host user id (<code>from_user_id</code>): <code>{session.hostUserId}</code>
            </li>
            <li>
              scopes: <code>{session.scopes.join(", ") || "—"}</code>{" "}
              {hasScope ? "✅" : "❌ missing user:manage:whispers"}
            </li>
            <li>
              token stored in the encrypted <code>sl_host</code> cookie (server-only), expires
              ~{new Date(session.expiresAt * 1000).toISOString()}
            </li>
          </ul>
          <form action="/api/auth/host/logout" method="POST">
            <button type="submit" style={{ ...btn, background: "#3f3f46" }}>
              Disconnect host
            </button>
          </form>
        </>
      )}

      <h2 style={{ fontSize: "1.05rem", marginTop: "1.5rem" }}>2. Send ONE test whisper</h2>
      {!session || !hasScope ? (
        <p style={{ color: "#71717a" }}>Connect a host with the whisper scope first.</p>
      ) : (
        <form action={sendTestWhisper} style={{ display: "grid", gap: "0.6rem", maxWidth: 420 }}>
          <label>
            Recipient Twitch <strong>user ID</strong> (numeric, not the username)
            <input
              name="recipientUserId"
              inputMode="numeric"
              pattern="\d{1,20}"
              required
              placeholder="123456789"
              style={{
                display: "block",
                marginTop: "0.25rem",
                padding: "0.5rem 0.65rem",
                borderRadius: 6,
                border: "1px solid #d4d4d8",
                width: "100%",
              }}
            />
          </label>
          <p style={{ color: "#71717a", fontSize: "0.85rem", margin: 0 }}>
            Tip: log into the participant proof as that account — <code>/auth/result</code>{" "}
            shows its numeric <code>sub</code> (= its Twitch user ID).
          </p>
          <div>
            message (fixed):
            <pre style={{ background: "#f4f4f5", padding: "0.6rem 0.8rem", borderRadius: 8, whiteSpace: "pre-wrap" }}>
              {TEST_WHISPER_MESSAGE}
            </pre>
          </div>
          <button type="submit" style={btn}>
            Send ONE test whisper
          </button>
        </form>
      )}

      {outcome ? (
        <>
          <h2 style={{ fontSize: "1.05rem", marginTop: "1.5rem" }}>Last send result</h2>
          <ul style={{ lineHeight: 1.8 }}>
            <li>
              to_user_id: <code>{outcome.toUserId}</code>
            </li>
            <li>
              HTTP status: <code>{outcome.httpStatus}</code>
            </li>
            {outcome.accepted ? (
              <li style={{ color: "#166534" }}>
                <strong>HTTP 204 — Twitch accepted the request.</strong> This does <strong>not</strong>{" "}
                guarantee the recipient received the whisper (Twitch may silently drop
                whispers; the host account also needs a verified phone number).
              </li>
            ) : (
              <li style={{ color: "#b91c1c" }}>
                Not accepted. {outcome.detail ? <code>{outcome.detail}</code> : null}
              </li>
            )}
          </ul>
          <p style={{ color: "#a1a1aa", fontSize: "0.8rem" }}>
            (result auto-expires from its cookie after a few minutes)
          </p>
        </>
      ) : null}
    </main>
  );
}
