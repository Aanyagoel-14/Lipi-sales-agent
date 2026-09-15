# Lipi AI

Digital twin platform for conversational commerce. One Next.js application:
the marketing site, the dashboard, and the API are a single deployable.

```
web/src/app/          marketing site + dashboard (App Router, Tailwind 4)
web/src/app/v1/       the API: one route handler per endpoint
web/src/app/webhooks/ channel callbacks, authenticated by provider signature
web/src/server/       twins, agents, channel adapters, Prisma — server-only
```

The dashboard reads only from the API. There is no mock fallback or second
data source to drift from.

Route handlers under `src/app/v1` are a thin edge: they validate the request,
resolve the tenant, and call into `src/server`. Nothing in `src/server` knows
it is being served over HTTP, which is what keeps the twins testable and the
transport replaceable.

## Accounts and tenancy

Email and password, hashed with scrypt from `node:crypto`. Sessions are opaque
server-side rows and the cookie carries a random id, never a claim, so
revoking one is a row delete.

Every twin belongs to a workspace. The tenant is resolved from the session and
membership is checked on every request: an `x-workspace-id` header may *choose*
between workspaces you belong to, but it cannot grant access to one you do not.
Unauthenticated reads are 401, cross-tenant reads are 403.

The seed creates a demo account:

```
demo@lipi.test / lipidemo123
```

## Verticals

The vertical chosen at onboarding decides what a product *is*. Products carry
their own two axes and a JSON attribute bag, so apparel sells on Size x Colour,
auto parts on Fitment x Grade, marine on Configuration x Condition and
wholesale on Pack size x Grade. `web/src/server/services/catalogues.ts` holds one
catalogue and vocabulary per vertical; adding a vertical needs no migration.

The extractor is given the workspace's own vocabulary, so an apparel twin
resolves "blue" to Cobalt while a parts twin resolves "genuine" to OEM and
"swift" to a fitment.

## Training the twin

`/dashboard/train` has three parts:

- **Voice** governs how replies read: formality, length, greeting, sign-off,
  emoji, and banned phrases. Changing it changes the next reply immediately.
- **Knowledge** governs what the twin may assert. Agents answer from these
  entries; anything not taught, they will not claim.
- **Test** sends a real message through the real loop against real stock, so
  you find out what the twin does before a customer does.

Voice and knowledge are deliberately separate. An assistant that sounds
perfect while asserting a returns policy you do not have is worse than a blunt
one that is correct.

The workspace approval policy gates agents for real: `everything` holds the
reply and every run, `money_only` holds quotes and purchase orders while stock
checks go out, `nothing` lets agents reply unattended.

## Run

```bash
createdb lipi_dev
cd web
cp .env.example .env                   # then check DATABASE_URL and APP_SECRET
npm install                            # postinstall runs prisma generate
npx prisma migrate deploy              # create the tables
npm run db:seed                        # load the demo dataset
npm run dev                            # http://localhost:3000
```

One process serves the site, the dashboard and the API.

## Database

Postgres via Prisma 7. The schema models the twins: customers, products and
their variants, suppliers, orders, conversations and messages, agent runs,
approvals, the append-only twin event log, and invoices with payments.

Money is stored in paise (integer minor units) and converted to whole rupees at
the API boundary, so reconciliation arithmetic never rounds.

| Command                    | Does                                        |
| -------------------------- | ------------------------------------------- |
| `npm run db:migrate`       | Create and apply a migration                |
| `npm run db:seed`          | Reload the demo dataset                     |
| `npm run db:studio`        | Browse the data                             |

## Tests

```bash
cd web && npm test    # 222 tests: unit and integration against Postgres
```

The suite calls route handlers directly through `test/dispatch.ts`, a small
supertest-shaped client that opens the request context Next would normally
provide. No server is started, so the tests stay fast, and the handlers under
test are the same functions the build ships.

The suite runs against its own database, `lipi_test`, created once with
`createdb lipi_test`. Migrations are applied at the start of the run and the
setup file refuses to run against anything not named `lipi_test`, so a stray
`DATABASE_URL` cannot wipe development data.

What it covers, chosen because these are the things that have actually broken:

- **Extraction** per vertical, including the alias that resolves to the other
  axis, and the quote intent that only matched "best price".
- **The ingest loop**: reservations, refusing to promise stock that is not
  there, asking which variant instead of guessing one, policy gating, voice,
  and the event trail.
- **Auth and tenancy**: unauthenticated 401, cross-tenant 403, stale workspace
  ids falling back rather than locking a user out, logout revoking.
- **Webhooks**: forged Meta signatures and wrong Telegram secrets rejected.
- **Billing**: owed and ageing derived from payments, buckets summing to the
  total.
- **Module boundaries** in `web`: a client component importing anything that
  reaches for `next/headers` fails the build. That leak has happened twice and
  only shows up as a blank page at runtime. Row shapes and formatters live in
  `lib/dash-types` so client components can share them without importing
  `lib/dash`, which forwards the session and is therefore server-only.
- **Pagination**: a page is capped, the walk covers every row exactly once, a
  malformed cursor is refused, and a cursor naming another tenant's row can
  neither leak a row nor drop one of your own.
- **Inventory connectors**: replays apply once, the cursor does not advance on
  a rejected batch, a count below reserved units is refused rather than
  clamped, unmapped SKUs queue as exceptions, and resolving one SKU clears
  every repeat of it.

## Deploying

One deployable. Give it `DATABASE_URL`, `APP_SECRET` and `PUBLIC_URL`, and run
`npx prisma migrate deploy` on release.

`PUBLIC_URL` must be the app's real public origin: provider webhook URLs and
connector push URLs are built from it, and server components resolve their own
API calls against it.

