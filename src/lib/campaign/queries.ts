import "server-only";
import {
  Prisma,
  type Campaign,
  type CampaignStatus,
  type Participant,
  type Winner,
} from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { isWellFormedPublicId, newPublicId } from "@/lib/campaign/publicId";
import { RewardPolicy, type RewardPolicy as RewardPolicyT } from "@/lib/campaign/policy";
import { selectWinners } from "@/lib/campaign/draw";
import type { CampaignCatalogFilter } from "@/lib/sodagift/catalog";

export type { Campaign, CampaignStatus, Participant, Winner };

/** Translate a Campaign's constraints into a SodaGift catalog filter (§3A). */
export function campaignCatalogFilter(c: Campaign): CampaignCatalogFilter {
  return {
    requiredDeliveryMethod: c.requiredDeliveryMethod,
    allowedProductTypes: c.allowedProductTypes,
    eligibleCountries: c.isGlobal ? [] : c.eligibleCountries,
  };
}

/** Look up a campaign by its public slug. Rejects malformed slugs before hitting the DB. */
export async function getCampaignByPublicId(publicId: string): Promise<Campaign | null> {
  if (!isWellFormedPublicId(publicId)) return null;
  return prisma.campaign.findUnique({ where: { publicId } });
}

/** Look up a campaign by its internal id (host operation page). */
export async function getCampaignById(id: string): Promise<Campaign | null> {
  if (!/^[a-z0-9]{20,40}$/.test(id)) return null; // cuid shape
  return prisma.campaign.findUnique({ where: { id } });
}

/** A campaign a participant may currently join. Lifecycle: DRAFT → OPEN → CLOSED → DRAWN. */
export function isJoinable(c: Pick<Campaign, "status">): boolean {
  return c.status === "OPEN";
}

export type CreateCampaignInput = {
  name: string;
  isGlobal: boolean;
  eligibleCountries: string[];
  allowedProductTypes: string[];
  rewardPolicy: RewardPolicyT;
  rewardSelectionMode?: "PARTICIPANT_PRECHOICE" | "WINNER_CHOICE" | "BACKEND_SELECT";
  claimLinkMode?: "PROTECTED_TOKEN" | "SODAGIFT_DIRECT";
  winnerCount: number;
  /** Dev create / seed make campaigns immediately joinable (OPEN). */
  status?: "DRAFT" | "OPEN";
};

export async function createCampaign(input: CreateCampaignInput): Promise<Campaign> {
  const name = input.name.trim();
  if (name.length < 2 || name.length > 120) throw new Error("name must be 2–120 chars");

  const winnerCount = Math.trunc(input.winnerCount);
  if (!Number.isFinite(winnerCount) || winnerCount < 1 || winnerCount > 10_000) {
    throw new Error("winnerCount must be 1–10000");
  }

  const rewardPolicy = RewardPolicy.parse(input.rewardPolicy);

  const eligibleCountries = input.isGlobal
    ? []
    : [...new Set(input.eligibleCountries.map((c) => c.trim().toUpperCase()).filter(Boolean))];
  if (!input.isGlobal && eligibleCountries.length === 0) {
    throw new Error("non-global campaign needs at least one eligible country");
  }

  const allowedProductTypes = [
    ...new Set(input.allowedProductTypes.map((t) => t.trim().toUpperCase()).filter(Boolean)),
  ];

  const data: Prisma.CampaignCreateInput = {
    publicId: newPublicId(),
    name,
    isGlobal: input.isGlobal,
    eligibleCountries,
    requiredDeliveryMethod: "LINK", // MVP fixed
    allowedProductTypes,
    rewardPolicy: rewardPolicy as unknown as Prisma.InputJsonValue,
    rewardSelectionMode: input.rewardSelectionMode ?? "BACKEND_SELECT",
    claimLinkMode: input.claimLinkMode ?? "PROTECTED_TOKEN",
    winnerCount,
    status: input.status ?? "OPEN",
  };

  // Retry once on the (astronomically unlikely) publicId collision.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await prisma.campaign.create({ data: { ...data, publicId: newPublicId() } });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002" &&
        attempt < 2
      ) {
        continue;
      }
      throw err;
    }
  }
  throw new Error("could not allocate a unique publicId");
}

