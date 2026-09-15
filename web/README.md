# Lipi AI

A digital-twin conversational-commerce platform: customers, products,
inventory, orders and conversations are each modelled as a persistent
"twin" in Postgres, kept in sync by one transactional ingest loop that
every inbound channel message runs through.

Next.js 16 (App Router) · React 19 · Prisma 7 (`@prisma/adapter-pg`) ·
PostgreSQL. Money is stored as integer paise, never floats.

## What's implemented

**Core platform** (pre-existing, audited and fixed this engagement):
- Multi-tenant workspaces, opaque server-side sessions, AES-256-GCM secrets
  at rest, HMAC-SHA256 timing-safe webhook signature verification.
- Digital twins: Customer, Product/Variant, Order, Conversation, append-only
  `TwinEvent` trail. Every ingest mutation runs inside one `$transaction`.
- Channels: Telegram and WhatsApp adapters with real webhook verification
  and send/test round-trips. Instagram and email are onboarding-only intent
  (no adapter yet).
- Inventory connectors: authenticated push sync (Shopify/WooCommerce/
  Zoho/ERP/POS/custom), idempotent batches, an exception queue for rows
  that can't be applied, and a cursor/watermark that only advances on a
  successful or partial batch.
- Catalogue: manual product entry and CSV import, both variant-native
  (two configurable axes per product, e.g. Size × Colour or Fitment × Grade).
- Dashboard: inbox, orders, invoices/ageing, approvals queue, twin event
  log, storefront preview, twin voice/knowledge/example training, overview
  KPIs.

**Audit fixes** (see `Lipi_AI_Code_Audit.pdf` for the original findings):

| Finding | Status | Summary |
|---|---|---|
| C-1 | Fixed | `purchase_order` intent no longer dead-ends; creates an order with a `mandatory: true` approval override regardless of workspace policy. |
| C-2 | Fixed | Order `Delivered`/`Returned` transitions now settle the inventory twin's reservation. |
| C-3 | Mitigated | Intent-classification prompt now gives contrastive buy/PO examples; C-1 provides defense-in-depth for any remaining misclassification. |
| H-1 | Fixed | Inventory sync cursor only advances on `applied`/`partial`, never `failed`. |
| H-2 | Fixed | Quantity extraction no longer confuses calendar/fitment years with requested quantities. |
| H-3 | Fixed | Meta webhook signature now verified against a dedicated, separately-stored App Secret; inbound messages are deduplicated via an atomic per-message unique-constraint claim. |
| M-1 | Fixed | Module-boundary test normalizes Windows path separators before matching. |
| M-2 | N/A | No `.env` was shipped in the distributed archive — nothing to remediate. |
| L-1(a) | Fixed | `npm run typecheck` works from a clean checkout (`pretypecheck: next typegen`), no full build required first. |
| L-1(b) | Fixed | Dead condition in the customer-twin update no longer suppresses `customer_twin.updated` events. |
| L-1(c) | Documented, not fixed | `matchVariant()`'s full-table scan per inbound message is flagged with a code comment; restructuring it changes matching behaviour, so it's deliberately left for a dedicated review. |
| L-1(d) | Fixed | Variant SKUs are generated once at creation and stored (`Variant.sku`), not rebuilt from the product's current name on every read. |
| L-1(e) | Fixed | The 3 pre-existing unused-variable lint warnings are removed; lint is 0 errors / 0 warnings. |

**Implemented this session** (Req 1, 2, 3 + hardening):
- **Req 1 — Webchat channel**: `src/server/services/webchat.ts` +
  `src/app/v1/webchat/[workspaceId]/{session,message,updates}/route.ts` +
  `public/static/widget.js`. Webchat is a *direct-call* channel (no
  provider webhook): the widget calls the API directly and gets the reply
  inline, or polls `/updates` if the workspace's approval policy holds it.
  The Channels page now shows an install snippet (`<script src=".../static/
  widget.js" data-workspace="..." async>`) for webchat instead of a
  credential form — there is no secret to connect.
- **Req 2 — Lead scoring**: `src/server/services/leads.ts`, wired into
  `ingest()`. Recomputed synchronously on every inbound message from
  intent, product-match, quantity and order outcome. `LeadStage` (`visitor
  → engaged → qualified → customer`) is sticky at `customer` once
  `tx.order.count()` shows a real order (not the stale `Customer.orderCount`
  field, which nothing increments).
- **Req 3 — Ad attribution**: `src/server/services/attribution.ts`.
  `widget.js` reads `utm_*`/`gclid`/`fbclid`/`msclkid`/referrer once, on
  first load, and posts it to `/session`. The *first* time a `Customer` is
  created for that visitor, those fields are copied onto the customer row
  once and never overwritten by a later touch.
