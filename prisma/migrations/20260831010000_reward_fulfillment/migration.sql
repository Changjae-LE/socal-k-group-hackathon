-- Reward fulfillment: ClaimToken + Reward + WhisperAttempt (CLAUDE.md §9 / §10).
-- Additive only — no existing column is altered, so the seeded Campaign / Participant /
-- Winner rows are untouched.

-- CreateEnum
CREATE TYPE "RewardStatus" AS ENUM ('AWAITING_SELECTION', 'ORDER_CREATING', 'ORDER_CREATED', 'FULFILLED', 'ORDER_FAILED', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "CustomAmountMode" AS ENUM ('FORBIDDEN', 'REQUIRED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "WhisperStatus" AS ENUM ('SENT', 'FAILED');

-- CreateTable
CREATE TABLE "ClaimToken" (
    "id" TEXT NOT NULL,
    "winnerId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClaimToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reward" (
    "id" TEXT NOT NULL,
    "winnerId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "status" "RewardStatus" NOT NULL DEFAULT 'AWAITING_SELECTION',
    "selectedProductId" TEXT,
    "selectedProductSnapshot" JSONB,
    "customAmountMode" "CustomAmountMode",
    "rewardAmount" DECIMAL(14,2),
    "rewardCurrency" TEXT,
    "unavailableReason" TEXT,
    "externalReferenceId" TEXT,
    "sodagiftOrderId" TEXT,
    "sodagiftOrderItemId" TEXT,
    "sodagiftOrderStatus" TEXT,
    "sodagiftItemStatus" TEXT,
    "rewardUrlEnc" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Reward_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhisperAttempt" (
    "id" TEXT NOT NULL,
    "winnerId" TEXT NOT NULL,
    "status" "WhisperStatus" NOT NULL,
    "twitchHttpStatus" INTEGER,
    "twitchErrorCode" TEXT,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhisperAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClaimToken_winnerId_key" ON "ClaimToken"("winnerId");

-- CreateIndex
CREATE UNIQUE INDEX "ClaimToken_tokenHash_key" ON "ClaimToken"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "Reward_winnerId_key" ON "Reward"("winnerId");

-- CreateIndex
CREATE UNIQUE INDEX "Reward_externalReferenceId_key" ON "Reward"("externalReferenceId");

-- CreateIndex
CREATE INDEX "Reward_campaignId_idx" ON "Reward"("campaignId");

-- CreateIndex
CREATE INDEX "WhisperAttempt_winnerId_idx" ON "WhisperAttempt"("winnerId");

-- AddForeignKey
ALTER TABLE "ClaimToken" ADD CONSTRAINT "ClaimToken_winnerId_fkey" FOREIGN KEY ("winnerId") REFERENCES "Winner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reward" ADD CONSTRAINT "Reward_winnerId_fkey" FOREIGN KEY ("winnerId") REFERENCES "Winner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reward" ADD CONSTRAINT "Reward_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhisperAttempt" ADD CONSTRAINT "WhisperAttempt_winnerId_fkey" FOREIGN KEY ("winnerId") REFERENCES "Winner"("id") ON DELETE CASCADE ON UPDATE CASCADE;
