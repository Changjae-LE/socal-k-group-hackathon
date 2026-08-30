/**
 * scripts/seed-campaign.ts  —  create one sample campaign without the dev UI.
 *
 *   npm run seed            (= tsx scripts/seed-campaign.ts)
 *
 * Idempotent: upserts a campaign with a fixed publicId so the URL is stable across runs.
 * Reads DATABASE_URL from .env / .env.local.
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PrismaClient } from "@prisma/client";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnvFile(name: string): void {
  const p = join(REPO_ROOT, name);
  if (!existsSync(p)) return;
  for (const raw of readFileSync(p, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
// .env.local wins over .env (load .env.local first so it takes precedence)
loadEnvFile(".env.local");
loadEnvFile(".env");

const SAMPLE_PUBLIC_ID = "sampledevcampaign";
const APP_URL = (process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set (see .env / docker-compose.yml).");
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const data = {
      name: "Sample Global Giveaway",
      isGlobal: true,
      eligibleCountries: [] as string[],
      requiredDeliveryMethod: "LINK" as const,
      allowedProductTypes: ["GIFT_CARD"],
      rewardPolicy: { kind: "TARGET_VALUE", amount: 5, currency: "USD" },
      rewardSelectionMode: "BACKEND_SELECT" as const,
      claimLinkMode: "PROTECTED_TOKEN" as const,
      winnerCount: 3,
      status: "OPEN" as const,
    };

    const campaign = await prisma.campaign.upsert({
      where: { publicId: SAMPLE_PUBLIC_ID },
      create: { publicId: SAMPLE_PUBLIC_ID, ...data },
      update: data,
    });

    console.log("Sample campaign ready:");
    console.log("  id       :", campaign.id);
    console.log("  publicId :", campaign.publicId);
    console.log("  status   :", campaign.status);
    console.log("  URL      :", `${APP_URL}/c/${campaign.publicId}`);
    console.log("  QR       :", `${APP_URL}/api/c/${campaign.publicId}/qr.png`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
