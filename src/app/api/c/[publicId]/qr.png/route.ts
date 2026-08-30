// GET /api/c/[publicId]/qr.png
// PNG QR code whose payload is ONLY the public campaign URL: `${APP_URL}/c/${publicId}`.
// No Twitch user id, internal campaign id, token, country, or reward data is encoded.

import { NextResponse } from "next/server";
import QRCode from "qrcode";
import { env } from "@/lib/env";
import { getCampaignByPublicId } from "@/lib/campaign/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ publicId: string }> },
) {
  const { publicId } = await ctx.params;
  const campaign = await getCampaignByPublicId(publicId);
  if (!campaign) {
    return new NextResponse("Not found", { status: 404 });
  }

  const payload = `${env().APP_URL}/c/${campaign.publicId}`; // <-- the only thing encoded

  const png = await QRCode.toBuffer(payload, {
    type: "png",
    errorCorrectionLevel: "M",
    margin: 2,
    width: 512,
  });

  return new NextResponse(new Uint8Array(png), {
    status: 200,
    headers: {
      "content-type": "image/png",
      "cache-control": "public, max-age=3600",
    },
  });
}
