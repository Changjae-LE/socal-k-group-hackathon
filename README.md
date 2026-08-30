# SodaGift Live

Global Twitch-giveaway app. Architecture and decisions live in **`CLAUDE.md`** (read it
first). The app is built milestone-by-milestone.

## Current state

- **Twitch participant OIDC** — verified (`CLAUDE.md` §17).
- **Country selection + country-specific SodaGift catalog** — verified.
- **Campaign + publicId + QR** — this milestone: Prisma + PostgreSQL, `Campaign` model,
  dev-only campaign creation, `publicId`, `/c/[publicId]`, QR generation, and the
  campaign-scoped participant flow.

Not yet: Participant DB rows, winner selection, SodaGift order creation, Host OAuth, Twitch
Whisper (all later milestones; Whisper is a required V1 feature).

## Setup

```powershell
# 1. Postgres (Docker)
docker compose up -d

# 2. deps + Prisma client + schema
npm install
npx prisma generate
npx prisma migrate dev --name init

# 3. env — .env holds DATABASE_URL (Prisma CLI + Next both read it);
#    .env.local holds TWITCH_* and SODAGIFT_* secrets.

# 4. a sample campaign
npm run seed        # -> /c/sampledevcampaign

# 5. run
npm run dev         # http://localhost:3000
```

`/dev/campaigns` (dev-only) lists campaigns; `/dev/campaigns/new` creates one. Both are
blocked when `NODE_ENV=production`.

## Participant flow

`/c/<publicId>` → **Continue with Twitch** → Twitch OIDC → `/c/<publicId>/country` →
`/c/<publicId>/rewards?country=XX`. The QR code on `/c/<publicId>` encodes only that URL.

## Dev scripts

`scripts/sodagift-probe*.ts` and `scripts/seed-campaign.ts` — run with
`npx tsx scripts/<name>.ts` (or `npm run seed`). Excluded from the Next build.
