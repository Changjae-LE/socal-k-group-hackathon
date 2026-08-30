-- CampaignStatus:  DRAFT | PUBLISHED | DRAWING | DRAWN | CLOSED
--            ->    DRAFT | OPEN | CLOSED | DRAWN
-- Existing data is preserved: PUBLISHED -> OPEN, DRAWING -> CLOSED.
CREATE TYPE "CampaignStatus_new" AS ENUM ('DRAFT', 'OPEN', 'CLOSED', 'DRAWN');

ALTER TABLE "Campaign" ALTER COLUMN "status" DROP DEFAULT;

ALTER TABLE "Campaign"
  ALTER COLUMN "status" TYPE "CampaignStatus_new"
  USING (
    (CASE "status"::text
       WHEN 'PUBLISHED' THEN 'OPEN'
       WHEN 'DRAWING'   THEN 'CLOSED'
       ELSE "status"::text
     END)::"CampaignStatus_new"
  );

ALTER TABLE "Campaign" ALTER COLUMN "status" SET DEFAULT 'DRAFT';

DROP TYPE "CampaignStatus";
ALTER TYPE "CampaignStatus_new" RENAME TO "CampaignStatus";

-- CreateTable
CREATE TABLE "Winner" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "drawSequence" INTEGER NOT NULL,
    "drawnAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Winner_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Winner_participantId_key" ON "Winner"("participantId");

-- CreateIndex
CREATE INDEX "Winner_campaignId_idx" ON "Winner"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "Winner_campaignId_participantId_key" ON "Winner"("campaignId", "participantId");

-- CreateIndex
CREATE UNIQUE INDEX "Winner_campaignId_drawSequence_key" ON "Winner"("campaignId", "drawSequence");

-- AddForeignKey
ALTER TABLE "Winner" ADD CONSTRAINT "Winner_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Winner" ADD CONSTRAINT "Winner_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "Participant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
