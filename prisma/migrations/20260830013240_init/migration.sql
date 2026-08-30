-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'DRAWING', 'DRAWN', 'CLOSED');

-- CreateEnum
CREATE TYPE "DeliveryMethod" AS ENUM ('EMAIL', 'LINK', 'TEXT', 'CODE', 'DIRECT_SHIPPING');

-- CreateEnum
CREATE TYPE "RewardSelectionMode" AS ENUM ('PARTICIPANT_PRECHOICE', 'WINNER_CHOICE', 'BACKEND_SELECT');

-- CreateEnum
CREATE TYPE "ClaimLinkMode" AS ENUM ('PROTECTED_TOKEN', 'SODAGIFT_DIRECT');

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "hostId" TEXT,
    "name" TEXT NOT NULL,
    "isGlobal" BOOLEAN NOT NULL DEFAULT true,
    "eligibleCountries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requiredDeliveryMethod" "DeliveryMethod" NOT NULL DEFAULT 'LINK',
    "allowedProductTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rewardPolicy" JSONB NOT NULL,
    "rewardSelectionMode" "RewardSelectionMode" NOT NULL DEFAULT 'BACKEND_SELECT',
    "claimLinkMode" "ClaimLinkMode" NOT NULL DEFAULT 'PROTECTED_TOKEN',
    "winnerCount" INTEGER NOT NULL DEFAULT 1,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "drawnAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Campaign_publicId_key" ON "Campaign"("publicId");

-- CreateIndex
CREATE INDEX "Campaign_status_idx" ON "Campaign"("status");