/** Dev-only: list recent campaigns. */
export async function listRecentCampaigns(limit = 25): Promise<Campaign[]> {
  return prisma.campaign.findMany({ orderBy: { createdAt: "desc" }, take: limit });
}

// ---------------------------------------------------------------------------
// Participants
// ---------------------------------------------------------------------------

/** Existing participation for this Twitch account in this campaign, or null. */
export async function getParticipant(
  campaignId: string,
  twitchUserId: string,
): Promise<Participant | null> {
  return prisma.participant.findUnique({
    where: { campaignId_twitchUserId: { campaignId, twitchUserId } },
  });
}

/** Live participant count for a campaign. */
export async function countParticipants(campaignId: string): Promise<number> {
  return prisma.participant.count({ where: { campaignId } });
}

/** Per-country participant breakdown, e.g. [{ countryCode: "US", count: 12 }, …]. */
export async function participantCountryBreakdown(
  campaignId: string,
): Promise<{ countryCode: string; count: number }[]> {
  const rows = await prisma.participant.groupBy({
    by: ["countryCode"],
    where: { campaignId },
    _count: { _all: true },
  });
  return rows
    .map((r) => ({ countryCode: r.countryCode, count: r._count._all }))
    .sort((a, b) => b.count - a.count || a.countryCode.localeCompare(b.countryCode));
}

/**
 * Idempotent join. `twitchUserId` MUST be the verified OIDC sub; `campaignId` MUST be
 * resolved server-side from the campaign publicId; `countryCode` MUST already be
 * validated against the campaign. Duplicate joins return the existing row — never a
 * second row (enforced by UNIQUE(campaignId, twitchUserId)).
 */
export async function joinCampaign(args: {
  campaignId: string;
  twitchUserId: string;
  countryCode: string;
}): Promise<{ participant: Participant; alreadyJoined: boolean }> {
  try {
    const participant = await prisma.participant.create({
      data: {
        campaignId: args.campaignId,
        twitchUserId: args.twitchUserId,
        countryCode: args.countryCode,
      },
    });
    return { participant, alreadyJoined: false };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // Unique (campaignId, twitchUserId) violation → already joined. Return that row,
      // unchanged (first join wins for countryCode / joinedAt).
      const existing = await getParticipant(args.campaignId, args.twitchUserId);
      if (existing) return { participant: existing, alreadyJoined: true };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Host operations: close / reopen entries, draw winners
// ---------------------------------------------------------------------------

/** Operator-facing draw failure with a clear message (never leaks internals). */
export class DrawError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DrawError";
  }
}

/** OPEN → CLOSED. Idempotent (CLOSED stays CLOSED). Never touches DRAWN/DRAFT. */
export async function closeEntries(campaignId: string): Promise<CampaignStatus> {
  const res = await prisma.campaign.updateMany({
    where: { id: campaignId, status: "OPEN" },
    data: { status: "CLOSED" },
  });
  const c = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { status: true },
  });
  if (!c) throw new DrawError("Campaign not found.");
  if (res.count === 0 && c.status !== "CLOSED") {
    throw new DrawError(`Cannot close entries while campaign is ${c.status}.`);
  }
  return c.status;
}

/** CLOSED → OPEN, only before a draw. DRAWN can never be reopened. */
export async function reopenEntries(campaignId: string): Promise<CampaignStatus> {
  const res = await prisma.campaign.updateMany({
    where: { id: campaignId, status: "CLOSED" },
    data: { status: "OPEN" },
  });
  const c = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { status: true },
  });
  if (!c) throw new DrawError("Campaign not found.");
  if (res.count === 0 && c.status !== "OPEN") {
    throw new DrawError(`Cannot reopen entries while campaign is ${c.status}.`);
  }
  return c.status;
}

export type WinnerWithParticipant = Winner & {
  participant: Pick<Participant, "twitchUserId" | "countryCode">;
};

