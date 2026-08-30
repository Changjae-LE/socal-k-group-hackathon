import type { ReactNode } from "react";

export const metadata = {
  title: "SodaGift Live — Twitch OIDC proof",
  description: "Local proof: authenticate a participant via Twitch OpenID Connect.",
};

const bodyStyle: React.CSSProperties = {
  fontFamily:
    'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  margin: 0,
  padding: "2.5rem 1.5rem",
  lineHeight: 1.55,
  color: "#18181b",
  background: "#fafafa",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={bodyStyle}>
        <div style={{ maxWidth: 560, margin: "0 auto" }}>{children}</div>
      </body>
    </html>
  );
}
