import type { CampaignStatus } from "@prisma/client";

/**
 * Display-safe, non-identifying representation of a numeric Twitch user id, e.g.
 * `1535160394` → `15•••••394`. We have no display-safe Twitch username persisted yet,
 * so the public result page shows this masked form. The full id stays server-side.
 */
export function maskTwitchId(id: string): string {
  const s = String(id ?? "");
  if (s.length <= 5) return "•".repeat(Math.max(3, s.length));
  return `${s.slice(0, 2)}${"•".repeat(s.length - 5)}${s.slice(-3)}`;
}

/** Operator/stream-friendly campaign status label. */
export function statusLabel(status: CampaignStatus): string {
  switch (status) {
    case "DRAFT":
      return "Not open yet";
    case "OPEN":
      return "OPEN";
    case "CLOSED":
      return "Entries closed";
    case "DRAWN":
      return "Winners drawn";
  }
}
