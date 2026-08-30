// Post-draw fulfillment (CLAUDE.md §9 / §10):
//   persisted Winner → Winner.participant.twitchUserId (from the DB) + .countryCode
//     → mint a one-time claim token  → Twitch Whisper `${APP_URL}/claim/<token>`
//   winner opens /claim/<token> → verify Twitch identity → pick a country-specific product
//     → resolve the order contract → POST /v1/orders (LINK) → store the voucher URL encrypted
//
// No hardcoded / host-entered SodaGift product id anywhere. The recipient Twitch id always
// comes from Winner.participant.twitchUserId (the verified OIDC sub captured at join).

import "server-only";
import { randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import {
  claimTokenTtlHours,
  env,
  sodagiftSenderName,
  twitchCredentials,
} from "@/lib/env";
import { readHostSession } from "@/lib/auth/host-session";
import { sendWhisper } from "@/lib/twitch/host-oauth";
import { hashClaimToken, loadClaim, sameTwitchUser } from "@/lib/campaign/claim";
import { parseRewardPolicy } from "@/lib/campaign/policy";
import { listProducts } from "@/lib/sodagift/catalog";
import { newExternalReferenceId } from "@/lib/sodagift/schemas";
import { resolveOrderContract } from "@/lib/sodagift/order-contract";
import { createLinkOrder, getOrderById } from "@/lib/sodagift/order";
import { SodaGiftError } from "@/lib/sodagift/client";
import { encryptSecret } from "@/lib/crypto/secretbox";

/** Fixed display label sent as `delivery.recipient.name`. Never a real name / PII. */
const RECIPIENT_LABEL = "SodaGift Live Winner";

async function ensureReward(winnerId: string, campaignId: string, countryCode: string) {
  return prisma.reward.upsert({
    where: { winnerId },
    create: { winnerId, campaignId, countryCode, status: "AWAITING_SELECTION" },
    update: {},
  });
}

/**
 * Fresh one-time claim token for a winner (upsert by winnerId — one live token per winner).
 * Only the SHA-256 hash is stored; the raw string is returned in memory and never persisted
 * or logged. Callers must only build `${APP_URL}/claim/<raw>` and hand it to the Whisper.
 */
async function mintClaimToken(winnerId: string): Promise<string> {
  const raw = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + claimTokenTtlHours() * 3_600_000);
  await prisma.claimToken.upsert({
    where: { winnerId },
    create: { winnerId, tokenHash: hashClaimToken(raw), expiresAt },
    update: { tokenHash: hashClaimToken(raw), expiresAt, consumedAt: null, failedAttempts: 0 },
  });
  return raw;
}

export type NotifyResult = {
  hostConnected: boolean;
  sent: number;
  failed: number;
  skipped: number;
  reason: "ok" | "not_drawn" | "no_host";
};

/**
 * Ensure every winner of a DRAWN campaign has a Reward row, then Whisper a claim link to
 * each winner that has not already been successfully whispered. Idempotent and re-runnable:
 * a winner with a `WhisperAttempt { status: SENT }` is skipped (and their token is NOT
 * rotated). Best-effort — a Twitch failure is recorded, never thrown.
 */
export async function notifyWinners(campaignId: string): Promise<NotifyResult> {
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) throw new Error("campaign not found");
  if (campaign.status !== "DRAWN") {
    return { hostConnected: false, sent: 0, failed: 0, skipped: 0, reason: "not_drawn" };
  }

  const winners = await prisma.winner.findMany({
    where: { campaignId },
    orderBy: { drawSequence: "asc" },
    include: {
      participant: { select: { twitchUserId: true, countryCode: true } },
      whisperAttempts: { where: { status: "SENT" }, select: { id: true } },
    },
  });

  // Rewards exist regardless of a host connection so the authenticated /claim fallback works.
  for (const w of winners) {
    await ensureReward(w.id, campaignId, w.participant.countryCode);
  }

  const host = await readHostSession();
  const creds = twitchCredentials();
  if (!host || !host.scopes.includes("user:manage:whispers") || !creds.configured) {
    return { hostConnected: false, sent: 0, failed: 0, skipped: winners.length, reason: "no_host" };
  }

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  for (const w of winners) {
    if (w.whisperAttempts.length > 0) {
      skipped += 1;
      continue;
    }
    const raw = await mintClaimToken(w.id);
    const message = (
      `You won ${campaign.name}! Choose and claim your reward here: ` +
      `${env().APP_URL}/claim/${raw}`
    ).slice(0, 500);

    const res = await sendWhisper({
      accessToken: host.accessToken,
      clientId: creds.clientId,
      fromUserId: host.hostUserId, // validated host identity only
      toUserId: w.participant.twitchUserId, // verified OIDC sub from the DB
      message,
    });

    await prisma.whisperAttempt.create({
      data: {
        winnerId: w.id,
        status: res.accepted ? "SENT" : "FAILED",
        twitchHttpStatus: res.httpStatus,
        twitchErrorCode:
          res.twitchError?.error ??
          (typeof res.twitchError?.status === "number" ? String(res.twitchError.status) : null),
      },
    });

    if (res.accepted) sent += 1;
    else failed += 1;
  }
  return { hostConnected: true, sent, failed, skipped, reason: "ok" };
}