/** Persisted winners for a campaign, ordered by draw sequence. */
export async function getWinners(campaignId: string): Promise<WinnerWithParticipant[]> {
  return prisma.winner.findMany({
    where: { campaignId },
    orderBy: { drawSequence: "asc" },
    include: { participant: { select: { twitchUserId: true, countryCode: true } } },
  });
}

/** Winners + their Reward + latest WhisperAttempt — the host operation page's fulfillment view. */
export async function getFulfillmentView(campaignId: string) {
  return prisma.winner.findMany({
    where: { campaignId },
    orderBy: { drawSequence: "asc" },
    include: {
      participant: { select: { twitchUserId: true, countryCode: true } },
      reward: {
        select: {
          status: true,
          rewardAmount: true,
          rewardCurrency: true,
          selectedProductId: true,
          sodagiftOrderId: true,
          unavailableReason: true,
        },
      },
      whisperAttempts: {
        orderBy: { attemptedAt: "desc" },
        take: 1,
        select: { status: true, twitchHttpStatus: true, twitchErrorCode: true, attemptedAt: true },
      },
    },
  });
}

export type FulfillmentRow = Awaited<ReturnType<typeof getFulfillmentView>>[number];

/**
 * Draw `campaign.winnerCount` distinct winners — ATOMICALLY.
 *
 *  - One Serializable transaction: lock the Campaign row (`FOR UPDATE`), check status,
 *    read eligible Participants, insert Winners, flip status → DRAWN — all committed together.
 *  - Concurrency/double-click safe: the row lock serializes competing draws; the loser
 *    re-reads `status = DRAWN` and returns the SAME persisted winners.
 *  - Already DRAWN → returns the existing winners, never redraws.
 *  - Only CLOSED campaigns may be drawn.
 *  - participantCount < winnerCount → DrawError (does NOT silently draw fewer).
 *  - CSPRNG selection (`node:crypto`), never Math.random().
 */
export async function drawWinners(
  campaignId: string,
): Promise<{ winners: WinnerWithParticipant[]; alreadyDrawn: boolean }> {
  return prisma.$transaction(
    async (tx) => {
      const locked = await tx.$queryRaw<{ status: CampaignStatus; winnerCount: number }[]>`
        SELECT "status", "winnerCount" FROM "Campaign" WHERE "id" = ${campaignId} FOR UPDATE
      `;
      if (locked.length === 0) throw new DrawError("Campaign not found.");
      const { status, winnerCount } = locked[0];

      if (status === "DRAWN") {
        const winners = await winnersInTx(tx, campaignId);
        return { winners, alreadyDrawn: true };
      }
      if (status !== "CLOSED") {
        throw new DrawError(
          `Campaign must be CLOSED to draw winners (currently ${status}). Close entries first.`,
        );
      }

      const participants = await tx.participant.findMany({
        where: { campaignId },
        select: { id: true },
      });
      if (participants.length < winnerCount) {
        throw new DrawError(
          `Not enough participants to draw ${winnerCount} winner${winnerCount === 1 ? "" : "s"} ` +
            `(only ${participants.length} joined).`,
        );
      }

      const chosen = selectWinners(
        participants.map((p) => p.id),
        winnerCount,
      );

      await tx.winner.createMany({
        data: chosen.map((participantId, i) => ({
          campaignId,
          participantId,
          drawSequence: i + 1,
        })),
      });

      const flipped = await tx.campaign.updateMany({
        where: { id: campaignId, status: "CLOSED" },
        data: { status: "DRAWN", drawnAt: new Date() },
      });
      if (flipped.count !== 1) {
        // Someone else committed a draw between our lock and here — abort; on retry we
        // hit the `status === "DRAWN"` branch above and return their winners.
        throw new DrawError("Draw was already committed concurrently; please retry.");
      }

      const winners = await winnersInTx(tx, campaignId);
      return { winners, alreadyDrawn: false };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

async function winnersInTx(
  tx: Prisma.TransactionClient,
  campaignId: string,
): Promise<WinnerWithParticipant[]> {
  return tx.winner.findMany({
    where: { campaignId },
    orderBy: { drawSequence: "asc" },
    include: { participant: { select: { twitchUserId: true, countryCode: true } } },
  });
}
