# CLAUDE.md — SodaGift Live

Authoritative architecture for this repository. Last updated: 2026-08-29.

`C:\soda` was empty when this was written. There is **no** prior architecture. If you
find code or docs that assume the superseded design, treat them as wrong and replace them.

---

## 1. What this product is

SodaGift Live lets a Twitch streamer ("host") run a **global** giveaway during a live
stream. The host shows a QR code on stream; viewers scan it, authenticate with Twitch, and
**select their country**; the country (user-chosen, never inferred from Twitch) determines
which SodaGift rewards are valid for them. The host draws winners on the backend; each
winner is fulfilled with a SodaGift **`LINK`** reward resolved **in that winner's country**
(so one campaign yields US, KR, JP, … winners with different country-specific products).
Winners are notified by Twitch Whisper (carrying our identity-gated `/claim/<token>` URL)
and can self-discover by returning to the authenticated campaign page. All SodaGift calls
are server-side (SodaGift Sandbox API). See §3A for the global model.

### Explicitly OUT OF SCOPE / FORBIDDEN in V1

Do **not** design, reintroduce, or reference any of the following. Earlier drafts used some
of these; they are dead.

- Twitch **Get Chatters** API
- Twitch **EventSub**
- Chat commands / `!gift` / chat bots / reading chat at all
- Selecting winners from "current Twitch chatters"
- OBS integration, Twitch Extensions
- Quizzes, multiple social platforms
- Physical fulfillment (unless a later requirement forces it)
- SodaGift recipient-provided / acceptance-link behavior unless the exact request/response
  contract is verified against official SodaGift docs
- Inventing SodaGift API fields

Winners come only from **Participant records created by authenticated OIDC login**.

---

## 2. Tech stack

- Next.js (App Router) + TypeScript
- PostgreSQL + Prisma
- Zod for all input validation (route handlers, server actions, external responses)
- `jose` for all JWT/OIDC/JWE work (ID-token verification, session cookies, state cookies)
- Twitch OAuth 2.0 Authorization Code + PKCE (host) and Twitch OIDC Authorization Code + PKCE (participant)
- SodaGift **Sandbox** API (server-side only)
- `node:crypto` for CSPRNG, hashing, AES-256-GCM

No third-party auth library. No client-side Twitch or SodaGift calls, ever.

---

## 3. Final database schema

Prisma models. IDs are `cuid()` unless noted. All timestamps `DateTime`. "Encrypted"
columns store AES-256-GCM output (`iv || ciphertext || authTag`, base64) using
`TOKEN_ENCRYPTION_KEY`; they are never logged.

### Host
| field | type | notes |
|---|---|---|
| id | String PK | |
| twitchUserId | String, **UNIQUE** | Twitch Helix user id of the host. Authoritative identity. |
| twitchLogin | String? | display/debug only, non-authoritative |
| twitchDisplayName | String? | display only, never used for authz |
| accessTokenEnc | String | encrypted Twitch user access token |
| refreshTokenEnc | String | encrypted Twitch refresh token |
| tokenScopes | String[] | granted scopes; must contain `user:manage:whispers` |
| tokenExpiresAt | DateTime | absolute expiry of access token |
| sessionVersion | Int, default 1 | bump to invalidate all host sessions |
| needsReconnect | Boolean, default false | set when refresh fails / scope missing |
| createdAt / updatedAt | DateTime | |

### Campaign  (GLOBAL — no single product binding)

A campaign is **country-agnostic**. It expresses a **reward policy**, not a product. The
concrete SodaGift product for each winner is resolved later against **that winner's
`Participant.countryCode`** (see §3A). One campaign can produce winners in US, KR, JP, …
each fulfilled with a different country-specific product.

| field | type | notes |
|---|---|---|
| id | String PK | internal, used for FKs |
| hostId | String FK → Host | |
| publicId | String, **UNIQUE** | unguessable slug (`base64url(randomBytes(9))`), used in public URL + QR |
| name | String | |
| isGlobal | Boolean, default true | `true` → any country the SodaGift catalog currently supports (ON_SALE + `LINK`) is selectable |
| eligibleCountries | String[] | ISO 3166-1 alpha-2. Used **only when `isGlobal = false`** to restrict selectable countries. Empty when global. |
| requiredDeliveryMethod | Enum `DeliveryMethod` | **MVP fixed = `LINK`**. Products not offering it are never selectable/fulfillable. |
| allowedProductTypes | String[] | SodaGift `type` values (e.g. `["GIFT_CARD"]`). Empty = any type. |
| rewardPolicy | Json | country-agnostic value policy, e.g. `{ "kind": "TARGET_VALUE", "amount": 5, "currency": "USD" }` or `{ "kind": "VALUE_RANGE", "min": 3, "max": 10, "currency": "USD" }` or `{ "kind": "BUDGET_PER_WINNER", "amount": 5, "currency": "USD" }`. The `currency` is a **reference** currency for cross-country comparison; the actual product currency is the country's. Kept as `Json` so the policy can evolve without a migration. |
| rewardSelectionMode | Enum `RewardSelectionMode` | `PARTICIPANT_PRECHOICE` (A) \| `WINNER_CHOICE` (B) \| `BACKEND_SELECT` (C). **Not finally decided** — all three are modellable; a campaign picks one. See §3A. |
| claimLinkMode | Enum `ClaimLinkMode`, default `PROTECTED_TOKEN` | what the **Twitch Whisper's** claim link is: `PROTECTED_TOKEN` → our `${APP_URL}/claim/<rawToken>` (verify authenticated Twitch user == winner → redirect to stored SodaGift URL); `SODAGIFT_DIRECT` → the raw SodaGift `delivery.link`. **A-vs-B not permanently decided** (§9/§10); default is the protected token because the SodaGift URL's expiry/reuse/binding semantics are **unverified** (§11 point 13) — the safer design under uncertainty. |
| winnerCount | Int | requested number of winners, ≥ 1 |
| status | Enum `CampaignStatus` | **`DRAFT` → `OPEN` → `CLOSED` → `DRAWN`** (implemented). `OPEN`: joins allowed. `CLOSED`: joins rejected, draw allowed. `DRAWN`: terminal — joins rejected, reopen rejected, re-draw returns the existing winners. `CLOSED → OPEN` reopen allowed only before a draw; **never `DRAWN → OPEN`**. |
| drawnAt | DateTime? | set exactly once, atomically with `status → DRAWN` |
| createdAt / updatedAt | DateTime | |

`RewardSelectionMode`: `PARTICIPANT_PRECHOICE` \| `WINNER_CHOICE` \| `BACKEND_SELECT`.
`ClaimLinkMode`: `PROTECTED_TOKEN` (default) \| `SODAGIFT_DIRECT` — keeps Whisper claim-link
option A vs B open (§9/§10).
`DeliveryMethod`: `EMAIL` \| `LINK` \| `TEXT` \| `CODE` \| `DIRECT_SHIPPING` — mirrors the
SodaGift catalog values. **MVP campaigns use `LINK` only** (real fulfillment path, §9/§11).
`EMAIL` is a dev-only `lib/sodagift` baseline, never a campaign option. `TEXT` / `CODE` /
`DIRECT_SHIPPING` are surfaced from the catalog but not implemented.

There is **no** `sodagiftProductId` / `rewardKind` / `customAmountMode` / `rewardCurrency` on
`Campaign` any more — those are per-product and now live on `CampaignCountryOption` (optional
host curation) and on `Reward` (the resolved per-winner product). See §3A.

### CampaignCountryOption  (optional — explicit per-country curation)

Present only when the host wants to pin exact product(s) per country (supports selection
modes A/B and a curated C). Absent → the backend derives eligible products from
`rewardPolicy` + the live catalog for that country.

| field | type | notes |
|---|---|---|
| id | String PK | |
| campaignId | String FK → Campaign | |
| countryCode | String | ISO 3166-1 alpha-2 |
| sodagiftProductId | String | numeric SodaGift product id as string; must be ON_SALE + offer `requiredDeliveryMethod` + type in `allowedProductTypes` at add time |
| sodagiftProductSnapshot | Json | full `/v1/products` object frozen when the option is added |
| createdAt | DateTime | |
| | | **UNIQUE(campaignId, countryCode, sodagiftProductId)** |

### Participant
| field | type | notes |
|---|---|---|
| id | String PK | |
| campaignId | String FK → Campaign | |
| twitchUserId | String | OIDC `sub`. **Authoritative** identity of the entrant. Never display name / `preferred_username`. |
| countryCode | String | **ISO 3166-1 alpha-2, USER-SELECTED — the source of truth.** Not inferred from Twitch. Must be a member of the campaign's derived *selectable countries* (§3A). Editable while campaign is `PUBLISHED`; frozen at `DRAWING`. |
| joinedAt | DateTime | set when the participant completes country selection (= joins) |
| twitchLoginAtEntry | String? | snapshot, non-authoritative |
| twitchDisplayNameAtEntry | String? | display only |
| selectedProductId | String? | selection mode **A** only (`PARTICIPANT_PRECHOICE`): the SodaGift product the participant pre-picked from *their country's* filtered list. Re-validated at draw. Null otherwise. |
| selectedProductSnapshot | Json? | frozen product object when `selectedProductId` is set |
| eligible | Boolean, default true | derived: `countryCode` in selectable set **and** ≥ 1 catalog product exists for `countryCode` matching campaign policy (`ON_SALE` + `LINK` + type). |
| createdAt / updatedAt | DateTime | |
| | | **UNIQUE(campaignId, twitchUserId)** — one entry per Twitch account per campaign |

Minimum required fields per the global spec: `campaignId`, `twitchUserId`, `countryCode`,
`joinedAt`, with `UNIQUE(campaignId, twitchUserId)`.

### Winner  (implemented — migration `20260830031500_winner_and_status`)
Identity is resolved **through the relation** — `Winner → participant → twitchUserId /
countryCode`. No `twitchUserId` column; nothing is ever copied from browser input.

| field | type | notes |
|---|---|---|
| id | String PK | `cuid()` |
| campaignId | String FK → Campaign | `onDelete: Cascade` |
| participantId | String FK → Participant, **`@unique`** | one Winner row per Participant row |
| drawSequence | Int | 1-based order drawn |
| drawnAt | DateTime | `@default(now())` |
| | | **`@@unique([campaignId, participantId])`** — a participant cannot be selected twice for a campaign · **`@@unique([campaignId, drawSequence])`** — one winner per slot · `@@index([campaignId])` |

Fulfillment data lives on the separate `Reward` table (below), one row per `Winner`.

### ClaimToken
| field | type | notes |
|---|---|---|
| id | String PK | |
| winnerId | String FK → Winner, **UNIQUE** | one active claim per winner |
| tokenHash | String, **UNIQUE** | `sha256_hex(rawToken)`. Raw token is never stored. |
| expiresAt | DateTime | `now + CLAIM_TOKEN_TTL_HOURS` |
| consumedAt | DateTime? | set only on successful fulfillment |
| failedAttempts | Int, default 0 | identity-mismatch / bad attempts, for rate limiting |
| createdAt / updatedAt | DateTime | |

**✅ Implemented (migration `20260831010000_reward_fulfillment`).** `raw =
base64url(randomBytes(32))`, `tokenHash = sha256_hex(raw)`; raw is returned in memory only
to build `${APP_URL}/claim/<raw>` for the Whisper — never stored / logged. **Deviation from
"generate inside the draw transaction":** tokens are minted by `notifyWinners()` (`upsert` by
`winnerId`) *after* the draw commits, and a pending winner's token is **rotated** on each
retry pass; a winner already Whispered (`WhisperAttempt.SENT`) is skipped and never rotated.
Lookup is by `tokenHash` (`src/lib/campaign/claim.ts`); identity compare is constant-time.

### Reward
Holds the **country-resolved product**, the delivery info ("WHERE"), and the SodaGift order.
Separate from `Winner` (the "WHO"). The product is resolved here per winner against
`Participant.countryCode` (§3A) — it is **not** on `Campaign`.

