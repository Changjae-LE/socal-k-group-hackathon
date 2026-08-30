-- CreateTable
CREATE TABLE "Participant" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "twitchUserId" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Participant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Participant_campaignId_idx" ON "Participant"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "Participant_campaignId_twitchUserId_key" ON "Participant"("campaignId", "twitchUserId");

-- AddForeignKey
ALTER TABLE "Participant" ADD CONSTRAINT "Participant_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
