"use server";

import { notFound, redirect } from "next/navigation";
import {
  DrawError,
  closeEntries,
  drawWinners,
  getCampaignById,
  reopenEntries,
} from "@/lib/campaign/queries";
import { notifyWinners } from "@/lib/campaign/fulfillment";

function devOnly() {
  if (process.env.NODE_ENV === "production") notFound();
}

async function run(
  id: string,
  fn: () => Promise<Record<string, string>>,
): Promise<void> {
  devOnly();
  const campaign = await getCampaignById(id);
  if (!campaign) notFound();

  let query: Record<string, string>;
  try {
    query = await fn();
  } catch (err) {
    if (err instanceof DrawError) query = { e: err.message };
    else throw err;
  }
  // redirect() throws NEXT_REDIRECT — kept OUT of the try so it is not swallowed.
  redirect(`/host/campaigns/${id}?${new URLSearchParams(query).toString()}`);
}

export async function closeEntriesAction(id: string): Promise<void> {
  await run(id, async () => {
    await closeEntries(id);
    return { ok: "closed" };
  });
}

export async function reopenEntriesAction(id: string): Promise<void> {
  await run(id, async () => {
    await reopenEntries(id);
    return { ok: "reopened" };
  });
}

export async function drawWinnersAction(id: string): Promise<void> {
  await run(id, async () => {
    const { alreadyDrawn } = await drawWinners(id);
    if (!alreadyDrawn) {
      // Best-effort: mint claim tokens + Whisper each winner right after the draw commits.
      // A Twitch/host failure never rolls back the draw — the host can retry from the page.
      try {
        await notifyWinners(id);
      } catch {
        /* recorded per-winner; surfaced in the Fulfillment section */
      }
    }
    return { ok: alreadyDrawn ? "already_drawn" : "drawn" };
  });
}

export async function sendWhispersAction(id: string): Promise<void> {
  await run(id, async (): Promise<Record<string, string>> => {
    const r = await notifyWinners(id);
    if (r.reason === "not_drawn") return { e: "Draw the winners first." };
    if (r.reason === "no_host") {
      return { e: "Connect a Host Twitch account at /dev/host (scope user:manage:whispers), then retry." };
    }
    return { ok: `whispers:${r.sent} sent, ${r.failed} failed, ${r.skipped} already sent` };
  });
}
