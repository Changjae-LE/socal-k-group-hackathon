import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "StreamDrop — Live rewards for global fans",
  description: "Twitch live reward overlay powered by SodaGift",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
