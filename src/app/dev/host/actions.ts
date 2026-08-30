"use server";

import { notFound, redirect } from "next/navigation";
import { twitchCredentials } from "@/lib/env";
import { TEST_WHISPER_MESSAGE, sendWhisper } from "@/lib/twitch/host-oauth";
import {
  readHostSession,
  readWhisperOutcome,
  setWhisperOutcome,
} from "@/lib/auth/host-session";

const RECIPIENT_RE = /^\d{1,20}$/;
const COOLDOWN_MS = 10_000; // block accidental double-submits

/**
 * Send AT MOST ONE real Twitch Whisper per explicit click.
 * from_user_id comes ONLY from the validated host session identity.
 */
export async function sendTestWhisper(formData: FormData): Promise<void> {
  if (process.env.NODE_ENV === "production") notFound();

  const session = await readHostSession();
  if (!session) redirect("/dev/host?e=not_connected");

  if (!session.scopes.includes("user:manage:whispers")) {
    redirect("/dev/host?e=missing_scope");
  }

  const prev = await readWhisperOutcome();
  if (prev && Date.now() - prev.at < COOLDOWN_MS) {
    redirect("/dev/host?e=cooldown");
  }

  const toUserId = String(formData.get("recipientUserId") ?? "").trim();
  if (!RECIPIENT_RE.test(toUserId)) redirect("/dev/host?e=bad_recipient");
  if (toUserId === session.hostUserId) redirect("/dev/host?e=self");

  const creds = twitchCredentials();
  if (!creds.configured) redirect("/dev/host?e=not_configured");

  const result = await sendWhisper({
    accessToken: session.accessToken,
    clientId: creds.clientId,
    fromUserId: session.hostUserId, // validated host identity only
    toUserId,
    message: TEST_WHISPER_MESSAGE,
  });

  await setWhisperOutcome({
    at: Date.now(),
    httpStatus: result.httpStatus,
    accepted: result.accepted,
    toUserId,
    detail: result.twitchError
      ? [result.twitchError.error, result.twitchError.message].filter(Boolean).join(" — ")
      : undefined,
  });

  redirect("/dev/host");
}