`DATABASE_URL` and `APP_SECRET` are read at module scope, so they have to be
present when the app is *built*, not only when it runs — a build without them
fails while collecting page data rather than at the first request. Set them for
every environment the host builds, previews included.

On a serverless host, two more things need attention. Point `DATABASE_URL` at a
pooled connection (Neon or Supabase's pooler) — every cold function opens its
own. And check the function timeout against the model-backed routes:
`/v1/twin/chat` and the ingest loop call OpenRouter, which can outlast a 10s
limit.

## API

| Method | Route                  | Purpose                      |
| ------ | ---------------------- | ---------------------------- |
| GET    | `/v1/health`           | Liveness                     |
| POST   | `/v1/waitlist`         | Landing page CTA             |
| GET    | `/v1/dashboard/overview` | KPIs, charts, alerts       |
| GET    | `/v1/conversations`    | Thread list: preview and count, paged |
| GET    | `/v1/conversations/:id` | One thread with its messages |
| GET    | `/v1/customers`        | Customer twins               |
| GET    | `/v1/products`         | Product twins and suppliers  |
| GET    | `/v1/orders`           | Orders with joins            |
| GET    | `/v1/approvals`        | Agent actions awaiting a human |
| GET    | `/v1/events`           | Twin event log               |
| GET    | `/v1/agents/runs`      | Agent run history            |
| GET    | `/v1/invoices`         | Invoices, payments, ageing   |
| POST   | `/v1/messages`         | Inbound message, runs the ingest loop |
| POST   | `/v1/workspaces`       | Onboarding: creates and provisions a tenant |
| GET    | `/v1/workspaces/current` | Current workspace, voice and counts |
| PUT    | `/v1/twin/voice`       | Update the twin voice        |
| GET    | `/v1/twin/knowledge`   | Knowledge entries and voice examples |
| POST   | `/v1/twin/knowledge`   | Teach the twin a fact        |
| DELETE | `/v1/twin/knowledge/:id` | Remove a fact              |
| POST   | `/v1/twin/examples`    | Add a voice example          |
| DELETE | `/v1/twin/examples/:id` | Remove a voice example      |
| GET    | `/v1/inventory/connectors` | Connector health, coverage and staleness |
| POST   | `/v1/inventory/connectors` | Create one; returns the token once |
| POST   | `/v1/inventory/connectors/:id/rotate` | Issue a new token |
| GET    | `/v1/inventory/connectors/:id/mappings` | External SKU to variant |
| POST   | `/v1/inventory/connectors/:id/mappings` | Map a SKU        |
| GET    | `/v1/inventory/connectors/:id/runs` | Sync history        |
| GET    | `/v1/inventory/exceptions` | Rows a connector could not apply |
| POST   | `/v1/inventory/exceptions/:id/resolve` | Map the SKU, or dismiss it |
| POST   | `/v1/inventory/:id/sync`   | Where the source pushes stock (token auth) |

`/v1/events`, `/v1/orders` and `/v1/conversations` are keyset-paginated:
`?limit=` (default 50, max 200) and `?cursor=`, with `nextCursor` in the
response and `null` on the last page. The dashboard server-renders the first
page and appends the rest, so a table that grows forever is never fetched
whole.

## The ingest loop

`POST /v1/messages` is the single entry point for anything a customer sends.
Channel webhooks normalise into its shape, so adding a channel never touches
the twins or the agents.

```
normalise -> extract intent -> resolve the customer twin -> match a product
variant -> apply effects to inventory and orders -> append an event per
mutation -> dispatch agents -> ground a reply in twin state
```

It runs in one transaction: a reservation without its order, or an order
without its event, would leave the twins lying about the business.

Intent extraction has two implementations behind one interface. OpenRouter is
used when `OPENROUTER_API_KEY` is set; otherwise a deterministic rule
extractor runs, so the loop works with no key, no network and no tokens. A
model call that fails or returns an invalid shape falls back to rules rather
than breaking ingestion.

Replies are grounded rather than generated. Ask for four XL cobalt polos when
all four are reserved and you get a lead time, not a promise.

```bash
curl -X POST localhost:3000/v1/messages -H 'Content-Type: application/json' \
  -d '{"channel":"whatsapp","handle":"+91 90 000 1234","text":"need 3 olive L polos"}'
```

## Keeping stock current

A catalogue CSV is a snapshot. An inventory connector is what keeps the number
the twin quotes from going stale — see `ARCHITECTURE.md` for the contract. The
source pushes absolute counts; it is not polled:

```bash
curl -X POST localhost:3000/v1/inventory/$CONNECTOR_ID/sync \
  -H "Authorization: Bearer $CONNECTOR_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"idempotencyKey":"nightly-2026-09-05","cursor":"seq=418",
       "rows":[{"sku":"POS-778","stock":41}]}'
```

Absolute counts rather than deltas, because a re-sent absolute value corrects
itself and a re-sent delta doubles. Retrying the same `idempotencyKey` returns
the first outcome instead of applying it again. A SKU with no mapping, a count
below what is already reserved, or a SKU sent twice in one batch becomes an
exception on `/dashboard/inventory/connectors` rather than a silent drop.

## Onboarding

`/onboarding` is a seven-step setup wizard: workspace, vertical, real catalogue
data, channels, voice, knowledge and approval policy.

It provisions the workspace and a default voice, then lets the operator import
a validated variant-level catalogue CSV, load clearly labelled sample products,
or continue with no data. It never fabricates customers, orders, conversations,
invoices or dashboard activity. Knowledge also starts empty because policies
must be confirmed by the business, not guessed. A no-data signup opens an
explicit setup screen instead of mock metrics.

Invoice state is derived on read: `owed` from the payments recorded against an
invoice, ageing buckets from the invoices. Neither is stored, so the totals
cannot drift from the rows they summarise.