- **Security hardening (L-1 family)**: `src/server/lib/rate-limit.ts`, a
  per-IP fixed-window limiter, applied to the 3 new public webchat
  endpoints (via `cors.ts`) and to the existing provider webhook endpoint.
  Documented as single-instance-correct only — see the file's own comment
  for the multi-instance caveat.

Verified for this batch: `npm run typecheck` clean, `npx eslint .` clean,
full suite **240/240 passing** (no new tests added yet for the new files —
see "Not yet implemented" below).

## Not yet implemented

1. **Req 4 — AI-assisted conversion actions for ad-sourced visitors**: no
   suggestion-generation job; `GrowthSuggestion` exists but nothing writes
   to it yet.
2. **Req 5 — Conversion/revenue funnel analytics**: no funnel/revenue
   analytics service or dashboard page. `overviewKpis()` (existing) only
   covers conversations/orders/quoted-value/autonomy, not a lead funnel.
3. **Growth dashboard page**: no UI surfaces `leadScore`/`leadStage`,
   attribution, or `GrowthSuggestion` yet — no nav entry either.
4. **Composio.dev-style connector/channel UX overhaul**: only the webchat
   row got a bespoke treatment (install snippet). The rest of
   `ChannelsStep` and the inventory `ConnectorPanel` are unchanged from
   the credential-form pattern; a full visual redesign pass has not begun.
5. **Tests for the new webchat/leads/attribution code**: none written yet.
   The existing 240 tests all still pass (they exercise the paths this
   session's changes run through, e.g. `ingest()`), but there is no direct
   coverage of `scoreLead()`, `firstTouchData()`, `upsertSession()`,
   `sendVisitorMessage()`, or the new routes/rate limiter in isolation.
6. **Playwright E2E tests**: not started; all current coverage is
   Vitest + Supertest against the API layer.
7. **Rate limiting beyond the fixed-window in-memory limiter**: correct for
   this app's single-Node-process deployment model, not for a future
   multi-instance one — see `rate-limit.ts`'s own comment.

See `DEPLOYMENT.md` for how to run and deploy what exists today.

## Data model

Postgres via Prisma 7, one schema (`prisma/schema.prisma`), one workspace
= one tenant. Core twins: `Customer`, `Supplier`, `Product`/`Variant`,
`Order`, `Conversation`/`Message`, `AgentRun`/`Approval`, `TwinEvent`
(append-only), `Invoice`/`Payment`. Channel/inventory integration:
`ChannelConnection`, `ProcessedMessage` (webhook idempotency),
`InventoryConnector`/`InventoryMapping`/`InventorySyncRun`/
`InventoryException`. Auth: `User`/`Membership`/`Session`. Twin
configuration: `TwinVoice`, `KnowledgeEntry`, `VoiceExample`. Growth:
`VisitorSession` (webchat visitor + first-touch attribution, now written by
`webchat.ts`), `GrowthSuggestion` (schema only, nothing writes to it yet),
plus the attribution/lead columns on `Customer` (now written by
`attribution.ts`/`leads.ts` via `ingest()`).

## Environment

Copy `.env.example` to `.env` and fill in:
- `DATABASE_URL` — Postgres connection string (required).
- `APP_SECRET` — ≥16 chars, encrypts channel/connector secrets at rest.
  Rotating it invalidates every stored credential (by design).
- `PUBLIC_URL` — this app's own public origin; webhook URLs handed to
  providers are built from it.
- `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` / `OPENROUTER_CHAT_MODEL` —
  optional; intent extraction falls back to deterministic rules without a
  key, and the operator's own twin-chat feature needs it to answer.

## Local development

```bash
npm install
cp .env.example .env   # then fill in DATABASE_URL and APP_SECRET
npx prisma migrate deploy
npm run dev             # http://localhost:3000
```

Run tests (needs a second Postgres database, e.g. `lipi_test`):

```bash
TEST_DATABASE_URL="postgresql://postgres:postgres@localhost:5432/lipi_test" npm test
```

## Deployment

This is a **stateful Next.js application** (server-rendered pages, Prisma
against Postgres, webhook endpoints that must run on Node). It does **not**
deploy to Cloudflare Pages/Workers. See `DEPLOYMENT.md` for a Node-host
deployment guide (Docker, environment variables, migrations, and a
production checklist).

## Status

- **Audit**: 3 critical, 3 high, 2 medium and 5 of 6 minor findings fixed
  or explicitly mitigated/documented; 1 minor item (L-1c, scan performance)
  deliberately deferred as a behavioural-risk change; M-2 not applicable.
- **Tests**: 240/240 passing (Vitest + Supertest against the API layer).
  `npx eslint .`: 0 errors, 0 warnings. `npm run typecheck` and
  `npm run build` both verified clean from a cold state.
- **New business requirements (Req 1-5) and Composio-style UX overhaul**:
  schema laid, application code not started.
- **Last commit**: `L-1(d,e) + schema groundwork for Req 1-5`.