export type FulfillResult = { ok: true } | { ok: false; error: string };

/**
 * The winner has authenticated (verified OIDC `sub`) and picked a product on /claim/<token>.
 * Re-verify everything, re-validate the product against the LIVE catalog for the winner's
 * country, resolve the order contract, then create the SodaGift LINK order (idempotent via a
 * frozen `externalReferenceId`) and store the voucher URL encrypted.
 */
export async function fulfillClaim(args: {
  rawToken: string;
  sub: string;
  productId: number;
}): Promise<FulfillResult> {
  const claim = await loadClaim(args.rawToken);
  if (!claim) return { ok: false, error: "not_found" };
  if (claim.consumedAt == null && claim.expiresAt.getTime() < Date.now()) {
    return { ok: false, error: "expired" };
  }

  const { winner } = claim;
  const { participant, campaign } = winner;

  if (!sameTwitchUser(args.sub, participant.twitchUserId)) {
    await prisma.claimToken.update({
      where: { id: claim.id },
      data: { failedAttempts: { increment: 1 } },
    });
    return { ok: false, error: "identity_mismatch" };
  }

  const reward =
    winner.reward ?? (await ensureReward(winner.id, winner.campaignId, participant.countryCode));
  if (reward.status === "ORDER_CREATED" || reward.status === "FULFILLED") {
    return { ok: true }; // already fulfilled — idempotent
  }

  // Re-fetch the LIVE catalog; re-validate the winner's choice for THEIR country.
  const catalog = await listProducts({ force: true });
  const product = catalog.find((p) => p.id === args.productId);
  if (!product) return { ok: false, error: "product_unavailable" };

  const contract = resolveOrderContract({
    product,
    policy: parseRewardPolicy(campaign.rewardPolicy),
    allowedProductTypes: campaign.allowedProductTypes,
    countryCode: participant.countryCode,
  });
  if (!contract.orderable) {
    await prisma.reward.update({
      where: { id: reward.id },
      data: {
        status: "UNAVAILABLE",
        unavailableReason: contract.reason,
        selectedProductId: String(product.id),
        selectedProductSnapshot: product as unknown as Prisma.InputJsonValue,
      },
    });
    return { ok: false, error: contract.reason };
  }

  // Concurrency guard + freeze the idempotency key on the first attempt.
  const externalReferenceId = reward.externalReferenceId ?? newExternalReferenceId();
  const claimed = await prisma.reward.updateMany({
    where: { id: reward.id, status: { in: ["AWAITING_SELECTION", "ORDER_FAILED", "UNAVAILABLE"] } },
    data: {
      status: "ORDER_CREATING",
      selectedProductId: String(product.id),
      selectedProductSnapshot: product as unknown as Prisma.InputJsonValue,
      customAmountMode: contract.customAmountMode,
      rewardAmount: contract.rewardAmount,
      rewardCurrency: contract.rewardCurrency,
      externalReferenceId,
      unavailableReason: null,
    },
  });
  if (claimed.count !== 1) return { ok: false, error: "in_progress" };

  try {
    const created = await createLinkOrder({
      item: contract.item,
      recipientName: RECIPIENT_LABEL,
      senderName: sodagiftSenderName(),
      message: `Your ${campaign.name} reward`,
      externalReferenceId,
    });
    const fetched = await getOrderById(created.orderId);

    await prisma.reward.update({
      where: { id: reward.id },
      data: {
        status: fetched.itemStatus === "COMPLETED" ? "FULFILLED" : "ORDER_CREATED",
        sodagiftOrderId: created.orderId,
        sodagiftOrderItemId: created.orderItemId,
        sodagiftOrderStatus: fetched.orderStatus ?? created.orderStatus,
        sodagiftItemStatus: fetched.itemStatus ?? created.itemStatus,
        rewardUrlEnc: fetched.voucherLink ? encryptSecret(fetched.voucherLink) : null,
      },
    });
    await prisma.claimToken.update({
      where: { id: claim.id },
      data: { consumedAt: new Date() },
    });
    return { ok: true };
  } catch (err) {
    await prisma.reward.update({ where: { id: reward.id }, data: { status: "ORDER_FAILED" } });
    if (err instanceof SodaGiftError) {
      return {
        ok: false,
        error: `order_failed (HTTP ${err.status}${err.errorCode ? ` ${err.errorCode}` : ""})`,
      };
    }
    return { ok: false, error: "order_failed" };
  }
}
