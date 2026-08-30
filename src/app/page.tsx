import { Fragment } from "react";
import Link from "next/link";
import { twitchCredentials } from "@/lib/env";

export const dynamic = "force-dynamic";

export default function HomePage() {
  const creds = twitchCredentials();
  const isDev = process.env.NODE_ENV !== "production";

  return (
    <main>
      <h1>SodaGift Live</h1>
      <p style={{ color: "#52525b" }}>
        Participants join a campaign by scanning its QR code, which opens{" "}
        <code>/c/&lt;publicId&gt;</code>. This page is just a dev landing.
      </p>

      {!creds.configured ? (
        <div
          style={{
            marginTop: "1.25rem",
            padding: "1rem 1.15rem",
            border: "1px solid #fca5a5",
            background: "#fef2f2",
            borderRadius: 8,
          }}
        >
          <strong>Twitch credentials not configured.</strong>
          <p style={{ margin: "0.5rem 0 0" }}>
            Add{" "}
            {creds.missing.map((name, i) => (
              <Fragment key={name}>
                {i > 0 ? " and " : ""}
                <code>{name}</code>
              </Fragment>
            ))}{" "}
            to <code>.env.local</code> from the Twitch Developer Console, then restart{" "}
            <code>npm run dev</code>.
          </p>
        </div>
      ) : null}

      {isDev ? (
        <ul style={{ marginTop: "1.25rem", lineHeight: 1.9 }}>
          <li>
            <Link href="/dev/campaigns">Dev: campaigns</Link> — list / open
          </li>
          <li>
            <Link href="/dev/campaigns/new">Dev: create a campaign</Link>
          </li>
          <li>
            <code>npm run seed</code> — create the sample campaign at{" "}
            <code>/c/sampledevcampaign</code>
          </li>
          <li>
            <Link href="/dev/host">Dev: Host OAuth + one test Whisper</Link>
          </li>
        </ul>
      ) : null}
    </main>
  );
}