| field | type | notes |
|---|---|---|
| id | String PK | |
| winnerId | String FK → Winner, **UNIQUE** | |
| campaignId | String FK → Campaign | denormalized for queries |
| countryCode | String | copied from the winner's `Participant.countryCode` at draw; the country this reward is fulfilled in |
| sodagiftProductId | String? | the concrete product. Set when resolved: mode **A** = participant's `selectedProductId` (re-validated); mode **B** = null until the verified winner picks; mode **C** = backend-selected eligible product for `countryCode`. Must satisfy `country_code == countryCode` + `ON_SALE` + offers `LINK` at resolution time. |
| sodagiftProductSnapshot | Json? | full `/v1/products` object frozen at resolution |
| rewardKind | Enum `RewardKind` | derived from snapshot (`amount` present → `FIXED`, else `RANGE`) |
| customAmountMode | Enum `CustomAmountMode` | derived from snapshot: `FORBIDDEN` iff `amount` present, else `REQUIRED` (override map for verified exceptions). Order builder sends `item.custom_amount` **iff `REQUIRED`**. |
| rewardAmount | Decimal? `@db.Decimal(14,2)` | set iff `customAmountMode = REQUIRED`, within snapshot `[min_amount, max_amount]`. Null for fixed products (e.g. #99001). |
| rewardCurrency | String? | ISO 4217, from snapshot `currency` (the country's currency — varies per winner) |
| status | Enum `RewardStatus` | see lifecycle below |
| externalReferenceId | String, **UNIQUE** | our idempotency key, generated at draw, reused on every retry |
| deliveryMethod | Enum `DeliveryMethod` | `= campaign.requiredDeliveryMethod` (MVP `LINK`) |
| recipientInfoSource | Enum `RecipientInfoSource` | MVP always `SENDER` (LINK needs only `recipient.name` + `sender.name`) |
| recipientEmailEnc | String? | encrypted; **not used by the MVP `LINK` flow** — reserved for the `EMAIL` baseline / future methods |
| recipientNameEnc | String? | encrypted; `LINK` requires `recipient.name` (docs). For a giveaway winner this is a display name — not an authorization identifier. |
| recipientPhoneEnc | String? | encrypted; only if a later delivery method needs it (`TEXT`) |
| recipientAddressEnc | String? | encrypted JSON; only if a later delivery method needs it (`DIRECT_SHIPPING`) |
| sodagiftOrderId | String? | `id` from the `POST /v1/orders` response (integer, stored as string). **Verified** (EMAIL run: `33814`). |
| sodagiftOrderItemId | String? | `order_item.id` (verified EMAIL run: `33829`) — needed to locate `order_item.delivery.link` |
| sodagiftOrderStatus | String? | `COMPLETED` \| `PAYMENT_PENDING` \| `PAYMENT_EXPIRED` \| `CANCELLED` |
| sodagiftItemStatus | String? | `PENDING` \| `COMPLETED` \| `CANCELLED` — starts `PENDING` even when the order is `COMPLETED` (verified); polled separately; `FULFILLED` requires this = `COMPLETED` |
| sodagiftPolledAt | DateTime? | last reconciliation poll |
| rewardUrlEnc | String? | **encrypted** SodaGift `LINK` voucher URL, read from **`order_item.delivery.link`** (`GET /v1/orders/{id}`). Never logged; shown only to the verified winner + whispered. |
| sodagiftOrderRaw | Json? | full create/fetch response for audit, scrubbed of code/voucher/URL values (key names kept) |
| fulfilledAt | DateTime? | |
| createdAt / updatedAt | DateTime | |

`RewardStatus`: `PENDING_VERIFICATION` → `VERIFIED` → `AWAITING_REWARD_SELECTION` (mode B) →
`ORDER_CREATING` → `ORDER_CREATED` → `FULFILLED`; plus `ORDER_FAILED` (retryable) and
`CANCELLED` (terminal).
`RewardKind`: `FIXED` (snapshot has `amount`) \| `RANGE` (snapshot has `min_amount`+`max_amount`).
`CustomAmountMode`: `REQUIRED` \| `FORBIDDEN` \| `UNKNOWN` — per-product; the **only** thing
that decides whether `item.custom_amount` is sent (verified: #50005 `REQUIRED`, #99001
`FORBIDDEN`; docs rule = `FORBIDDEN` iff product has `amount`).
`RecipientInfoSource`: `SENDER` \| `RECIPIENT` — MVP `SENDER` only (LINK is sender-provided;
§11). `RECIPIENT` stays deferred.

**✅ Implemented (lean form)** — `src/lib/campaign/fulfillment.ts`, migration
`20260831010000_reward_fulfillment`. Columns actually created: `winnerId` (UNIQUE),
`campaignId`, `countryCode` (copied from `Winner.participant.countryCode`), `status`
(`RewardStatus` enum: `AWAITING_SELECTION → ORDER_CREATING → ORDER_CREATED → FULFILLED`, plus
`ORDER_FAILED` / `UNAVAILABLE`), `selectedProductId` + `selectedProductSnapshot` (Json — the
`/v1/products` row frozen when the **verified winner** picks on `/claim/<token>`),
`customAmountMode` (`FORBIDDEN`/`REQUIRED`/`UNKNOWN` — the only thing that decides whether
`item.custom_amount` is sent), `rewardAmount` `Decimal(14,2)`, `rewardCurrency`,
`unavailableReason`, `externalReferenceId` (UNIQUE — frozen on the first order attempt,
reused on retry), `sodagiftOrderId` / `sodagiftOrderItemId` / `sodagiftOrderStatus` /
`sodagiftItemStatus`, `rewardUrlEnc` (AES-256-GCM of `order_items[0].delivery.link` via
`src/lib/crypto/secretbox.ts` + new env `TOKEN_ENCRYPTION_KEY`). Deferred columns from the
full spec above (recipient PII, `sodagiftOrderRaw`, `rewardKind`, `sodagiftPolledAt`,
`fulfilledAt`, poll reconciliation) are **not** created yet. No hardcoded product id anywhere
— `resolveOrderContract()` (`src/lib/sodagift/order-contract.ts`) derives the order body from
the live product's amount model + the campaign `rewardPolicy`, and returns
`{ orderable:false, reason }` (→ `status = UNAVAILABLE`) rather than fabricate a request when
the contract can't be safely determined (e.g. a variable product priced in a currency the
policy doesn't use).

### WhisperAttempt
| field | type | notes |
|---|---|---|
| id | String PK | |
| winnerId | String FK → Winner | |
| status | Enum `WhisperStatus` | `SENT` \| `FAILED` |
| twitchHttpStatus | Int? | |
| twitchErrorCode | String? | Twitch error slug, no message body |
| attemptedAt | DateTime | |

Never store the message body, claim URL, or token here.

**✅ Implemented** — `id, winnerId, status (SENT|FAILED), twitchHttpStatus, twitchErrorCode,
attemptedAt`. Written by `notifyWinners()` per `POST /helix/whispers`. `SENT` ⇔ HTTP 204
(Twitch *accepted* — not proof of delivery). Presence of a `SENT` row is what makes a winner
skip re-notification (and keeps their delivered token from being rotated).

### Notes on session / OAuth-state storage

Sessions and the OAuth round-trip state are **not** database tables in the default design —
they live in encrypted cookies (see §7). A `Session` table is a documented alternative if we
later need server-side revocation or an "active sessions" admin view; if added it stores an
opaque random token by SHA-256 hash, `userType`, `twitchUserId`, `hostId?`, `expiresAt`.

---

## 3A. Global participants & country-resolved rewards  (full MVP — NOT the OIDC proof)

The giveaway is **global**. Twitch identity proves *who*; it does **not** tell us *where*.
Twitch OIDC and the Get Users API do **not** carry a reliable country claim, so
**`countryCode` is user-selected and is the source of truth**. It is never inferred from
Twitch (revisit only if an official Twitch API later provides a verified country field).

### Participant flow (full MVP)

```
QR  →  /c/[publicId]  →  "Continue with Twitch"  →  Twitch OIDC (§6)
    →  verified twitchUserId (OIDC `sub`)  +  participant session
    →  COUNTRY SELECT  (options derived from the SodaGift catalog, §3A "derivation")
    →  POST country  →  Participant { campaignId, twitchUserId, countryCode, joinedAt }
                        (UNIQUE(campaignId, twitchUserId))
    →  [mode A only] show country-filtered products  →  participant pre-selects a reward
    →  waiting / results page
```

The **only** step the current OIDC proof (§17) implements is *Continue with Twitch → Twitch
OIDC → verified `sub` → show the id*. Everything from **COUNTRY SELECT** onward is full MVP,
built after the proof is approved.

### Deriving selectable countries from SodaGift (never hardcoded)

`lib/sodagift/catalog.ts`:

- `listProducts()` fetches `/v1/products` **server-side** (key never exposed), cached in
  memory with a short TTL (e.g. 15–30 min) + manual refresh.
- `selectableCountries(campaign)` =
  `distinct( p.country_code )` over catalog products where **all** of:
  - `p.availability === "ON_SALE"`
  - `p.available_delivery_method.includes(campaign.requiredDeliveryMethod)` (MVP `"LINK"`)
  - `campaign.allowedProductTypes.length === 0 || allowedProductTypes.includes(p.type)`
  - product value is compatible with `campaign.rewardPolicy` (best-effort; `TARGET_VALUE` /
    `VALUE_RANGE` compared in the policy's reference currency — approximate cross-currency)
  - if `!campaign.isGlobal`: `campaign.eligibleCountries.includes(p.country_code)`
  - if `CampaignCountryOption` rows exist for this campaign: only their `countryCode`s.
- Country **display names** come from `Intl.DisplayNames(['en'], { type: 'region' })` — an
  ISO-code→name mapping, not a hardcoded supported-country list.
- Exposed via `GET /api/campaigns/[publicId]/countries` (auth: participant session).

If `selectableCountries` is empty, the campaign cannot be joined — surfaced to the host.

### Filtering products after country selection

`GET /api/campaigns/[publicId]/products?country=XX` (auth: participant session; `XX` must
equal the participant's stored `countryCode`, or be in the selectable set pre-join):

filter the cached catalog to products where:
- `p.country_code === countryCode`
- `p.availability === "ON_SALE"`
- `p.available_delivery_method.includes("LINK")`   ← MVP invariant
- `campaign.allowedProductTypes` empty or includes `p.type`
- matches `campaign.rewardPolicy` value constraints
- if `CampaignCountryOption` rows exist for `countryCode`: restrict to those product ids.

**Invariant (enforced at BOTH display and fulfillment):** a reward may be shown to, or
fulfilled for, a participant **only** if SodaGift currently reports that product as
available for that participant's selected `countryCode` (`country_code` match + `ON_SALE` +
offers `LINK`). Fulfillment re-fetches the catalog and re-validates the resolved
`Reward.sodagiftProductId` immediately before `POST /v1/orders`.

### One global campaign → winners in US, KR, JP

- Campaign: `isGlobal = true`, `requiredDeliveryMethod = LINK`,
  `allowedProductTypes = ["GIFT_CARD"]`,
  `rewardPolicy = { kind: "TARGET_VALUE", amount: 5, currency: "USD" }`,
  `rewardSelectionMode = <A | B | C>` (one, chosen later), `winnerCount = N`. **No product id.**
- Participants: a US viewer picks `countryCode = "US"` and sees US LINK gift cards; a KR
  viewer picks `"KR"` and sees KR ones; a JP viewer picks `"JP"`.
- Draw (§8) selects `N` winners across **all** participants regardless of country.
- Per winner, a `Reward` is created with `countryCode = participant.countryCode` and the
  product resolved **in that country**:
  - **A** `PARTICIPANT_PRECHOICE` → `Reward.sodagiftProductId = participant.selectedProductId`,
    re-validated for `countryCode` + `ON_SALE` + `LINK` at draw.
  - **B** `WINNER_CHOICE` → `Reward.status = AWAITING_REWARD_SELECTION`; after Twitch-verified
    claim the winner picks from the live country-filtered list; then resolve.
  - **C** `BACKEND_SELECT` → backend picks an eligible product for `countryCode` matching
    `rewardPolicy` (e.g. the ON_SALE + LINK GIFT_CARD nearest the target value), or a
    `CampaignCountryOption` row if the host curated one.
- Fulfillment (§9, §11): `POST /v1/orders` with the **country-specific**
  `Reward.sodagiftProductId`, `custom_amount` per that product's `customAmountMode`,
  `delivery.method = LINK`, `recipient.name` = a display label, frozen `externalReferenceId`;
  then Host OAuth + Twitch Whisper of the claim link (§5, §10).
  Winners in different countries → different product ids, different currencies, **same
  campaign**.

### A / B / C are all still open

The architecture supports **all three** `rewardSelectionMode`s; no permanent choice is made
here. `Participant.selectedProduct*` (A), `RewardStatus.AWAITING_REWARD_SELECTION` +
`Reward.sodagiftProductId` nullable-until-picked (B), and pure backend resolution (C) all
coexist in the schema. The single invariant that must always hold: **selected country →
only SodaGift products valid for that country may be displayed or fulfilled.**

---

## 4. Page / route map

### Rendered pages (App Router)

| path | audience | purpose |
|---|---|---|
| `/` | public | minimal marketing / explainer |
| `/c/[publicId]` | participant | campaign page. (1) unauthenticated → "Continue with Twitch"; (2) authed, no country → **country selector** (§3A); (3) after country → `/c/[publicId]/rewards` with **[ Join Giveaway ]**. ✅ implemented through Join. |
| `/c/[publicId]/country`, `/c/[publicId]/rewards`, `/c/[publicId]/joined` | participant | ✅ implemented — country select → country-filtered catalog → Join → confirmation (Campaign / Twitch User ID / Country). |
| `/c/[publicId]/display` | streamer / OBS | ✅ implemented — public (no auth), full-bleed. Large QR (`${APP_URL}/c/${publicId}` only), title, "Scan to join", live participant count, status; 10-s meta-refresh. |
| `/c/[publicId]/result` | public | ✅ implemented — "Waiting for results" until `DRAWN`; then `Winner #k` / **masked** Twitch id / country. No URLs/tokens/secrets. |
| `/claim/[token]` | winner | ✅ implemented (option B, `PROTECTED_TOKEN` default). Loads `ClaimToken` by hash; unauthenticated → "Verify with Twitch" (token stashed in `sl_claim`, unchanged participant OIDC, `/auth/result` returns here). Authenticated → constant-time `session.sub == Winner.participant.twitchUserId` (mismatch → `failedAttempts++`, refused). Verified winner picks a product from **their own country's** catalog (`resolveOrderContract` flags auto-orderable items) → `claimReward` re-validates + `POST /v1/orders` (LINK) + stores the voucher URL encrypted. Already fulfilled → reveals the decrypted URL to the verified winner only. |
| `/host` | host | dashboard: connect status, campaign list |
| `/host/campaigns/new` | host | configure campaign: name, `isGlobal`/`eligibleCountries`, `rewardPolicy`, `allowedProductTypes`, `winnerCount`, `rewardSelectionMode`; `requiredDeliveryMethod` fixed = `LINK`. Optional per-country product curation (`CampaignCountryOption`). **No single product/amount/currency.** |
| `/host/campaigns/[id]` | host (**dev-only** for now, `notFound()` in prod) | ✅ implemented — title, status, participant count, country breakdown, `winnerCount`, public/display/result URLs, `Close Entries` / `Reopen Entries` / `Draw Winners` (by state), winners after draw. **No Twitch-ID input.** Host-auth gating added later. |

### Auth route handlers

| method + path | purpose |
|---|---|
| `GET /api/auth/host/login` | build Twitch authorize URL (scope `user:manage:whispers`, code + PKCE), set state cookie, 302 |
| `GET /api/auth/host/callback` | validate state, exchange code, validate scopes, load Helix user, encrypt + upsert Host, create host session, 302 `/host` |
| `POST /api/auth/host/logout` | clear host session cookie |
| `GET /api/auth/participant/login` | `?campaign=<publicId>&returnTo=<path>`; verify campaign is PUBLISHED, build OIDC authorize URL (`scope=openid`, `state`, `nonce`, PKCE), set state cookie, 302 |
| `GET /api/auth/participant/callback` | validate state, exchange code, verify ID token (sig/iss/aud/exp/nonce), upsert Participant, create participant session, 302 to `returnTo` |
| `POST /api/auth/participant/logout` | clear participant session cookie |

### Host API

| method + path | purpose |
|---|---|
| `GET /api/host/sodagift/products` | server proxy to SodaGift product API; key stays server-side |
| `POST /api/host/campaigns` | create (Zod). Status `DRAFT` |
| `PATCH /api/host/campaigns/[id]` | edit while `DRAFT`; ownership enforced |
| `POST /api/host/campaigns/[id]/publish` | `DRAFT` → `PUBLISHED`; generates `publicId` if absent |
| `POST /api/host/campaigns/[id]/draw` | draw winners (see §8). Idempotent / locked |
| `POST /api/host/campaigns/[id]/whispers` | re-trigger whisper sends for winners without a `SENT` attempt |

### Participant API  (all require a participant session; §3A)

| method + path | purpose |
|---|---|
| `GET /api/campaigns/[publicId]/countries` | selectable countries for this campaign, **derived from the SodaGift catalog** (`ON_SALE` + `LINK` + policy, ∩ campaign eligibility). ISO codes + `Intl.DisplayNames` labels. |
| `POST /api/campaigns/[publicId]/join` | body `{ countryCode }`; validates it against `/countries`; upserts `Participant { campaignId, twitchUserId (session), countryCode, joinedAt }`; `UNIQUE(campaignId, twitchUserId)` → idempotent. Editable while `PUBLISHED`. |
| `GET /api/campaigns/[publicId]/products?country=XX` | country-filtered product list (server-side catalog filter, §3A). `XX` must match the participant's `countryCode` (or be selectable, pre-join). |
| `POST /api/campaigns/[publicId]/reward-choice` | mode **A**: set `Participant.selectedProductId` from that country's list. mode **B**: set `Reward.sodagiftProductId` for a verified winner. |
| `GET /api/campaigns/[publicId]/me` | current participant's join state, country, winner status (from session identity) |
| `POST /api/campaigns/[publicId]/claim/start` | session-identity claim path: find the `Winner` for `session.sub`, return verification result (no token needed) |

### Claim API

| method + path | purpose |
|---|---|
| `POST /api/claim/[token]/verify` | run full server-side verification (§9), return required delivery fields |
| `POST /api/claim/[token]/fulfill` | re-verify identity, create the SodaGift `LINK` order with idempotency, store the reward URL, mark fulfilled. Concurrency-guarded. Collects no recipient PII in the MVP `LINK` flow (unless probe 1.c proves `LINK` needs it) |

### Utility

| method + path | purpose |
|---|---|
| `GET /api/campaigns/[publicId]/qr` | PNG QR code for the campaign URL, built from `APP_URL` |
| `GET /api/health` | liveness |

No SodaGift webhook route — SodaGift has no order-status webhooks. Order/item status is
reconciled by polling `GET /v1/orders/{id}` (a scheduled job + an on-demand refresh from
the host campaign page).

---

## 5. Host OAuth flow (Authorization Code + PKCE)

**Distinct from participant OIDC (§6) — different purpose, scope, tokens, and endpoints:**

| | Host OAuth (§5) | Participant OIDC (§6) |
|---|---|---|
| purpose | authorize the **host account** to send Whispers | prove **participant identity** |
| scope | `user:manage:whispers` | `openid` (minimum identity) |
| result used | host **access + refresh tokens**, stored encrypted server-side | verified `id_token` → `sub`; access/refresh **discarded** |
| callback | `/api/auth/host/callback` | `/api/auth/twitch/callback` (participant) |
| when | campaign setup / before a draw's Whispers | when a viewer joins a campaign |

A host may also be a participant elsewhere; the two authorizations never share tokens or
cookies. Twitch is a confidential client: client secret **and** PKCE are both used.

1. Host clicks "Connect Twitch" → `GET /api/auth/host/login`.
2. Server generates `state` (`base64url(randomBytes(32))`), `codeVerifier`
   (`base64url(randomBytes(64))`), `codeChallenge = base64url(sha256(codeVerifier))`.
3. Server sets a short-lived (10 min) encrypted cookie `sl_hoststate` (JWE, `dir` +
   `A256GCM`, key `AUTH_STATE_SECRET`, `HttpOnly`, `Secure`, `SameSite=Lax`,
   `Path=/api/auth/host`) carrying `{ state, codeVerifier, flow: "HOST_CONNECT" }`.
4. 302 to `https://id.twitch.tv/oauth2/authorize` with
   `response_type=code`, `client_id`, `redirect_uri=TWITCH_HOST_REDIRECT_URI` (exact match),
   `scope=user:manage:whispers`, `state`, `code_challenge`, `code_challenge_method=S256`,
   `force_verify=true`.
5. Host approves on Twitch. Twitch 302 → `GET /api/auth/host/callback?code=&state=&scope=`.
6. Callback: read `sl_hoststate`; if missing/expired → error page. Constant-time compare
   `state`. If Twitch returned `error` → error page. Delete the state cookie now (single use).
7. Exchange: `POST https://id.twitch.tv/oauth2/token` with `grant_type=authorization_code`,
   `code`, `redirect_uri`, `client_id`, `client_secret`, `code_verifier`.
8. Response → `access_token`, `refresh_token`, `expires_in`, `scope[]`. If `scope[]` lacks
   `user:manage:whispers` → abort, show "grant whisper permission", do not persist.
9. `GET https://api.twitch.tv/helix/users` with `Authorization: Bearer <access_token>` +
   `Client-Id`. `data[0].id` → `twitchUserId` (authoritative). `login` / `display_name`
   stored for display only.
10. Encrypt `access_token` + `refresh_token` (AES-256-GCM, `TOKEN_ENCRYPTION_KEY`, random IV
    per value). `upsert Host` by `twitchUserId`: tokens, `tokenScopes`,
    `tokenExpiresAt = now + expires_in`, `needsReconnect = false`.
11. Create host session cookie (§7). 302 → `/host`.

**Token refresh:** before any Whisper call, if `tokenExpiresAt` is within 60 s or a call
returns 401, `POST /oauth2/token` with `grant_type=refresh_token`. Persist the rotated
refresh token. On refresh failure (revoked) set `Host.needsReconnect = true` and surface a
reconnect banner on `/host`.

---

## 6. Participant OIDC flow (Authorization Code + PKCE, OpenID Connect)

Minimal identity only. **No** chat, moderation, or whisper scopes for participants.
**No** `email` claim requested for MVP (privacy).

1. On `/c/[publicId]`, participant clicks "Continue with Twitch" →
   `GET /api/auth/participant/login?campaign=<publicId>&returnTo=<internal path>`.
2. Server verifies the campaign exists and is `PUBLISHED`. Generates `state`, `nonce`
   (`base64url(randomBytes(32))`), `codeVerifier`, `codeChallenge`.
3. Sets short-lived encrypted cookie `sl_partstate` (JWE, key `AUTH_STATE_SECRET`, `HttpOnly`,
   `Secure`, `SameSite=Lax`, `Path=/api/auth/participant`) with
   `{ state, nonce, codeVerifier, flow: "PARTICIPANT_LOGIN", campaignPublicId, returnTo }`.
   `returnTo` is validated to be a local path (starts with single `/`, no `//`, no scheme).
4. 302 to `https://id.twitch.tv/oauth2/authorize` with
   `response_type=code`, `client_id`, `redirect_uri=TWITCH_PARTICIPANT_REDIRECT_URI`,
   `scope=openid`, `state`, `nonce`, `code_challenge`, `code_challenge_method=S256`.
5. Participant approves. Twitch 302 → `GET /api/auth/participant/callback?code=&state=&scope=`.
6. Callback: read `sl_partstate`; missing/expired → error. Constant-time compare `state`.
   Handle `error` param. Delete the state cookie (single use).
7. Exchange code at `/oauth2/token` with `code_verifier`. Response contains `id_token`
   (JWT). Any `access_token` returned is discarded and never stored.
8. Verify `id_token` with `jose`:
   - `const JWKS = createRemoteJWKSet(new URL(TWITCH_JWKS_URI))` (cached).
   - `jwtVerify(idToken, JWKS, { issuer: TWITCH_OIDC_ISSUER, audience: TWITCH_CLIENT_ID,
     algorithms: ["RS256"], clockTolerance: 5 })` — enforces signature, `iss`, `aud`,
     `exp`, `nbf`, `iat`, and rejects `alg=none`.
   - Manually constant-time compare `payload.nonce` against the stored `nonce`.
9. `payload.sub` → participant Twitch user ID (authoritative). `preferred_username` /
   display name are stored only as non-authoritative snapshots. **No country claim is read
   from Twitch** — it is not reliable (§3A).
10. Create participant session cookie (§7). 302 → `returnTo` (the campaign page).
11. **The `Participant` row is created later**, at country selection
    (`POST /api/campaigns/[publicId]/join`, §3A / §4) — `{ campaignId, twitchUserId,
    countryCode, joinedAt }` upserted on `UNIQUE(campaignId, twitchUserId)` (catch `P2002` →
    "already entered"). OIDC alone only establishes the verified identity + session.

> **This section is the full-MVP flow.** The current OIDC **proof** (§17) implements steps
> 1–10 in a stripped form (one Twitch app, `scope=openid`, state+nonce, server-side
> exchange, full ID-token validation, show the `sub`) and **stops there** — no campaign
> param, no `Participant` row, no country step, no long-lived session.

---

## 7. Session management

Two principals — **Host** and **Participant**. Both are authenticated via Twitch; the
session carries only a verified Twitch user id. **No Twitch tokens are ever in a cookie.**

### Default: stateless encrypted cookies (`jose` JWE)

- `sl_host` — `EncryptJWT({ sub: twitchUserId, hostId, ver: sessionVersion, typ: "host" })`,
  `dir` + `A256GCM`, key `SESSION_SECRET`. TTL `SESSION_TTL_HOURS` (default 12). Re-issued
  when < 50 % of lifetime remains (sliding).
- `sl_participant` — `EncryptJWT({ sub: twitchUserId, typ: "participant" })`. TTL
  `PARTICIPANT_SESSION_TTL_HOURS` (default 24).
- Cookie flags: `HttpOnly`, `Secure`, `SameSite=Lax` (Lax works — the return from Twitch is
  a top-level GET navigation), `Path=/`.
- Host privileged actions always load `Host` from DB by `hostId`; the Twitch access/refresh
  tokens live only in encrypted DB columns.

**Revocation:** stateless cookies can't be individually revoked. Mitigations: short TTL;
`sl_host.ver` is checked against `Host.sessionVersion` on every request (bump to force
re-login); "Disconnect Twitch" deletes the DB tokens so nothing privileged works regardless.

### Documented alternative: DB-backed sessions

Add a `Session` table (opaque random token stored by SHA-256 hash, `expiresAt`, `userType`,
`twitchUserId`, `hostId?`). Enables instant revocation and an active-sessions view. Adopt if
that requirement appears.

### Guards & access control

- `requireHost()` — decode `sl_host`, check `ver`, load `Host`, else 401 / redirect to
  `/host`.
- `requireParticipant()` — decode `sl_participant`, else redirect to participant login with
  `returnTo`.
- Campaign ownership — every `/api/host/campaigns/[id]*` handler asserts
  `campaign.hostId === session.hostId`.
- Claim authorization — `session.sub === winner.twitchUserId` (constant-time). This is the
  core check; possession of the URL is never sufficient.
- CSRF — all mutations are POST; check `Origin` / `Sec-Fetch-Site` against an allowlist in
  addition to `SameSite=Lax`. Server Actions get Next's built-in origin check.

---

## 8. Winner selection & transaction locking

**✅ Implemented (this milestone) — `drawWinners(campaignId)` in `src/lib/campaign/queries.ts`,
driven by the `/host/campaigns/[id]` `Draw Winners` action:**

1. `prisma.$transaction`, `isolationLevel: Serializable`.
2. `SELECT "status", "winnerCount" FROM "Campaign" WHERE id = $1 FOR UPDATE` — locks the
   campaign row for the whole draw (serializes competing draws).
3. `status === "DRAWN"` → return the persisted `Winner` rows (no redraw). `status !== "CLOSED"`
   → `DrawError` ("must be CLOSED … close entries first").
4. Read every `Participant` for this campaign (`WHERE campaignId = $1`). Global campaign →
   all countries; no per-country filter at draw.
5. `participants.length < winnerCount` → `DrawError("Not enough participants to draw N …")`.
   **Does NOT silently draw fewer.**
6. **CSPRNG:** `selectWinners()` (`src/lib/campaign/draw.ts`) — partial Fisher–Yates using
   `node:crypto.randomInt(i, len)`. **`Math.random` is never used.** No stored seed.
7. `winner.createMany` (`drawSequence` 1..n). `@unique(participantId)`,
   `@@unique([campaignId, participantId])`, `@@unique([campaignId, drawSequence])` are DB
   backstops.
8. `updateMany({ where: { id, status: "CLOSED" }, data: { status: "DRAWN", drawnAt } })` —
   if `count !== 1`, abort (a concurrent draw won); on retry step 3 returns their winners.
9. Commit. Any error → full rollback → campaign stays `CLOSED` for a clean retry.

Verified: 8 concurrent `drawWinners` → **one** committed winner set. `Winner` carries **no**
`twitchUserId` — identity is `Winner → participant → twitchUserId`. Per-winner `Reward` /
`ClaimToken` / Whisper are the **fulfillment milestone**, not here.

---

The fuller design below is the eventual fulfillment-integrated draw (Reward + ClaimToken +
Whisper enqueue). Route `POST /api/host/campaigns/[id]/draw`.

1. `requireHost()` + ownership check.
2. Prisma interactive `$transaction` with `isolationLevel: "Serializable"`.
3. **Atomic state gate** (this is the double-draw guard):
   `UPDATE "Campaign" SET status = 'DRAWING' WHERE id = $1 AND status = 'PUBLISHED'`.
   If 0 rows affected → another request already drew or is drawing → rollback, return `409`
   with the existing winners. (Because this update is inside the transaction, any later
   failure rolls it back cleanly; the `WHERE status = 'PUBLISHED'` clause is the DB-level
   race guard.)
4. Load eligible participants: `WHERE campaignId = $1 AND eligible = true` — i.e. they
   completed country selection (`countryCode` set, `joinedAt` not null) and their
   `countryCode` is in the campaign's derived selectable set (§3A). Country is **not** a
   filter beyond that — a global campaign draws across all countries.
5. `n = min(campaign.winnerCount, eligible.length)`. If `n < winnerCount`, record a
   partial-draw flag for the host UI.
6. **CSPRNG selection:** partial Fisher–Yates over the eligible array using
   `crypto.randomInt(0, i + 1)` from `node:crypto`; take the first `n`. Never `Math.random`.
   No stored seed. (Cross-country: every eligible participant has equal weight regardless of
   `countryCode`.)
7. Insert `Winner` rows (`drawSequence` 1..n). `UNIQUE(campaignId, participantId)` and
   `UNIQUE(campaignId, twitchUserId)` are backstops against duplicates.
8. For each winner: generate a claim token (§9), insert `ClaimToken`, insert `Reward` with
   `countryCode = participant.countryCode`, `externalReferenceId` frozen here, and
   `status`:
   - mode **A** → resolve `sodagiftProductId` from `participant.selectedProductId`,
     **re-validated** against a fresh catalog (`country_code == countryCode` + `ON_SALE` +
     offers `LINK`); `status = PENDING_VERIFICATION`. If it no longer validates → fall back
     to mode C resolution or flag for host.
   - mode **B** → leave `sodagiftProductId` null, `status = PENDING_VERIFICATION`
     (becomes `AWAITING_REWARD_SELECTION` after the winner is Twitch-verified).
   - mode **C** → backend picks an eligible product for `countryCode` (policy match, or a
     `CampaignCountryOption` row); `status = PENDING_VERIFICATION`.
9. `UPDATE "Campaign" SET status = 'DRAWN', drawnAt = now() WHERE id = $1`.
10. Commit. Any error → full rollback (campaign returns to `PUBLISHED`, no winners persisted).
11. **After** commit: enqueue whisper sends (best-effort, out of band).

The browser submits **only** the campaign id. It can never submit winner Twitch user ids
(requirement 26). Winner identities come solely from server-selected `Participant` rows.

---

## 9. Claim-token generation & verification

### Generation (inside the draw transaction, per winner)

- `raw = base64url(crypto.randomBytes(32))` — 256-bit.
- `tokenHash = sha256_hex(raw)`.
- `ClaimToken { winnerId, tokenHash (UNIQUE), expiresAt = now + CLAIM_TOKEN_TTL_HOURS,
  consumedAt: null }`.
- `raw` exists only in memory to build `${APP_URL}/claim/${raw}`. It is never stored,
  logged, or sent to analytics. Only the hash is in the DB.
- The claim URL is delivered by Twitch Whisper. The **authenticated campaign page** does not
  need the raw token: it finds the winner by `session.sub` + campaign and routes to
  fulfillment directly (`/api/campaigns/[publicId]/claim/start`). Token = one convenience
  channel; identity = source of truth.

### Verification (`/claim/[token]/verify` and the session-identity path converge here)

1. `tokenHash = sha256_hex(raw)`; look up `ClaimToken`. Not found → generic `404`.
2. `expiresAt > now` → else `410 Gone` ("link expired"; winner can still use the
   authenticated-page path).
3. `consumedAt == null` → else `409` ("already claimed").
4. Require a participant session. Absent → redirect to participant login with
   `returnTo = /claim/[token]`.
5. Load `Winner`; **constant-time** compare `session.sub === winner.twitchUserId`. Mismatch
   → increment `failedAttempts`, `403` ("this claim link isn't associated with your Twitch
   account"). This rejects anyone who was forwarded / copied another winner's URL.
6. Assert `winner.campaignId` matches the claim's campaign.
7. Load `Reward`; `status ∉ {FULFILLED, CANCELLED}` → else `409`.
8. Pass → hand off to fulfillment. **MVP target = `LINK`:** fulfillment does not collect
   recipient email/address from the winner — it creates a `LINK` SodaGift order and returns
   the SodaGift claim/acceptance/reward URL to the verified winner. Whether *anything* is
   collected from the winner depends on §11 unknown 2 (LINK = `SENDER`- or
   `RECIPIENT`-provided). The `EMAIL` path exists only as the dev/library baseline used to
   learn the generic `POST /v1/orders` contract; it is **not** a campaign-facing option in
   the MVP.

### Fulfillment submit (`/claim/[token]/fulfill`) — LINK flow (MVP target)

- **Re-run every check in the verification list above** — never trust a prior step.
- **Resolve / re-validate the country-specific product** (§3A invariant):
  - mode **B** and unresolved → `Reward.status = AWAITING_REWARD_SELECTION`; the verified
    winner picks from `GET /api/campaigns/[publicId]/products?country=<Reward.countryCode>`;
    the chosen id is written to `Reward.sodagiftProductId` + snapshot.
  - fetch a **fresh** catalog and assert `Reward.sodagiftProductId` still has
    `country_code === Reward.countryCode`, `availability === "ON_SALE"`, and
    `available_delivery_method.includes("LINK")`. If not → mode C re-resolution or
    `ORDER_FAILED` + host alert. **Never** `POST /v1/orders` for a product not currently
    valid for `Reward.countryCode`.
- **Concurrency guard:** transaction +
  `UPDATE "Reward" SET status = 'ORDER_CREATING'
   WHERE id = $1 AND status IN ('PENDING_VERIFICATION','VERIFIED','AWAITING_REWARD_SELECTION','ORDER_FAILED')
   AND sodagiftProductId IS NOT NULL`.
  0 rows → `409` (another submission in flight, or no product resolved).
- Create the SodaGift **`LINK`** order (§11) with the resolved `Reward.sodagiftProductId`,
  `item.custom_amount` per `Reward.customAmountMode`, `delivery.method = "LINK"`,
  `delivery.recipient.name` = a display label, `delivery.sender.name` =
  `SODAGIFT_SENDER_NAME`, and the frozen `externalReferenceId`. No recipient email/phone.
- Success → `GET /v1/orders/{id}`, read `order_items[0].delivery.link`, store it
  **encrypted** in `Reward.rewardUrlEnc`; store `sodagiftOrderId`, `sodagiftOrderItemId`,
  order + item status; `Reward.status = ORDER_CREATED` (→ `FULFILLED` when item `COMPLETED`);
  `ClaimToken.consumedAt = now`.
- Failure → `Reward.status = ORDER_FAILED`; retry with the **same** `externalReferenceId`.
- The verified winner is shown / redirected to the reward URL. The Twitch Whisper carries a
  claim link per `Campaign.claimLinkMode` (default `PROTECTED_TOKEN` → our `/claim/<token>`;
  §10). A-vs-B not yet locked (§9).
- Basic per-IP + per-token rate limiting on verification failures.

### V1 fulfillment chain (REQUIRED — Twitch Whisper is a V1 feature)

Per winner, in order (implemented **after** Participant persistence + winner selection):

```
winner.twitchUserId
  → determine winner.countryCode (from the winner's Participant) + the eligible reward (§3A)
  → create SodaGift LINK order (POST /v1/orders, §11) with the country-resolved product
  → read order_items[0].delivery.link  →  store ENCRYPTED in Reward.rewardUrlEnc
  → Host Twitch OAuth (scope user:manage:whispers, §5 — separate from participant OIDC)
  → Twitch Whisper to winner.twitchUserId, containing a USABLE CLAIM LINK
```

Twitch Whisper delivery is **not optional** and is **not** replaced by the
authenticated-page fallback (§10 "Fallback") — the fallback is an *additional* discovery
path, per requirements 38–39/56–57.

### What the Whisper's claim link is — A vs B, NOT YET DECIDED

Probe 1.c **verified only** that a LINK order can be created, that the order exposes a
reward/voucher URL (`order_items[0].delivery.link`), and that we can extract + store it.
Whether that URL **expires**, is **single-use vs reusable**, is **bound to a
recipient/identity**, or can be **revoked** is **UNVERIFIED** (§11 point 13). Because those
security semantics are unknown, we treat the URL as a bearer secret. Two options remain
open; the architecture must support **both**, and the **default is B** (safer under
uncertainty):

- **Option A — raw SodaGift LINK URL in the Whisper.** Simplest. Acceptable only if the
  risk of Whisper interception / forwarding of a bearer URL is judged tolerable, or SodaGift
  later exposes expiry / revocation.
- **Option B — our protected one-time claim URL** (`${APP_URL}/claim/<rawToken>`):
  `/claim/[token]` → require participant OIDC → verify the authenticated Twitch user is
  `winner.twitchUserId` (constant-time) → then reveal / redirect to `Reward.rewardUrlEnc`.
  The SodaGift bearer URL never leaves our server except to the verified winner.

**Schema keeps both live:** `ClaimToken` (raw token hashed at rest, TTL, one-time) exists for
B; `Reward.rewardUrlEnc` (encrypted SodaGift URL) is needed either way; a
`Campaign.claimLinkMode` enum (`PROTECTED_TOKEN` | `SODAGIFT_DIRECT`, default
`PROTECTED_TOKEN`) selects the behaviour per campaign without a migration. No code path
should assume one or the other.

**When the SodaGift order is created** is also a consequence of A/B:
- B: create the order at first verified `/claim/[token]` open (lazy), or eagerly at draw —
  both work; eager keeps the URL ready, lazy avoids spending balance on unclaimed prizes.
- A: the order must be created at/near draw so the Whisper has a URL to carry.
The schema (frozen `externalReferenceId` at draw, `Reward.status` lifecycle) supports both;
the timing is decided with the A/B choice.

---

## 10. Twitch Whisper delivery & fallback  (REQUIRED V1)

### Send

The Whisper carries **a usable claim link** — under `Campaign.claimLinkMode`:
`PROTECTED_TOKEN` (option B) → `${APP_URL}/claim/<rawToken>`; `SODAGIFT_DIRECT` (option A) →
the SodaGift `delivery.link`. **The A/B choice is not yet locked** (§9). Default is B
because the SodaGift URL's expiry / reuse / recipient-binding / revocation semantics are
**unverified** (§11 point 13), so it must be treated as a bearer secret until proven
otherwise.

- Trigger: after the draw commits (and, for option B lazy mode, the `ClaimToken` exists), a
  background pass (Next `after()` / cron / queue) iterates winners with no
  `WhisperAttempt { status: SENT }`.
- Ensure a fresh **host** access token (Host OAuth, §5 — `user:manage:whispers`; refresh if
  needed).
- `POST https://api.twitch.tv/helix/whispers?from_user_id=<host twitchUserId>&to_user_id=<winner twitchUserId>`
  headers `Authorization: Bearer <host user access token>`, `Client-Id: <TWITCH_CLIENT_ID>`,
  body `{ "message": "<short text + the claim link>" }`.
  - `from_user_id` **must** equal the user id represented by the host access token.
  - `to_user_id` is the winner's OIDC `sub` (stored `Winner.twitchUserId`).
  - **No OAuth tokens and no raw claim token in logs.** In `PROTECTED_TOKEN` mode the
    SodaGift URL is never in the Whisper; in `SODAGIFT_DIRECT` mode it is, by design.
- Record `WhisperAttempt` with `status`, `twitchHttpStatus`, `twitchErrorCode` only — no
  message body, no URL, no token.

### Twitch constraints to handle

- Host account must have a **verified phone number** or whisper → `401`. Surface an
  actionable "enable whispers on your Twitch account" message to the host.
- Recipient may block whispers from strangers or have whispers disabled → `401` / `403`;
  Twitch may also **silently drop** the message.
- Rate limits (≈ 40/sec overall, 3/sec to new recipients, 40 unique new recipients/day).
  Throttle and spread sends; exponential backoff on `429`.
- First message to a recipient ≤ 500 chars.

### Fallback (additional discovery — does NOT replace Whisper)

Whisper is a **required V1 delivery channel**; this fallback is an *extra* way to reach the
reward (requirements 38–39 / 56–57), not a substitute for sending the Whisper.

- Whisper delivery is never treated as guaranteed (Twitch may drop/refuse it), so we also:
- The authenticated `/c/[publicId]` page always tells a logged-in participant whether they
  won and shows a "Claim your reward" button that runs the session-identity claim path — no
  token required (equivalent to opening `/claim/[token]` in `PROTECTED_TOKEN` mode).
- Winner status is also visible on the host's `/host/campaigns/[id]` so the host can reach
  out through other channels if needed.
- Retry policy: `429` / `5xx` → up to N attempts with backoff. `401` / `403` (structural) →
  mark `FAILED`, stop hammering, rely on the fallback page.

---

## 11. SodaGift Sandbox order creation & idempotency

All SodaGift calls run **server-side only**, from `lib/sodagift/*`. `SODAGIFT_API_KEY` is
never in client code, never in a `NEXT_PUBLIC_` var, never logged.

### MVP fulfillment is LINK-based — EMAIL is only a probe baseline

The MVP flow is: **Twitch participant → OAuth/OIDC identity → store Twitch user id →
random winner → create a SodaGift `LINK` reward/order → obtain the SodaGift
claim/acceptance/reward URL → send that URL to the winner via Twitch Whisper (by Twitch
user id).** The participant flow is **not** designed around recipient email.

`EMAIL` delivery is used **only** as a temporary baseline (probe 1.b) to learn the generic
`POST /v1/orders` request/response contract, idempotency, lookup, status, and error shape.
It is not a campaign-facing delivery option and no final fulfillment code is written for it
beyond the shared client. **`LINK` is a required MVP blocker (probe 1.c) — never mark it
out of scope. No final fulfillment implementation until LINK behaviour is verified.**

### Sandbox environment (confirmed)

- Credentials live in `C:\soda\.env.local` (git-ignored, server-only):
  `SODAGIFT_BASE_URL` = `https://biz-sandbox-api.sodagift.com`,
  `SODAGIFT_API_KEY` = a sandbox-only key with prefix `sodagift_test_`.
- Verified live by the project owner (probe run 2026-08-29):
  - `GET /v1/accounts/balance` → `200` · `{ amount: 5000.00, currency: "USD", payment_method: "PREPAID" }`
  - `GET /v1/products` → `200` · `{ products: Product[], total_elements: 460 }` (460 returned in one call)
- **Auth header (verified):** `SODA-API-KEY: <SODAGIFT_API_KEY>` on **every** SodaGift
  request. There is **no** `Authorization: Bearer` header — do not add one unless an
  official SodaGift endpoint explicitly documents it. The owner has successfully called
  `GET /v1/accounts/balance` and `GET /v1/products` from their machine with this header.
- **Network note:** live SodaGift calls (probing, order tests) are run by the owner from
  their own machine. No IP allow-list change is needed on our side. Integration code is
  written against the documented contract and exercised with a mockable
  `lib/sodagift/client.ts`; real response shapes come from `scripts/sodagift-probe.ts`
  output the owner captures locally.
- **Base URL:** `SODAGIFT_BASE_URL` (no trailing slash). Never hardcode the host.

### Verified catalog shape (from 460 sandbox products)

**Envelope:** `{ products: Product[], total_elements: number }`. `total_elements === products.length`
in the sandbox (single page); pagination params for production are **unknown** (open question).

**Product fields (observed types — model leniently, `.passthrough()`):**

| field | observed | notes |
|---|---|---|
| `id` | number, always | numeric product id |
| `name` / `name_ko` | string, always | `name_ja` string\|null (246/460 null) |
| `country_code` | string(2), always | 17 values incl. GB, SG, KR, US, … |
| `availability` | string, always | **only `ON_SALE` seen** — real enum is larger; keep `z.string()` |
| `currency` | string(3), always | 13 ISO-4217 values (USD, GBP, SGD, CAD, KRW, JPY, …) |
| `amount` | number\|null | present ⇔ FIXED product (415/460) |
| `min_amount` / `max_amount` | number\|null | present together ⇔ RANGE product (45/460); 4 have min==max |
| `image_url` | string, always | |
| `description` / `description_ko` | string, always | `description_ja` string\|null |
| `validity` | number\|null (224 null) | **unit UNKNOWN** (days?) — open question |
| `type` | string, always | seen: `GIFT_CARD` (431), `MERCHANDISE` (28), `DIGITAL_VOUCHER` (1) — keep `z.string()` |
| `available_delivery_method` | string[], always ≥1 | values: `LINK`,`EMAIL`,`CODE`,`TEXT`,`DIRECT_SHIPPING` |
| `recipient_info_provided_by` | string[], always ≥1 | values: `SENDER`, `RECIPIENT` |
| `brand` | object, always (never null in sandbox) | keys: id, name, name_ko/ja, description*, discount_rate, terms*, disclaimer*, image_url |
| `category` | object, always | keys: id, name |
| `msrp` / `retail_price` / `net_price` | number\|null | null for the same 45 RANGE products |
| `transaction_fee_rate` | number\|null (56 null) | only `0` seen |
| `summary` / `summary_ko` | **always null** (460/460) | present but unused in sandbox |

**Amount model — clean XOR:** every product is exactly one of
- **FIXED** — `amount` is a number, `min_amount`/`max_amount` null (415 products), or
- **RANGE** — `min_amount`+`max_amount` numbers, `amount` null (45 products, all `GIFT_CARD`).

No product has both or neither. `amount`/`min`/`max` are plain numbers in **major currency
units** (balance is `5000.00`; KRW products are integer-valued like `30000`). Decimal scale
SodaGift accepts on orders is an **open question**.

### Verified delivery × recipient-info combinations (product-level, sandbox)

| `recipient_info_provided_by` | `available_delivery_method` (set) | count | `type` | amount |
|---|---|---|---|---|
| `[SENDER]` | `[CODE, EMAIL, LINK]` | 367 | GIFT_CARD | FIXED / RANGE |
| `[SENDER]` | `[EMAIL, LINK]` | 51 | GIFT_CARD | FIXED / RANGE |
| `[SENDER]` | `[CODE, EMAIL, LINK, TEXT]` | 10 | GIFT_CARD (9) + DIGITAL_VOUCHER (1) | FIXED |
| `[SENDER]` | `[TEXT]` | 4 | GIFT_CARD | FIXED |
| `[RECIPIENT, SENDER]` | `[DIRECT_SHIPPING, EMAIL, LINK]` | 27 | MERCHANDISE | FIXED |
| `[RECIPIENT, SENDER]` | `[DIRECT_SHIPPING, EMAIL, LINK, TEXT]` | 1 | MERCHANDISE | FIXED |

Consequences (these drive the code — do **not** hardcode past them):
- **`SENDER` is in every product** (432 `[SENDER]`, 28 `[RECIPIENT, SENDER]`). `RECIPIENT`
  never appears alone — it is an *additional* capability, and the sender chooses the mode at
  order time.
- **LINK is not SENDER-only:** 456 products offer LINK; 28 of them also allow `RECIPIENT`.
- **RECIPIENT products are not LINK-only:** all 28 also offer `DIRECT_SHIPPING`, `EMAIL`,
  `LINK` (+`TEXT` for 1).
- In the sandbox, `RECIPIENT` correlates 1:1 with `type = MERCHANDISE` + `DIRECT_SHIPPING` +
  FIXED amount — treat this as *data*, not a rule; always read the product arrays.
- **`LINK` is near-universal:** 456 of 460 products offer `LINK`; only the 4 `[TEXT]`-only
  GIFT_CARDs do not. The host product picker for the MVP filters to
  `available_delivery_method.includes("LINK")`.
- **`LINK` is not `SENDER`-only:** 456 products offer LINK; 428 as `[SENDER]`, 28 as
  `[RECIPIENT, SENDER]`. The recipient-info mode for a `LINK` order is set per request —
  which is exactly §11 unknown 7.
- `CODE` only ever pairs with `SENDER`. `DIRECT_SHIPPING` only ever pairs with
  `MERCHANDISE` + `[RECIPIENT, SENDER]`.

### MVP product constraint (per participant country — see §3A)

A product is eligible for a given participant iff, in the **live** catalog:
`country_code === participant.countryCode` **and** `availability === "ON_SALE"` **and**
`available_delivery_method.includes("LINK")` **and** (campaign `allowedProductTypes` empty or
includes `type`) **and** it matches `campaign.rewardPolicy`. Verified live at both display
(`GET /products?country=`) and fulfillment (fresh re-fetch before `POST /v1/orders`). LINK
is sender-provided (`recipient.name` only — §11 "LINK delivery — contract VERIFIED"), so `recipientInfoSource
= SENDER`.

- **Catalog fetch (requirement 49):** `GET /v1/products` server-side (`lib/sodagift/catalog.ts`),
  cached with a short TTL. Never hardcode product IDs or a country list.
- **Order creation:** the full `POST /v1/orders` contract (EMAIL + LINK) is **verified and
  locked** — see §11 "✅ EMAIL baseline — LOCKED" and "LINK delivery — contract VERIFIED".

### Finalized Zod schemas — `lib/sodagift/schemas.ts` (from real sandbox data)

Rules applied: nothing modeled stricter than 460/460 products support; `.passthrough()` on
every object so new fields don't break ingestion; delivery method & recipient source are
`z.array(z.string())` (data-driven) with separate `KNOWN_*` consts for UI/validation only;
unknown enum values are logged, never rejected.

```ts
export const KNOWN_DELIVERY_METHODS = ["LINK","EMAIL","TEXT","CODE","DIRECT_SHIPPING"] as const;
export const KNOWN_RECIPIENT_INFO_SOURCES = ["SENDER","RECIPIENT"] as const;
export const KNOWN_PRODUCT_TYPES = ["GIFT_CARD","MERCHANDISE","DIGITAL_VOUCHER"] as const;

// SodaGift enforces strictly alphanumeric (sandbox 400 on a hyphen). No `-`, `_`, space.
export const SgExternalReferenceId = z.string().regex(/^[A-Za-z0-9]{1,100}$/);
export const newExternalReferenceId = () => "sgl" + randomBytes(16).toString("hex"); // 35 chars

// Error body observed on 400s: { errorCode, message }. `invalid_request` is non-retryable.
export const SgErrorBody = z.object({
  errorCode: z.string(),   // e.g. "invalid_request", "order_retry_needed", "rate_limit_exceeded"
  message: z.string(),
}).passthrough();

// GET /v1/orders — `page` (0-indexed, min 0) AND `element_size` (0–500) are both required.
export const getOrderByReferenceQuery = (ref: string, page = 0, elementSize = 20) =>
  `/v1/orders?external_reference_id=${encodeURIComponent(ref)}&page=${page}&element_size=${elementSize}`;
export const SgOrderListResponse = z.object({
  page: z.object({
    page_number: z.number().int(),
    element_size: z.number().int(),
    result_size: z.number().int(),
    total_size: z.number().int(),
  }).passthrough(),
  orders: z.array(z.unknown()),
}).passthrough();

// custom_amount rule per docs: send it IFF the product has NO `amount` (variable/denomination
// product with min_amount/max_amount). Fixed product (`amount` present) -> omit / null.
// `customAmountMode` on the campaign config lets us override for verified exceptions
// (#50005 was a fixed product that demanded it — payment-card outlier, excluded from MVP).
export const CustomAmountMode = z.enum(["REQUIRED", "FORBIDDEN", "UNKNOWN"]);
export const customAmountModeOf = (p: SgProductT): "REQUIRED" | "FORBIDDEN" =>
  p.amount == null ? "REQUIRED" : "FORBIDDEN";

export const SgBalance = z.object({
  amount: z.number(),                 // major units; sandbox: 5000.00
  currency: z.string().length(3),
  payment_method: z.string(),         // sandbox: "PREPAID"
}).passthrough();

export const SgBrand = z.object({
  id: z.number().int(),
  name: z.string(),
  name_ko: z.string().nullish(),
  name_ja: z.string().nullish(),
  description: z.string().nullish(),
  description_ko: z.string().nullish(),
  description_ja: z.string().nullish(),
  discount_rate: z.number().nullish(),
  terms: z.string().nullish(),
  terms_ko: z.string().nullish(),
  terms_ja: z.string().nullish(),
  disclaimer: z.string().nullish(),
  disclaimer_ko: z.string().nullish(),
  disclaimer_ja: z.string().nullish(),
  image_url: z.string().nullish(),
}).passthrough();

export const SgCategory = z.object({
  id: z.number().int(),
  name: z.string(),
}).passthrough();

export const SgProduct = z.object({
  id: z.number().int(),
  name: z.string(),
  name_ko: z.string(),
  name_ja: z.string().nullable(),
  country_code: z.string().length(2),
  availability: z.string(),                     // sandbox: only "ON_SALE"
  currency: z.string().length(3),
  amount: z.number().nullable(),                // FIXED  ⇔ non-null
  min_amount: z.number().nullable(),            // RANGE  ⇔ min & max non-null
  max_amount: z.number().nullable(),
  image_url: z.string(),
  description: z.string(),
  description_ko: z.string(),
  description_ja: z.string().nullable(),
  validity: z.number().nullable(),             // unit UNKNOWN (open question 12)
  type: z.string(),                            // sandbox: GIFT_CARD | MERCHANDISE | DIGITAL_VOUCHER
  available_delivery_method: z.array(z.string()).min(1),
  recipient_info_provided_by: z.array(z.string()).min(1),
  brand: SgBrand,
  category: SgCategory,
  summary: z.string().nullable(),              // always null in sandbox
  summary_ko: z.string().nullable(),
  msrp: z.number().nullable(),
  retail_price: z.number().nullable(),
  net_price: z.number().nullable(),
  transaction_fee_rate: z.number().nullable(),
}).passthrough().refine(
  (p) => (p.amount != null) !== (p.min_amount != null && p.max_amount != null),
  { message: "product must be FIXED (amount) XOR RANGE (min_amount+max_amount)" },
);

export const SgProductsResponse = z.object({
  products: z.array(SgProduct),
  total_elements: z.number().int(),
}).passthrough();

export type SgProductT = z.infer<typeof SgProduct>;
export const rewardKindOf = (p: SgProductT): "FIXED" | "RANGE" =>
  p.amount != null ? "FIXED" : "RANGE";

// A product is eligible for a participant iff it is currently available FOR THEIR COUNTRY.
// §3A: this is checked at display AND re-checked against a fresh catalog before POST /v1/orders.
export const isEligibleForCountry = (
  p: SgProductT,
  countryCode: string,
  opts: { requiredDeliveryMethod?: string; allowedTypes?: string[] } = {},
): boolean =>
  p.country_code === countryCode &&
  p.availability === "ON_SALE" &&
  p.available_delivery_method.includes(opts.requiredDeliveryMethod ?? "LINK") &&
  (!opts.allowedTypes?.length || opts.allowedTypes.includes(p.type));

// selectable countries for a campaign — DERIVED from the catalog, never hardcoded.
export const selectableCountries = (
  products: SgProductT[],
  opts: { requiredDeliveryMethod?: string; allowedTypes?: string[]; restrictTo?: string[] } = {},
): string[] => {
  const set = new Set<string>();
  for (const p of products) {
    if (p.availability !== "ON_SALE") continue;
    if (!p.available_delivery_method.includes(opts.requiredDeliveryMethod ?? "LINK")) continue;
    if (opts.allowedTypes?.length && !opts.allowedTypes.includes(p.type)) continue;
    if (opts.restrictTo?.length && !opts.restrictTo.includes(p.country_code)) continue;
    set.add(p.country_code);
  }
  return [...set].sort();
};

// EMAIL baseline probe only — NOT a campaign path.
export const supportsEmailSender = (p: SgProductT): boolean =>
  p.available_delivery_method.includes("EMAIL") &&
  p.recipient_info_provided_by.includes("SENDER");
```

### Verified from official SodaGift docs (docs.sodagift.com, fetched 2026-08-30)

Sources: `/reference/v1createorder-1`, `/docs/delivery-methods`, `/reference/getorderbyid-1`,
`/reference/getorders-1`, `/reference/getproducts-1`.

**`POST /v1/orders` — full documented request schema:**

```jsonc
{
  "item": {
    "id": <product_id>,             // integer, required
    "custom_amount": <number>       // OPTIONAL. "only required when the product supports
                                    // custom amounts" — i.e. product `amount` is ABSENT and
                                    // `min_amount`/`max_amount` are present. For a fixed
                                    // product (`amount` present) it must be OMITTED
                                    // (#99001 -> "customAmount must be null"). Field is
                                    // snake_case `custom_amount`; errors name it `customAmount`.
                                    // (#50005 is a payment-card outlier that demanded it
                                    //  despite a fixed amount, then 500'd — excluded.)
  },
  "delivery": {
    "method": "TEXT" | "EMAIL" | "LINK" | "DIRECT_SHIPPING" | "CODE",   // required
    "recipient": {
      "name": "<string>",           // required
      "email": "<string>",          // per-method (see table)
      "phone_number": "<string>",   // per-method
      "address": { "line1", "line2", "locality", "administrative_area", "postal_code" }
    },
    "sender": { "name": "<string>", "email": "<string>" }   // name required; email optional
  },
  "message": "<string, <= 2000 chars>",   // optional
  "note": "<string, <= 150 chars>",       // optional
  "external_reference_id": "<string, 1-100 alphanumeric>"   // idempotency key
}
```

**Per-method required fields** (`/docs/delivery-methods`):

| method | required |
|---|---|
| `EMAIL` | `recipient.name`, `recipient.email`, `sender.name` |
| `TEXT` | `recipient.name`, `recipient.phone_number`, `sender.name` |
| **`LINK`** | **`recipient.name`, `sender.name`** — no email/phone. "You get a secure voucher URL and deliver it through your own channel." |
| `CODE` | `recipient.name`, `sender.name` |
| `DIRECT_SHIPPING` | `recipient.name`, `recipient.address`, `sender.name` |

**Idempotency — `external_reference_id`:** `^[A-Za-z0-9]{1,100}$` (strictly alphanumeric —
sandbox 400 on a hyphen). Repeating `POST /v1/orders` with the same value returns the
existing order (no duplicate, no second charge — **verified**, see below). No
`Idempotency-Key` header.

**Order lookup by id:** `GET /v1/orders/{id}` — path param only, no query. **Authoritative
reconciliation path.**

**Order lookup list:** `GET /v1/orders` — **both `page` and `element_size` are required**
(sandbox 400s confirmed both). `page` is **integer, min 0, 0-indexed** (docs). `element_size`
is 0–500. Filters include `external_reference_id`, `order_id`, `order_item_status`,
`recipient_email`, etc. Response envelope:
`{ "page": { "page_number", "element_size", "result_size", "total_size" }, "orders": [ … ] }`.
Use `result_size < element_size` to detect the last page.

**Voucher URL for `LINK`:** `GET /v1/orders/{id}` → `order_item.delivery.link` — "If delivery
method is set to LINK a URL will be provided for accessing the voucher." (`delivery.code` =
`{ value, pin, url, expired_at }` is for `CODE`; `delivery.shipping` = `{ tracking_number,
courier }` for `DIRECT_SHIPPING`.) The docs do **not** describe the `delivery.link` URL's
expiry, single-use/reuse, recipient-binding, or revocation behaviour — those properties are
**UNVERIFIED** (only `delivery.code.expired_at` and `recipient.acceptance.expiry_date` for
the RECIPIENT flow are documented, and neither applies here).

**Order status:** `COMPLETED` · `PAYMENT_PENDING` · `PAYMENT_EXPIRED` · `CANCELLED`.
**Order-item status:** `PENDING` · `COMPLETED` · `CANCELLED`.
Prepaid orders are `COMPLETED` immediately while the **order item lags at `PENDING`**
(verified below) → always reconcile item status too.

**No order-status webhooks exist.** Reconcile via **`GET /v1/orders/{id}`** (order id from
the create response) on a backoff schedule until both order and item are terminal. The list
form `GET /v1/orders?external_reference_id=…&page=0&element_size=<n>` is a secondary path
(both `page` and `element_size` are mandatory; `page` is 0-indexed).
`SODAGIFT_WEBHOOK_SECRET` is **not needed** — removed from env; no
`POST /api/webhooks/sodagift` route.

### ✅ EMAIL baseline — LOCKED (probe 1.b, run 5, live sandbox)

`POST /v1/orders` with `{ item:{ id:99001 }, delivery:{ method:"EMAIL", recipient:{name,email},
sender:{name} }, message, external_reference_id }` (no `custom_amount`):

| | value |
|---|---|
| A `POST /v1/orders` | **HTTP 200** |
| order `id` | `33814` |
| order `status` | **`COMPLETED`** |
| `order_item.id` | `33829` |
| `order_item.status` | **`PENDING`** (order done, item still settling) |
| `total_price_charged` | `5 USD` |
| B (identical `POST`, same `external_reference_id`) | HTTP 200, **same order `33814`, same item `33829`** |
| balance | `5000 → 4995 USD` — **charged exactly once** |
| `GET /v1/orders/{id}` | OK |

**Idempotency via `external_reference_id` is VERIFIED** — the duplicate `POST` created and
charged nothing. **EMAIL is a dev baseline only — NOT the production MVP path (see LINK).**

### LINK delivery — request/response contract VERIFIED; URL security model UNVERIFIED (probe 1.c, 2026-08-30, order `33815`)

The `POST /v1/orders` LINK request shape, the response shape, and where the voucher URL
lives are **verified** below. The URL's **expiry / reuse / recipient-binding / revocation**
behaviour is **not** — see point 13.

**1. Successful `POST /v1/orders` LINK request** (exactly this — nothing more):

```jsonc
{
  "item": { "id": 99001 },              // custom_amount OMITTED (fixed product)
  "delivery": {
    "method": "LINK",
    "recipient": { "name": "<string>" },// name ONLY
    "sender":    { "name": "<string>" } // name ONLY
  },
  "message": "<string, optional>",
  "external_reference_id": "<alphanumeric 1-100>"
}
```

- **2 / 3. Recipient:** only `recipient.name` is sent and required. `recipient.email` and
  `recipient.phone_number` are **NOT required and NOT sent** — order succeeded (`HTTP 200`,
  `COMPLETED`) without them. Response echoes `email:null, phone_number:null, address:null`.
- **4. Sender:** `sender.name` sent and accepted (docs mark it required; `sender.email`
  optional, came back `null`). Omission not tested — always send `sender.name`.

**5. `POST /v1/orders` response (create) — NO link URL here:**

```jsonc
{
  "id": 33815,                          // order id
  "status": "COMPLETED",
  "order_item": {                       // SINGULAR object; NO `delivery` block on create
    "id": 33830,
    "status": "PENDING",
    "price": { "amount": 5, "currency": "USD" },
    "transaction_fee_rate": 0
  },
  "total_price_charged": {
    "amount": 5, "currency": "USD",
    "applied_exchange_rate": { "rate": 1, "currency": { "from": "USD", "to": "USD" } }
  },
  "external_reference_id": "probelink…"
}
```

**6. Reward URL JSON path:** **`$.order_items[0].delivery.link`** — only on
`GET /v1/orders/{id}` (NOT on the create response). Note `order_items` is a **plural array**
in the GET response vs singular `order_item` in the create response.

**7. `GET /v1/orders/{id}` response (verified shape):**

```jsonc
{
  "id": 33815,
  "status": "COMPLETED",
  "external_reference_id": "probelink…",
  "created_at": "2026-08-30T00:21:49Z",
  "total_price_charged": { "amount": 5, "currency": "USD" },   // no applied_exchange_rate here
  "order_items": [
    {
      "id": 33830,
      "status": "PENDING" | "COMPLETED" | "CANCELLED",
      "item": { "id": 99001, "type": "GIFT_CARD", "name": "Zaxby's eGift",
                "price": { "amount": 5, "currency": "USD" },
                "brand": { "name": "Zaxby's", "nameEn": "Zaxby's" } },
      "price_charged": { "amount": 5, "currency": "USD",
                         "applied_exchange_rate": { "rate": 1, "currency": { "from": "USD", "to": "USD" } } },
      "transaction_fee_rate": 0,
      "delivery": {
        "method": "LINK",
        "recipient": { "name": "…", "phone_number": null, "email": null, "address": null,
                       "acceptance": { "status": null, "expiry_date": null } },
        "sender":    { "name": "…", "email": null },
        "link": "https://biz-sandbox.sodagift.com/welcome/my-gifts/<order_item_id>?t=<20-char token>",
        "shipping": null,
        "code": null
      }
    }
  ]
}
```

- **8. Order status on create:** `COMPLETED` (immediately; on both create response and G1).
- **9. `order_item` status on create:** `PENDING`.
- **10. G1 → G2 change:** **YES** — `order_items[0].status` went `PENDING` (t+0s) → `COMPLETED`
  (t+5s). Order `status` stayed `COMPLETED`. `delivery.link` was **present and identical**
  in both G1 and G2 (available before the item settles).
- **11. Redemption-security metadata in the API response:** none was present.
  `delivery.recipient.acceptance` exists but was `{ status: null, expiry_date: null }` (that
  object is the RECIPIENT-provided flow — unused for SENDER LINK). No `expires_at` /
  `valid_until` / `single_use` / `redeemed` / `opened` field appeared in the create or
  `GET /v1/orders/{id}` response. **Absence of these fields is not proof that the URL never
  expires or is reusable — it only means the API did not expose that information to us.**
- **12. Balance delta:** `4995 → 4990 USD` = **−5 USD**, charged **on creation** (not on
  redemption), same as EMAIL.
- **13. The link's security semantics are UNVERIFIED — treat it as a bearer secret by
  default.** Shape:
  `https://biz-sandbox.sodagift.com/welcome/my-gifts/33830?t=CJzgIy2XnCHHgU1JCDtV`
  — path segment is the (enumerable) `order_item.id`; the `?t=` param is a ~20-char opaque
  token. **VERIFIED:** the same URL string came back in both G1 (t+0 s) and G2 (t+5 s), i.e.
  it was valid and unchanged over that ~5-second window. **NOT VERIFIED:** whether it
  expires, whether it is single-use or reusable, whether it is bound to a recipient/identity,
  whether it can be revoked, or any other redemption-security property — no probe or SodaGift
  doc has shown any of these. Under that uncertainty we treat it as a bearer secret: store in
  **`Reward.rewardUrlEnc`** (AES-256-GCM), **never log it**, and **do not treat possession of
  it as authorization**. This is why the **default** is `Campaign.claimLinkMode =
  PROTECTED_TOKEN` (option B — the safer design under uncertainty), not because we have proven
  the raw URL is unbound or non-expiring. **The A-vs-B choice is not locked** (§9/§10); a
  future probe of expiry/reuse/binding could make option A acceptable.

**Rate-limit headers observed:** `x-ratelimit-limit: 10`, `x-ratelimit-remaining`,
`x-ratelimit-reset` (unix seconds) on order endpoints — the client honours these.


**Verified retry policy** (`lib/sodagift/client.ts`):
| condition | action |
|---|---|
| network timeout | retry, **same** `external_reference_id` |
| `500` with `errorCode = order_retry_needed` | retry with exponential backoff, same ref id |
| `500` with **any other** `errorCode` (e.g. `unhandled_error`) | **do NOT auto-retry** — treat as a hard failure, `Reward.status = ORDER_FAILED`, alert. Only `order_retry_needed` is retry-safe. |
| `429` `rate_limit_exceeded` | wait (respect any retry hint) and retry, same ref id |
| `400 errorCode = invalid_request` | **client bug — fix the request, never retry** (seen: bad ref-id charset; missing `customAmount` on #50005; `customAmount` sent on #99001; missing `element_size` / `page` on list lookup) |
| any other `4xx` | **do not** auto-retry — surface to the fulfillment UI |

Error body: `{ "errorCode": string, "message": string }`. Log both (they are not secrets).
Observed `errorCode` values so far: `invalid_request` (400), `unhandled_error` (500),
plus the documented `order_retry_needed` / `rate_limit_exceeded`.

### Idempotency & concurrency (our side)

- `externalReferenceId` generated once when the `Reward` row is created (at draw), stored
  `UNIQUE`, tied 1:1 to the winner. Format: **`"sgl" + <hex>`** with no separators, e.g.
  `"sgl" + randomBytes(16).toString("hex")` (35 chars) — must match
  **`^[A-Za-z0-9]{1,100}$`** (no hyphen/underscore/UUID dashes). A `zod`
  `SgExternalReferenceId` guards every value before it is sent.
- Every create **and every retry** sends the exact same `external_reference_id`.
- On uncertain outcome (timeout / `500 order_retry_needed` / `429`): reconcile by **order
  id** via `GET /v1/orders/{id}` when we have it; otherwise the safe move is to **re-`POST`
  with the same `external_reference_id`** (returns the existing order — no duplicate,
  verified) or `GET /v1/orders?external_reference_id=…&page=0&element_size=20`.
- Store `sodagiftOrderId`, order status, **and** item status on first definitive success;
  keep the PII/code-scrubbed body in `Reward.sodagiftOrderRaw`.
- **Concurrency (54):** status-gated `UPDATE ... WHERE status IN (...)` + row lock in the
  fulfill transaction → one in-flight create per reward. Unique `externalReferenceId` (our
  DB) + SodaGift's ref-id dedupe are the backstops.

### RewardStatus ↔ SodaGift mapping (verified against LINK order 33815)

| SodaGift order / item | `Reward.status` |
|---|---|
| create `200`, order `COMPLETED`, item `PENDING` | `ORDER_CREATED` — store `sodagiftOrderId` + `order_items[0].id`; begin polling |
| order `COMPLETED`, item `PENDING` (still) | `ORDER_CREATED` (keep polling `GET /v1/orders/{id}`) |
| order `COMPLETED`, item `COMPLETED` | `FULFILLED` (item settled seconds after create in the probe) |
| order `PAYMENT_PENDING` | `ORDER_CREATED` (not seen for prepaid; possible for other funding) |
| order `PAYMENT_EXPIRED` / `CANCELLED`, or item `CANCELLED` | `ORDER_FAILED` |
| non-retryable `4xx` on create | `ORDER_FAILED` |

`delivery.link` is present as soon as the order is created (before item `COMPLETED`), so we
can read + encrypt it at `ORDER_CREATED`; in the default `PROTECTED_TOKEN` mode we surface it
only to a Twitch-verified winner (§9), and only mark `FULFILLED` on item `COMPLETED`.

- **No recipient acceptance-link flow** unless its exact contract is verified (58).
- **Never log:** API key, gift/voucher codes, reward/claim URLs, recipient PII,
  OAuth/refresh/claim/ID tokens (55). **Do** keep SodaGift diagnostics —
  `errorCode` / `message` / `status` / field names — they are not secrets and are needed
  for debugging. Log order id + order status + item status + our ref id + errorCode.

### Verified vs UNKNOWN matrix (order creation)

**RESOLVED — docs + sandbox:**
- Full `POST /v1/orders` request schema (`item`, `delivery.{method,recipient,sender}`,
  `message`≤2000, `note`≤150, `external_reference_id`) and the per-method required-field
  table — see "Verified from official SodaGift docs" above.
- `external_reference_id`: `^[A-Za-z0-9]{1,100}$`; **idempotency verified live** (duplicate
  `POST` → same order/item, no second charge). No extra header.
- **EMAIL end-to-end verified** (order `33814`, item `33829`, `COMPLETED`/`PENDING`, charged
  5 USD once). Create response envelope confirmed. EMAIL is done.
- **`custom_amount` rule (docs):** send it **iff the product has no `amount`** (variable /
  denomination product). Fixed product (`amount` present) → **omit** (#99001 confirms:
  `"customAmount must be null"`). `#50005` is a **payment-card outlier** — fixed but
  demanded `custom_amount`, then `500 unhandled_error`; **excluded from MVP**. Model:
  `customAmountModeOf(p) = p.amount == null ? "REQUIRED" : "FORBIDDEN"`, with a per-product
  override map for verified exceptions.
- **List lookup (docs):** `GET /v1/orders` needs `page` (int, **0-indexed**, min 0) **and**
  `element_size` (0–500). Envelope `{ page:{page_number,element_size,result_size,total_size},
  orders:[…] }`. Filter `external_reference_id` supported. Secondary to `{id}` lookup.
- **Error body:** `{ errorCode, message }`. Seen: `invalid_request` (400),
  `unhandled_error` (500), documented `order_retry_needed` / `rate_limit_exceeded`.
- **LINK request (docs):** `delivery.method = "LINK"` requires **`recipient.name` +
  `sender.name`** only — no email/phone/address. "You get a secure voucher URL and deliver
  it through your own channel."
- **LINK voucher URL (docs):** `GET /v1/orders/{id}` → **`order_item.delivery.link`**. The
  docs do **not** describe its expiry, single-use/reuse, recipient-binding, or revocation
  behaviour (they only document `delivery.code.expired_at` for `CODE` and
  `recipient.acceptance.expiry_date` for the RECIPIENT flow). Those `delivery.link`
  properties are **UNVERIFIED**.

**Probe 1.c (LINK), order 33815 — what is VERIFIED:** the documented body succeeds as written
for #99001; `recipient.name` only (no email/phone); create response has **no** link; the
voucher URL is at `GET /v1/orders/{id}` → `$.order_items[0].delivery.link` and can be
extracted + stored; order `COMPLETED` / item `PENDING` on create → item `COMPLETED` within
seconds; the same URL string was returned unchanged across the two GETs ~5 s apart.
**What is NOT verified:** the URL's expiry, single-use/reuse, recipient/identity binding,
revocation, or other redemption-security semantics — no probe or SodaGift doc has shown any
of these. Because of that uncertainty we treat the URL as a bearer secret and keep **option
B** (`/claim/[token]`) as the supported **default** (§9/§10; A-vs-B not locked). Full detail
in "LINK delivery — contract VERIFIED" above. The request/response *shape* of the SodaGift order
contract is specified; its URL security model is an open question.

### LINK delivery — the real MVP fulfillment path

Target flow: **Twitch participant → OIDC identity → verified `twitchUserId` → campaign
participation (with `countryCode`) → backend random winner selection → determine
`winner.countryCode` + eligible reward → SodaGift `LINK` order → store the reward URL
encrypted (`Reward.rewardUrlEnc`) → Host Twitch OAuth (`user:manage:whispers`, §5) → Twitch
Whisper to `winner.twitchUserId` containing a usable claim link.** The Whisper is a
**required V1 feature**; the claim-link contents (raw SodaGift URL vs our `/claim/<token>`)
are **not yet decided** (§9/§10, default = `/claim/<token>`). `EMAIL` is a dev baseline only.
Probes 1.b + 1.c are **done**; `lib/sodagift/orders.ts` can be written per the locked contract.

**Non-blocking (not required for MVP):**
- `/v1/products` pagination params (sandbox returns all 460 at once).
- `validity` unit (days?) — affects winner-facing expiry copy only.
- Product `country_code` / `currency` vs host/participant region matching rules.
- Full `RECIPIENT`-provided flow — deferred (docs: `LINK` needs only `recipient.name` +
  `sender.name`, so `SENDER` mode is fine); revisit only if probe 1.c contradicts the docs.

`lib/sodagift/orders.ts` LINK path stays a typed stub + mock until probe 1.c confirms the
create/lookup response shape. The EMAIL path is contract-locked and may be written now.

---

## 12. Environment variables

```
# --- App ---
APP_URL                          # canonical public origin; builds campaign + claim URLs and QR
NODE_ENV

# --- Database ---
DATABASE_URL                     # postgres://...

# --- Twitch (one app registration, host + participant flows) ---
TWITCH_CLIENT_ID
TWITCH_CLIENT_SECRET
TWITCH_HOST_REDIRECT_URI         # https://<APP_URL>/api/auth/host/callback
TWITCH_PARTICIPANT_REDIRECT_URI  # https://<APP_URL>/api/auth/participant/callback
TWITCH_OAUTH_AUTHORIZE_URL       # https://id.twitch.tv/oauth2/authorize
TWITCH_OAUTH_TOKEN_URL           # https://id.twitch.tv/oauth2/token
TWITCH_OIDC_ISSUER               # https://id.twitch.tv/oauth2
TWITCH_JWKS_URI                  # https://id.twitch.tv/oauth2/keys
TWITCH_HELIX_BASE                # https://api.twitch.tv/helix

# --- Crypto / sessions (each a base64 32-byte random key) ---
TOKEN_ENCRYPTION_KEY             # AES-256-GCM for secrets at rest — IMPLEMENTED: encrypts the SodaGift voucher URL (Reward.rewardUrlEnc). src/lib/crypto/secretbox.ts
SESSION_SECRET                   # JWE key for session cookies
AUTH_STATE_SECRET                # JWE key for short-lived OAuth state/nonce/proof/campaign/claim cookies
SESSION_TTL_HOURS=12
PARTICIPANT_SESSION_TTL_HOURS=24
CLAIM_TOKEN_TTL_HOURS=168

# --- SodaGift (Sandbox) --- values in C:\soda\.env.local (git-ignored, server-only) ---
SODAGIFT_BASE_URL               # https://biz-sandbox-api.sodagift.com  (no trailing slash)
SODAGIFT_API_KEY                # sandbox-only, prefix sodagift_test_ ; never NEXT_PUBLIC_, never logged
SODAGIFT_SENDER_NAME            # display name sent as delivery.sender.name on orders (e.g. "SodaGift Live")
# (no webhook secret — SodaGift has no order-status webhooks; we poll)

# --- Ops (optional) ---
RATE_LIMIT_REDIS_URL
```

Secrets (`*_SECRET`, `*_KEY`, `TWITCH_CLIENT_SECRET`, `SODAGIFT_API_KEY`,
`TOKEN_ENCRYPTION_KEY`) are server-only. No `NEXT_PUBLIC_` prefix on any of them.

---

## 13. Security & failure cases

### Auth / OIDC
- `state` mismatch, replay, or missing → reject. `state` is single-use, 10-min TTL.
- `nonce` missing or mismatched in the ID token → reject.
- ID token wrong `iss` / `aud`, expired, bad signature, `alg=none` → reject (`jose` RS256
  allowlist).
- JWKS fetch failure / key rotation → cached remote set + retry; fail closed.
- Auth-code interception → PKCE + client secret + exact `redirect_uri`.
- Open redirect via `returnTo` → local-path allowlist (single leading `/`, no `//`, no
  scheme).
- CSRF on POST handlers → `Origin` / `Sec-Fetch-Site` check + `SameSite=Lax`.
- Session cookie theft → `HttpOnly` + `Secure` + short TTL + `sessionVersion`; no tokens in
  the cookie.
- Host tokens at rest → AES-256-GCM, key from env/KMS, never logged.
- Scope minimization → participants never get chat/mod/whisper scopes; host gets only
  `user:manage:whispers`.

### Identity / authorization
- Display-name spoofing → display name is never an authz identifier; only `sub` (host: Helix
  user id).
- Forwarded / copied claim URL → `session.sub === winner.twitchUserId` constant-time check
  blocks it.
- Client submitting arbitrary winner IDs → draw is fully server-side; no winner ids accepted
  from the client.
- Duplicate campaign entry → `UNIQUE(campaignId, twitchUserId)` on `Participant`.

### Draw
- Double draw (double-click, retry, concurrent hosts) → atomic
  `UPDATE ... WHERE status = 'PUBLISHED'` gate + Serializable txn +
  `UNIQUE(campaignId, participantId)`.
- Biased RNG → `crypto.randomInt` Fisher–Yates, never `Math.random`.
- Fewer eligible than `winnerCount` → draw `min(...)`, flag partial draw.
- Mid-draw failure → single transaction, full rollback.

### Claim / fulfillment
- Token guessing / enumeration → 256-bit token, only SHA-256 hash stored, generic `404`,
  rate limiting.
- Expired token → `410`; winner still recoverable via the authenticated page.
- Concurrent fulfill submissions → row lock + status-gated `UPDATE` + unique
  `externalReferenceId`.
- Double gift order → frozen `external_reference_id` (1–100 alphanumeric) reuse; duplicate
  `POST /v1/orders` returns the existing order (documented) + our unique constraint.
- SodaGift timeout / `500 order_retry_needed` / `429 rate_limit_exceeded` → reconcile with
  `GET /v1/orders?external_reference_id=…`, then retry (backoff) with the same ref id; never
  double-issue. Other `4xx` → no auto-retry, surface to fulfillment UI.
- PII exposure → delivery info encrypted at rest, collected only from verified winners, kept
  on `Reward` separate from `Winner`.

### Whisper
- Host lacks verified phone / whispers disabled → `401`; actionable message + fallback.
- Recipient blocks whispers / silent drop → not treated as delivery guarantee; fallback
  page is the source of truth.
- `429` → backoff, spread sends.
- Stale host token → refresh; refresh failure → `needsReconnect`.

### Logging / secrets
- Never log gift codes, voucher URLs, API keys, OAuth/refresh tokens, raw claim tokens, ID
  tokens, or recipient PII. Central logger with a redaction allowlist.
- `SODAGIFT_API_KEY` / `TWITCH_CLIENT_SECRET` server-only; absent from client bundles.

### Ops
- DB unavailable during a callback → user-facing retry; no partial session or partial Host
  row.
- Cookies disabled / third-party context → the flow is same-site top-level so it works;
  otherwise instruct the participant.
- Clock skew → `clockTolerance: 5` on `jwtVerify`.
- QR pointing at the wrong origin → always built from `APP_URL`.

---

## 14. Proposed repository layout (not yet created)

```
prisma/schema.prisma
src/
  app/
    (marketing)/page.tsx
    c/[publicId]/page.tsx
    claim/[token]/page.tsx
    host/page.tsx
    host/campaigns/new/page.tsx
    host/campaigns/[id]/page.tsx
    api/
      auth/host/{login,callback,logout}/route.ts
      auth/participant/{login,callback,logout}/route.ts
      host/campaigns/route.ts
      host/campaigns/[id]/route.ts
      host/campaigns/[id]/{publish,draw,whispers}/route.ts
      host/sodagift/products/route.ts
      campaigns/[publicId]/{countries,join,products,reward-choice,me}/route.ts
      campaigns/[publicId]/claim/start/route.ts
      claim/[token]/{verify,fulfill}/route.ts
      campaigns/[publicId]/qr/route.ts
      health/route.ts
  lib/
    db/prisma.ts
    auth/{session,oauth-state,twitch-oauth,twitch-oidc,guards}.ts
    crypto/{encryption,tokens}.ts
    twitch/{users,whisper,token-refresh}.ts
    sodagift/{client,catalog,orders,schemas}.ts   # catalog: listProducts+cache, selectableCountries, isEligibleForCountry
    campaign/reward-resolution.ts                 # modes A/B/C -> Reward.sodagiftProductId for a countryCode
    draw/select-winners.ts
    validation/schemas.ts
    logging/redact.ts
```

---

## 15. Phased delivery plan

Implementation is sequenced so each phase is independently reviewable and leaves the tree
in a working state. **Only Phase 1 is authorized to start after architecture sign-off.**

### Phase 0 — Repo bootstrap (no product logic)
- `next` (App Router, TS), ESLint/Prettier, `tsconfig` strict.
- `prisma` init; Postgres connection via `DATABASE_URL`.
- `.gitignore` including `.env*` (keep `.env.example`); `git init`.
- `lib/db/prisma.ts` singleton, `lib/logging/redact.ts` (central redactor), `GET /api/health`.
- `.env.example` listing every var from §12.

### Phase 1 — SodaGift server integration + catalog (authorized)
- **1.a — DONE:** `scripts/sodagift-probe.ts` run locally by the owner (2026-08-29).
  `/v1/accounts/balance` and `/v1/products` (460 products) captured and analysed. Verified
  catalog shape + delivery/recipient combinations are recorded in §11.
- `lib/sodagift/client.ts`: server-only fetch wrapper — base URL from `SODAGIFT_BASE_URL`,
  **`SODA-API-KEY: <key>` header on every request** (no `Authorization: Bearer`), timeout,
  typed errors, response Zod schemas, redacted logging (order id + status + our ref id
  only; never key / codes / voucher URLs).
- `lib/sodagift/catalog.ts`: `getBalance()` + `listProducts()` (cached) against
  `/v1/accounts/balance` and `/v1/products`, finalized Zod schemas (`SgBalance`,
  `SgProductsResponse`, `SgProduct`, `SgBrand`, `SgCategory`; lenient `.passthrough()`,
  delivery/recipient as `string[]`, amount XOR refine). Plus `selectableCountries(campaign)`
  and country-filtered `products(campaign, countryCode)` (§3A). `customAmountModeOf(p)`.
- `GET /api/host/sodagift/products` (host proxy) + participant `GET /countries` /
  `GET /products?country=` route handlers — server-side, key never to client.
- `lib/sodagift/orders.ts`: `createLinkOrder({ productId, customAmount?, recipientName,
  externalReferenceId })` + `getOrderById(id)` + `extractLinkUrl(order)` =
  `order.order_items[0].delivery.link`. Contract fully locked (probes 1.b + 1.c). EMAIL
  helper retained for reference only, not a campaign path. No speculative fields (req 59).
- Unit tests for the client (mocked fetch):
  - `SODA-API-KEY` header is present on **every** SodaGift API request
  - **no** `Authorization: Bearer` header is sent (unless a documented endpoint requires it)
  - the API key never appears in log output and is never sent to client code
  - `SgProduct` parses every one of the 460 captured sandbox products
  - `external_reference_id` is reused unchanged on retry (mock)
  - uncertain response (timeout → reconcile-then-retry) path (mock)
- **Deliverable for review (this document):** finalized product/balance Zod schemas, the
  verified delivery × recipient × type × amount combination matrix (§11), and the finalized
  `Campaign` reward-value model (§3: `rewardKind`, `rewardAmount`, `rewardCurrency`,
  `deliveryMethod`, `recipientInfoSource`).
- **Probe 1.b — EMAIL baseline: ✅ DONE & VERIFIED (run 5).** `scripts/sodagift-probe-order.ts`
  created order `33814` on **#99001** with `item:{ id:99001 }` (no `custom_amount`), status
  `COMPLETED` / item `33829` `PENDING`, charged 5 USD; identical re-`POST` returned the same
  order (idempotency verified); `GET /v1/orders/{id}` OK. Contract locked in §11. **No more
  EMAIL work.**
- **Probe 1.c — LINK delivery: order contract verified; URL security model UNVERIFIED.**
  `scripts/sodagift-probe-order-link.ts` created order `33815` on **#99001** with the docs
  body (`method:"LINK"`, `recipient:{name}`, `sender:{name}`, no `custom_amount`).
  **Verified:** order `COMPLETED` / item `PENDING` → `COMPLETED` in ~5 s; voucher URL at
  `GET /v1/orders/{id}` → `$.order_items[0].delivery.link` (not on the create response), and
  it can be extracted + stored; same URL string across the two GETs ~5 s apart. **NOT
  verified:** whether that URL expires, is single-use/reusable, is recipient/identity-bound,
  or can be revoked. Treat as a bearer secret → keep option B supported + default (§9/§10;
  A-vs-B open). Balance `−5 USD` on create. Detail in §11 "LINK delivery — contract VERIFIED".
- SodaGift order **request/response shape** is fully specified; its URL security model is
  open. `lib/sodagift/orders.ts`
  (`createLinkOrder` + `getOrderById` + reward-URL extraction) can be written per §11.

### Phase 2 — Data layer
- Final `schema.prisma` (§3) + initial migration.
- `lib/crypto/encryption.ts` (AES-256-GCM) + `lib/crypto/tokens.ts` (CSPRNG + SHA-256).
- Repository/query helpers; seed script for local dev.

### Phase 3 — Host auth + campaign CRUD
- Host OAuth (§5), session cookies (§7), `requireHost()` guard.
- `/host`, `/host/campaigns/new`, `/host/campaigns/[id]`; campaign create/edit/publish.
- QR + public URL generation from `APP_URL`.

### Phase 4 — Participant OIDC + country selection + entry
- Participant OIDC (§6), `requireParticipant()` guard. **(The §17 proof is the first slice
  of this phase.)**
- `lib/sodagift/catalog.ts`: `selectableCountries(campaign)` + country-filtered
  `products()` (§3A), cached catalog.
- `/c/[publicId]` states; `GET /countries`, `POST /join` (creates `Participant`
  `{campaignId, twitchUserId, countryCode, joinedAt}`, `UNIQUE(campaignId, twitchUserId)`),
  `GET /products?country=`; `eligible` derivation.

### Phase 5 — Draw + claim + country-resolved fulfillment (LINK)
- `POST /api/host/campaigns/[id]/draw` (§8): winners across all countries; per winner a
  `Reward { countryCode }` with the product resolved per `rewardSelectionMode` (§3A).
- Determine `winner.countryCode` + eligible reward; re-validate `Reward.sodagiftProductId`
  for `Reward.countryCode` against a fresh catalog; `createLinkOrder` (idempotent, §11) →
  `GET /v1/orders/{id}` → `order_items[0].delivery.link` → `Reward.rewardUrlEnc` (encrypted).
- `/claim/[token]` (option B, default): verify authenticated Twitch user == `winner.twitchUserId`
  → reveal/redirect to the stored SodaGift URL. `FULFILLED` on item `COMPLETED`.
- **Decide claim-link option A vs B** here (§9/§10) — schema already supports both via
  `Campaign.claimLinkMode`.

### Phase 6 — Host OAuth + Twitch Whisper + fallback + hardening  (REQUIRED V1)
- **Host Twitch OAuth** (§5, scope `user:manage:whispers`) — separate app authorization from
  participant OIDC (`openid`). Encrypted host token storage + refresh.
- **Twitch Whisper send** of the claim link to `winner.twitchUserId` + `WhisperAttempt`
  logging (§10); authenticated-page discovery as an **additional** fallback (not a
  replacement).
- Rate limiting, CSRF checks, redaction audit, error pages, status reconciliation.

## 16. Implementation status

- **Done:** architecture (schema, routes, flows); SodaGift sandbox probe 1.a
  (`/v1/accounts/balance`, `/v1/products` × 460); verified catalog shape + combination
  matrix (§11); finalized SodaGift product/balance Zod schemas; finalized `Campaign`
  reward-value model (§3); order-creation contract folded in from official docs — request
  envelope, `external_reference_id` idempotency, order/item status enums, lookup endpoints,
  no-webhook polling model, retry policy (§11 "Verified from official SodaGift docs").
- **Partly done:** Phase 0 repo bootstrap (Next.js App Router + TS; no Prisma/DB yet).
- **✅ Twitch participant OIDC proof — VERIFIED in a real local login.** `/` → Continue with
  Twitch → OIDC (state+nonce+PKCE, server-side exchange, `jwtVerify` sig/iss/aud/exp+nonce)
  → `/auth/result` shows the verified `sub`. Security flow frozen — do not modify.
- **✅ Country-selection + country-specific catalog proof — IMPLEMENTED (approved
  2026-08-30), `next build` + `tsc` green.** `/auth/result` → [Continue] (Server Action
  re-seals `sl_proof` @30 min) → `/country` (dropdown from live catalog:
  `selectableCountries` = distinct `country_code` over `ON_SALE` + `LINK` products) →
  `/rewards?country=XX` (server-revalidates `XX`, shows `productsForCountry` =
  `country_code==XX && ON_SALE && available_delivery_method⊇LINK`, mapped to a non-sensitive
  `PublicProduct`). New: `src/lib/sodagift/{client,schemas,catalog}.ts`,
  `src/lib/auth/proof-session.ts`, `src/app/actions/continue.ts`, `src/app/country/`,
  `src/app/rewards/`; `env.ts` gains `sodagift()`. `SODAGIFT_API_KEY` stays server-only
  (`server-only` import + RSC-only fetch). **No orders, no Participant DB, no
  campaign/QR/draw/Host OAuth/Whisper.** `amountKind` is catalog info only — no
  `custom_amount` behaviour is inferred from it.
- Phase 1 `lib/sodagift/orders.ts` (order writes): not started.
- **✅ Probe 1.b — EMAIL baseline VERIFIED (run 5).** Order `33814` on **#99001**
  (`item:{ id:99001 }`, no `custom_amount`), `COMPLETED` / item `33829` `PENDING`, 5 USD;
  idempotent re-`POST` → same order, no second charge; `GET /v1/orders/{id}` OK. Contract
  locked in §11. Earlier runs 1–4 taught: ref-id must be `^[A-Za-z0-9]{1,100}$`; #50005
  (payment-card) demanded `custom_amount` then `500 unhandled_error` → excluded;
  `custom_amount` rule = omit for fixed products (`amount` present), send for variable
  products (`amount` absent) — per docs, #99001 confirms.
- **✅ Official docs mined** (docs.sodagift.com): full `POST /v1/orders` schema; per-method
  required fields (LINK = `recipient.name` + `sender.name`); `delivery.method` enum
  `TEXT|EMAIL|LINK|DIRECT_SHIPPING|CODE`; LINK voucher URL = `order_item.delivery.link`;
  list lookup needs `page` (0-indexed) + `element_size` (0–500), envelope
  `{ page:{…}, orders:[…] }`. All in §11.
- **Probe 1.c — LINK order contract VERIFIED (order `33815`, #99001):** request body
  (`recipient.name`-only, no email/phone), create response has no link, voucher URL =
  `GET /v1/orders/{id}` → `$.order_items[0].delivery.link` (extractable + storable),
  `COMPLETED` / item `PENDING→COMPLETED` in ~5 s, same URL across two GETs ~5 s apart,
  balance `−5 USD`. **URL security model (expiry / reuse / recipient-binding / revocation)
  UNVERIFIED** → treat as bearer secret, keep claim-link **option B supported + default**;
  A-vs-B decided in Phase 5 (§9/§10).
- **SodaGift order request/response shape is fully specified.** `lib/sodagift/orders.ts` LINK
  path may be written per §11. `EMAIL` is a dev baseline only — **not a production path**.
- **Twitch Whisper delivery of the winner's claim link is a REQUIRED V1 feature** (§10,
  Phase 6) — implemented after Participant persistence + winner selection, via **Host Twitch
  OAuth** (`user:manage:whispers`, §5), which is separate from participant OIDC (`openid`).
  The authenticated-page discovery path is an *additional* fallback, never a replacement.
- **✅ Global-participant architecture (2026-08-30):** campaigns are country-agnostic
  (reward *policy*, not a product); `Participant.countryCode` is **user-selected** (never
  from Twitch); selectable countries + products are **derived from the live SodaGift
  catalog** (`ON_SALE` + `LINK` + policy), not hardcoded; per-winner `Reward` resolves a
  country-specific product; one campaign → US/KR/JP winners. Reward-selection modes A/B/C
  all kept open. See §1, §3 (Campaign / CampaignCountryOption / Participant / Reward), §3A,
  §4, §6, §8, §9. **Not implemented — schema only.**
- **Doc correction (2026-08-30):** the SodaGift `delivery.link` is **not** stated as
  verified-non-expiring / verified-unbound / verified-reusable / definitely-a-bearer-token.
  Verified = order creates, URL is exposed + extractable + storable, same string across two
  GETs ~5 s apart. Expiry / reuse / recipient-binding / revocation = **UNVERIFIED**.
  `PROTECTED_TOKEN` stays default as the safer design under that uncertainty (§9/§10/§11).
- **✅ Campaign + publicId + QR milestone — IMPLEMENTED (approved 2026-08-30), `tsc` +
  `next build` green.** Introduces **Prisma + PostgreSQL** (docker-compose). `Campaign`
  model (§3 global model incl. `claimLinkMode`); unguessable `publicId`; **dev-only**
  unauthenticated `/dev/campaigns/new` (+ `/dev/campaigns` list, blocked when
  `NODE_ENV=production`) + `scripts/seed-campaign.ts`; public page `/c/[publicId]`; QR PNG at
  `/api/c/[publicId]/qr.png` encoding **only** `${APP_URL}/c/${publicId}`; campaign-scoped
  flow `/c/[publicId]` → Twitch OIDC (**unchanged**) → `/c/[publicId]/country` →
  `/c/[publicId]/rewards?country=XX`, catalog filtered by the campaign's constraints. The
  standalone `/country` + `/rewards` routes were removed. Campaign context rides in a new
  encrypted `sl_campaign` cookie (HttpOnly, SameSite=Lax, Secure-in-prod, 15-min, `publicId`
  only) and is **re-validated against the DB** on every page — never trusted as authoritative
  identity. `sl_proof.sub` (identity) and validated `Campaign.publicId` (context) stay
  separate. **Not in this milestone:** Participant DB rows, duplicate-entry prevention,
  winner selection, SodaGift order creation, `Reward` / `ClaimToken`, Host OAuth, Twitch
  Whisper.
- **✅ Host OAuth + one-test-Whisper proof — IMPLEMENTED (approved 2026-08-30), `tsc` +
  `next build` green; the real test whisper NOT yet sent.** Isolated technical proof,
  **completely separate** from participant OIDC: routes `/api/auth/host/{login,callback,
  logout}` + dev page `/dev/host` (all `notFound()` in production). Scope **exactly
  `user:manage:whispers`**; Authorization Code + PKCE + CSPRNG `state`; server-side code
  exchange (`client_secret` only in `lib/twitch/host-oauth.ts`). After exchange the token is
  **validated** at `https://id.twitch.tv/oauth2/validate` — asserts `client_id` = ours and
  `scopes` contains `user:manage:whispers`; `from_user_id` comes **only** from the validated
  `user_id`. Temp host token lives in an encrypted HttpOnly `sl_host` cookie (60-min,
  Path=/, no DB) — never in browser JS; distinct from `sl_oidc`/`sl_proof`/`sl_campaign`.
  One `POST https://api.twitch.tv/helix/whispers?from_user_id=&to_user_id=` per explicit
  click (10-s cooldown), fixed body `{"message":"SodaGift Live test whisper. No reward has
  been issued."}`; `to_user_id` is a manually entered numeric id (`^\d{1,20}$`), never used
  as `from_user_id`. **HTTP 204 = Twitch accepted the request only — not proof of delivery**
  (Twitch may silently drop; host account needs a verified phone). No SodaGift order, no
  reward URL, no Participant DB / draw / fulfillment. New env (defaults): `TWITCH_VALIDATE_URL`,
  `TWITCH_HELIX_BASE`, `TWITCH_HOST_REDIRECT_URI` (origin must match `APP_URL`; add the same
  URL to the Twitch console's OAuth Redirect URLs).
- **✅ Participant persistence + Join Giveaway — IMPLEMENTED (approved 2026-08-30), migration
  `20260830021631_participant` applied, `tsc` + `next build` green.** `Participant` model
  (`id, campaignId, twitchUserId, countryCode, joinedAt`) + **`@@unique([campaignId,
  twitchUserId])`** + `Campaign.participants` back-relation (no Campaign column change).
  `twitchUserId` = the verified OIDC `sub` from `sl_proof` **only** — never form/query/JS/
  display-name; the `joinGiveaway` action has no `twitchUserId` parameter. `campaignId`
  resolved server-side from `publicId` via `getCampaignByPublicId`. `countryCode` re-validated
  with `isSelectableCountry(...)` (live catalog ∩ campaign constraints) before persisting.
  **[ Join Giveaway ]** button on `/c/[publicId]/rewards` (below the product list; shows
  "already joined" instead if a row exists) → `joinCampaign()` = `create` catching `P2002`
  → returns the existing row on duplicate, **never a second row** → `/c/[publicId]/joined`
  confirmation (Campaign / Twitch User ID / Country). Helpers added: `getParticipant`,
  `countParticipants`, `participantCountryBreakdown`. `/dev/host` gained a banner marking the
  manual recipient field as an **isolated API probe, not product behaviour**. **NOT done:**
  winner selection, SodaGift orders, automatic Whisper.
- **✅ Host Operation + QR Display + Winner Draw + Result — IMPLEMENTED (approved
  2026-08-30), migration `20260830031500_winner_and_status` applied, `tsc` + `next build`
  green; draw guarantees verified with a throwaway concurrency test.**
  - **Lifecycle:** `CampaignStatus` migrated `PUBLISHED→OPEN`, `DRAWING` removed
    (data-preserving `USING CASE`); enum is now `DRAFT | OPEN | CLOSED | DRAWN`.
    `isJoinable` ⇔ `OPEN`; `joinGiveaway` rejects when not `OPEN`.
  - **`Winner` model** (§3): `@unique(participantId)`, `@@unique([campaignId, participantId])`,
    `@@unique([campaignId, drawSequence])`. No `twitchUserId` column — identity via relation.
  - **`drawWinners(campaignId)`** (`src/lib/campaign/queries.ts`): one `prisma.$transaction`
    at **`Serializable`** isolation — `SELECT … FOR UPDATE` the campaign row → check status →
    read Participants → `selectWinners()` (CSPRNG `node:crypto.randomInt`, **never
    `Math.random`**, partial Fisher–Yates) → `winner.createMany` → conditional
    `updateMany({where:{status:'CLOSED'}}, status:'DRAWN', drawnAt)`. Verified: 8 concurrent
    draws → **1 distinct winner set**; already-`DRAWN` → returns the persisted winners;
    `participantCount < winnerCount` → `DrawError("Not enough participants to draw N …")`,
    no silent partial draw; duplicate `Winner` insert → DB `P2002`.
  - `closeEntries` / `reopenEntries` — conditional `updateMany`; `reopen` only from
    `CLOSED`, **never from `DRAWN`**.
  - **Pages:** `/c/[publicId]/display` (public, no auth; big QR from the unchanged
    `/api/c/[publicId]/qr.png`, title, "Scan to join", live count, status; 10-s
    `<meta refresh>`; full-bleed nested layout for OBS). `/c/[publicId]/result` (public;
    "Waiting for results" pre-draw; `Winner #k` / **masked** Twitch id (`maskTwitchId`) /
    country post-draw; exposes no URLs/tokens/secrets). `/host/campaigns/[id]` (**dev-only**,
    `notFound()` in prod; title/status/counts/country breakdown/`winnerCount`/public URL/
    display URL/result URL; `Close Entries` / `Reopen Entries` / `Draw Winners` buttons by
    state; winners after draw; **no Twitch-ID input**).
  - Modified: `queries.ts` (+ `getCampaignById`, `closeEntries`, `reopenEntries`,
    `drawWinners`, `getWinners`, `DrawError`; `isJoinable`/`createCampaign` → `OPEN`),
    `c/[publicId]/{page,actions}.ts` (statuses), `dev/campaigns/{page,actions}.ts` +
    `scripts/seed-campaign.ts` (`OPEN`; list links to `/host/campaigns/[id]`). New:
    `src/lib/campaign/draw.ts`, `src/lib/format.ts`.
  - **NOT touched:** participant OIDC, `sl_proof`/`sl_campaign`/`proof-session`, Host OAuth
    routes/lib + `/dev/host` (kept as the isolated probe), catalog helpers, `qr.png` route.
  - **NOT done (next = fulfillment):** SodaGift order creation, reward sending, automatic
    Whisper, `ClaimToken`.
- **Preserved future chain (fulfillment milestone):** persisted `Winner` → `Winner.participant`
  → `participant.twitchUserId` **from the DB** + `participant.countryCode` → eligible SodaGift
  `LINK` product → `POST /v1/orders` → store reward URL encrypted → Host OAuth
  (`user:manage:whispers`) → **automatic** Twitch Whisper to `participant.twitchUserId`.
  **Never** manual recipient Twitch-ID entry in production. `Campaign.claimLinkMode` (A vs B)
  is decided then.

- **✅ Fulfillment + Claim + Whisper — IMPLEMENTED (approved 2026-08-29), migration
  `20260831010000_reward_fulfillment` applied, `tsc` + `next build` green.** No production
  dependency on SodaGift product **#99001** or any hardcoded / host-entered product id — that
  id survives only in `scripts/sodagift-probe*.ts` as a Sandbox contract probe.
  - **New models:** `ClaimToken` (one-time, hashed at rest, TTL `CLAIM_TOKEN_TTL_HOURS`),
    `Reward` (country-resolved product + SodaGift order + encrypted voucher URL),
    `WhisperAttempt`. Back-relations on `Winner`; `Campaign.rewards`.
  - **`notifyWinners(campaignId)`** (`src/lib/campaign/fulfillment.ts`) runs after the draw
    commits (best-effort, inside `drawWinnersAction`) and from a **Send / Retry Whispers**
    button on `/host/campaigns/[id]`: ensures a `Reward` per winner, mints/rotates a
    `ClaimToken` for each not-yet-`SENT` winner, and `POST /helix/whispers` a message
    carrying `${APP_URL}/claim/<rawToken>` — `from_user_id` = validated Host OAuth identity
    (`sl_host`, via `/dev/host`), `to_user_id` = `Winner.participant.twitchUserId` **from the
    DB**. Records a `WhisperAttempt`. No host connected → rewards still created, 0 whispers,
    host told to connect.
  - **`/claim/[token]`** (public route): loads the `ClaimToken` by hash → not signed in →
    "Verify with Twitch" (stashes the token in the encrypted `sl_claim` cookie, runs the
    **unchanged** participant OIDC flow; `/auth/result` routes back to `/claim/<token>` when
    `sl_claim` is set). Signed in → **constant-time** `session.sub == Winner.participant.
    twitchUserId` (mismatch → `failedAttempts++`, refused). Verified winner picks a product
    from **their own country's** filtered catalog (`resolveOrderContract` marks which items
    are auto-orderable). `claimReward` re-verifies everything, re-fetches the live catalog,
    re-validates the choice for `Reward.countryCode`, freezes `externalReferenceId`, guards
    concurrency (`updateMany … status IN (AWAITING_SELECTION, ORDER_FAILED, UNAVAILABLE)` →
    `ORDER_CREATING`), `POST /v1/orders` (LINK), `GET /v1/orders/{id}` →
    `order_items[0].delivery.link` → `encryptSecret` → `Reward.rewardUrlEnc`,
    `ClaimToken.consumedAt = now`. Already fulfilled → reveals the decrypted URL to the
    verified winner only. Host page never shows the claim URL or voucher URL.
  - **`resolveOrderContract`** (`src/lib/sodagift/order-contract.ts`): FIXED product (has
    `amount`) → `custom_amount` omitted (verified #99001). RANGE product (has
    `min_amount`/`max_amount`) → `custom_amount` **required**, sent only when the campaign
    policy value is in the **same currency** as the product and lands in range; otherwise
    `{ orderable:false }` → `Reward.status = UNAVAILABLE` (no fabricated order). Type filter
    honoured. This is the "generic SodaGift ordering contract" rule layer — see §11 for what
    is still UNKNOWN (decimal scale on `custom_amount`, cross-currency, non-`GIFT_CARD`
    ordering, LINK URL expiry/reuse).
  - **New:** `src/lib/crypto/secretbox.ts`, `src/lib/sodagift/order.ts`,
    `src/lib/sodagift/order-contract.ts`, `src/lib/campaign/{claim,claim-context,fulfillment}.ts`,
    `src/app/claim/[token]/{page,actions}.ts`. **Modified:** `schema.prisma`, `env.ts`
    (`TOKEN_ENCRYPTION_KEY`, `sodagiftSenderName()`, `claimTokenTtlHours()`),
    `sodagift/{client,schemas}.ts`, `campaign/queries.ts` (`getFulfillmentView`),
    `auth/result/page.tsx`, `host/campaigns/[id]/{page,actions}.ts`.
  - **NOT touched:** participant OIDC routes/lib, `sl_proof`/`sl_campaign`, the draw
    transaction (`drawWinners`), `qr.png`, the isolated `/dev/host` whisper proof (now also
    the Host token source for `notifyWinners`).
  - **Still deferred:** order-status poll reconciliation (`ORDER_CREATED → FULFILLED` after
    the item settles), the session-identity claim path on `/c/[publicId]` (fallback), the
    `SODAGIFT_DIRECT` claim-link mode, recipient-PII delivery methods, `WhisperAttempt`
    retry/backoff scheduling.

---

## 17. Proof: Twitch Participant OIDC authentication (spec — IMPLEMENTED & VERIFIED)

Smallest local proof: user clicks **Continue with Twitch**, authenticates via Twitch
OpenID Connect Authorization Code Flow, and the backend obtains the verified Twitch user id
(`sub`). No DB, no campaign, no QR, no draw, no Host OAuth, no Whisper, no SodaGift.

### Twitch Developer Console (one-time)

- https://dev.twitch.tv/console/apps → the **same app** planned for the MVP (register if
  absent). Name must be globally unique (e.g. `SodaGift Live`).
- **Client Type: Confidential** (yields a Client Secret — required for the server-side code
  exchange).
- **OAuth Redirect URLs:** add exactly `http://localhost:3000/api/auth/twitch/callback`
  (Twitch permits `http://localhost`; exact match, no trailing slash). Prod URL added later.
- Category: *Website Integration*.
- Copy **Client ID**; generate a **Client Secret** ("New Secret", shown once).
- No separate OIDC setup — requesting `scope=openid` on the same app returns an `id_token`.
  The login account needs nothing special (phone verification is only for host/whispers).

### Redirect URI (local)

`http://localhost:3000/api/auth/twitch/callback` — identical in the Twitch console, the
authorize request, and the token exchange.

### Environment variables (`.env.local`, server-only; never `NEXT_PUBLIC_`)

```
APP_URL=http://localhost:3000
TWITCH_CLIENT_ID=<console>
TWITCH_CLIENT_SECRET=<console>
TWITCH_REDIRECT_URI=http://localhost:3000/api/auth/twitch/callback
TWITCH_OIDC_ISSUER=https://id.twitch.tv/oauth2
TWITCH_AUTHORIZE_URL=https://id.twitch.tv/oauth2/authorize
TWITCH_TOKEN_URL=https://id.twitch.tv/oauth2/token
TWITCH_JWKS_URI=https://id.twitch.tv/oauth2/keys
AUTH_STATE_SECRET=<base64 of 32 random bytes>   # JWE key for the state/nonce + proof cookies
```

### Files / routes

```
src/app/page.tsx                          # <a href="/api/auth/twitch/login">Continue with Twitch</a>
src/app/auth/result/page.tsx              # server component: reads sl_proof cookie, renders sub
src/app/auth/error/page.tsx              # friendly failure page
src/app/api/auth/twitch/login/route.ts    # GET: make state+nonce(+PKCE), set sl_oidc cookie, 302 → Twitch
src/app/api/auth/twitch/callback/route.ts # GET: validate state, exchange code, verify id_token, set sl_proof, 302
src/lib/env.ts                            # zod-parsed server env
src/lib/auth/cookies.ts                   # sealCookie/openCookie via jose EncryptJWT (dir, A256GCM)
src/lib/twitch/oidc.ts                    # buildAuthorizeUrl(), exchangeCode(), verifyIdToken() (jose jwtVerify + JWKS)
```
Plus `package.json`, `tsconfig.json`, `next.config.ts`. Deps: `next`, `react`, `react-dom`,
`typescript`, `jose`, `zod`.

### Flow

1. `/` renders one link → `GET /api/auth/twitch/login`.
2. login route: `state = base64url(randomBytes(32))`, `nonce = base64url(randomBytes(32))`,
   `pkceVerifier`/`challenge` (S256, bonus — matches §6). Seal `{state,nonce,pkceVerifier}`
   into `sl_oidc` (JWE, `AUTH_STATE_SECRET`; `HttpOnly`, `SameSite=Lax`,
   `Secure = APP_URL startsWith https`, `Path=/api/auth/twitch`, `Max-Age=600`). 302 to
   `TWITCH_AUTHORIZE_URL?client_id&redirect_uri&response_type=code&scope=openid&state&nonce&code_challenge&code_challenge_method=S256&force_verify=true`.
3. User approves the `openid` scope on Twitch.
4. Twitch → `GET /api/auth/twitch/callback?code&state&scope` (or `?error=access_denied…`).
5. callback:
   a. `error` param present → `/auth/error`, clear `sl_oidc`.
   b. Read + decrypt `sl_oidc`; missing/expired → `/auth/error` ("session expired").
   c. **Constant-time** compare `query.state === state`; mismatch → `/auth/error`. Delete
      `sl_oidc` (single-use).
   d. **Exchange server-side:** `POST TWITCH_TOKEN_URL` (form) `client_id`, `client_secret`,
      `code`, `grant_type=authorization_code`, `redirect_uri`, `code_verifier`. Non-200 →
      `/auth/error`. Keep only `id_token`; discard access/refresh (participant needs no API).
   e. **Verify `id_token`** with `jose`:
      `jwtVerify(idToken, createRemoteJWKSet(TWITCH_JWKS_URI), { issuer: TWITCH_OIDC_ISSUER,
      audience: TWITCH_CLIENT_ID, algorithms: ["RS256"], clockTolerance: 5 })` — checks
      **signature, iss, aud, exp/nbf/iat**, rejects `alg:none`. Then **constant-time**
      `payload.nonce === nonce`.
   f. `twitchUserId = payload.sub` (authoritative). Display name / `preferred_username` is
      **never** read as an identifier.
   g. Seal `{ sub: twitchUserId }` into `sl_proof` (JWE, `Path=/`, `HttpOnly`, `Max-Age=300`).
      302 → `/auth/result`.
6. `/auth/result` reads + decrypts `sl_proof` and renders:
   `Twitch authentication successful` / `Twitch User ID:` / `<verified sub>`. Missing cookie
   → link back to `/`.

Failure handling: state missing/mismatch, Twitch `error`, token-exchange non-200, id_token
signature/iss/aud/exp failure, nonce mismatch, JWKS fetch failure → all fail closed to
`/auth/error`. `TWITCH_CLIENT_SECRET` is used only in step 5d, server-side.

**Explicitly NOT in this proof:** **country selection / `countryCode`** (§3A — full MVP
only), Participant DB row, `UNIQUE(campaignId, twitchUserId)`, campaigns, SodaGift catalog,
QR, winner draw, Host OAuth, Whisper, SodaGift, any extra OIDC claims/email, long-lived
sessions.
