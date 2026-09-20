# Lipi Twin Architecture

## Purpose

Lipi is a digital-twin layer for conversational commerce. The Twin is the
business's shared operational state; agents read and act on that state. It is
not a chatbot persona, a collection of chat logs, or a second dashboard data
source.

The system must answer a request such as “I need four blue XL polos by Friday”
from verified state: customer context, the correct product variant, unreserved
stock, delivery constraints, confirmed business rules and approval policy.

## Design principles

- **One source of truth.** The dashboard reads the API, and the API reads
  workspace rows. Metrics are derived from those rows, not frontend fixtures.
- **State before language.** Voice changes how a reply reads; knowledge
  determines what it may claim.
- **Variant-native inventory.** Stock belongs to a sellable variant, not a
  product title. Each vertical supplies the two variant axes.
- **Atomic mutations.** A reservation, order, agent run, approval and event
  commit together, or none commit.
- **Traceability.** Every mutation creates an append-only Twin event.
- **Tenant isolation.** Every business object is scoped to an authenticated
  workspace membership.
- **Honest emptiness.** A new workspace contains no fabricated activity.
  Sample catalogue products are labelled and never create customers, orders,
  invoices, approvals or dashboard metrics.

## Core model

```text
Workspace
├── Business configuration
│   ├── Voice                 how replies sound
│   ├── Knowledge entries     facts the Twin may assert
│   ├── Voice examples        approved phrasing examples
│   ├── Approval policy       what requires a human
│   └── Channel connections   encrypted credentials and webhook state
│
├── Operational twins
│   ├── Customer              profile, history, preferences and risk signals
│   ├── Product               vertical attributes and variants
│   ├── Inventory             stock and reservations per variant
│   ├── Order                 quote → paid → packed → shipped → delivered/returned
│   └── Conversation          messages, extracted intent and signals
│
└── Audit and finance
    ├── Agent run             proposed or completed action
    ├── Approval              human decision point
    ├── Twin event            immutable mutation trail
    ├── Invoice
    └── Payment
```

The objects are linked rather than flattened. A customer can have many orders
and conversations; an order points to a product and selected variant; stock is
reserved at that variant; and all effects appear in the event trail.

## Components

| Component | Responsibility |
| --- | --- |
| Next.js app | One deployable: marketing site, dashboard, and the API. Onboarding, data import, Twin training and human actions. |
| Route handlers (`src/app/v1`) | Auth, workspace isolation, API contracts, channel connections and business actions. A thin edge over `src/server`. |
| PostgreSQL + Prisma | Durable tenant-scoped operational state and append-only Twin events. |
| Ingest service | Extracts intent, resolves entities, applies effects, dispatches agents and composes grounded replies. |
| Channel adapters | Normalize provider payloads into a common inbound message and send approved replies. |
| Analytics service | Derives KPIs, volume, intent mix and low-stock signals from live rows. |
| Inventory connectors | Accept pushed stock batches, map external SKUs to variants, apply corrections idempotently and surface what could not be applied. |

## Data onboarding

The first supported production source is a variant-level catalogue CSV. The
browser validates and previews it; the API validates again, groups variants into
products, rejects inconsistent axes and duplicates, and writes the import in a
single transaction.

```text
product, category, axis_a_name, axis_a_value, axis_b_name, axis_b_value,
price_inr, stock, margin_pct, lead_time_days
```

This creates the initial product and inventory Twin. It is a snapshot: correct
when taken, wrong as soon as anything sells.

Current stock comes from an inventory connector. The source pushes absolute
on-hand counts to `POST /v1/inventory/:id/sync`, authenticated by the
connector's own bearer token rather than a session, because an ERP has no user
to sign in as. Corrections land through the same path and append the same
`inventory_twin.corrected` events as a manual one.

| Requirement | How |
| --- | --- |
| Idempotency | Every batch carries an `idempotencyKey`, unique per connector. A replay returns the original outcome instead of correcting twice. |
| Sync cursor | The source's own position in its change feed, stored verbatim and handed back. It advances only on a batch that was actually processed, so a rejected push is re-sent from the same place. |
| SKU mapping | External SKU to variant, explicit rather than inferred. A wrong guess would correct the stock of the wrong sellable thing. |
| Reconciliation | Per-connector health separates *stale* (not heard from) from *failing* (rows rejected), and reports how many variants no connector covers — those silently keep their import-day figure. |
| Failure state | A row that cannot be applied becomes an operator-visible exception, resolved by mapping the SKU or dismissing it. A connector reporting success while discarding unmapped SKUs is worse than one reporting failure. |

A correction below a variant's reserved units is refused rather than clamped:
those units are already promised to a customer, and accepting the lower figure
would let the twin sell them twice.

## Training and evaluation

Training is configuration and verification, not model fine-tuning:

1. Set reply voice.
2. Teach verified policies, terms, sizing, pricing and warranty facts.
3. Add approved message/reply examples.
4. Run evaluation messages through production ingest logic.
5. Choose the approval policy before autonomous actions.

Evaluation deliberately rolls back after producing its reply, proposed actions
and events. It exercises real constraints without creating a test customer,
reserving stock or changing operational metrics.

## Inbound and action boundary

Every incoming message enters the ingest service. Channel code only
authenticates, parses and normalizes provider payloads; it must not make
business decisions.

The ingest service resolves the workspace and live catalogue vocabulary,
extracts intent, updates the customer Twin, matches a variant, applies allowed
inventory/order effects, creates agent runs and approvals, composes a grounded
reply, and appends events for each effect.

## The public API

`/v1` is one surface with two audiences. The dashboard reads it same-origin with
a session cookie; an external integration reads the same routes with an API key.
There is no second API for outsiders, because a second API is how one of them
ends up missing a check the other has.

What makes it a contract rather than whatever the dashboard happened to need:

- **The shapes are declared, not implied.** `src/app/v1/contract.ts` holds a Zod
  schema for every documented request and response. The projections in
  `shapes.ts` are typed as `z.infer` of those schemas, so a field cannot leave
  the API without being described.
- **The document is generated from them.** `src/app/v1/openapi.ts` turns the same
  schemas into OpenAPI 3.1; `docs/openapi.json` is the checked-in output and
  `test/openapi.test.ts` regenerates it on every run, so a stale document fails
  the suite. It is served at `GET /v1/openapi.json` without a credential.
- **One pagination convention and one error envelope.** Every list takes `limit`
  and `cursor` and answers `{ <noun>s, nextCursor }`; every error at every status
  is `{ error, details? }`, produced in one place by `route()`.
- **Two CORS stories, kept apart.** The anonymous widget answers `*` to anybody —
  `server/lib/cors.ts`, unchanged. A key-authenticated browser call is readable
  only from an origin the resolved workspace listed in `allowedOrigins` —
  `server/lib/origins.ts`. Neither loosens the other.

Integration notes live in `docs/api.md`, `docs/integrations/react.md` and
`docs/integrations/wordpress.md`.

## Channel delivery status

| Channel | Current capability | Production requirement |
| --- | --- | --- |
| WhatsApp Cloud API | Credential verification, outbound text, payload parsing and webhook endpoint exist. | Public HTTPS endpoint, Meta webhook setup, and signature validation using the Meta app secret—not the operator verify token. |
| Telegram | Credential verification, automatic webhook registration, inbound and outbound text exist. | Public HTTPS URL and webhook health monitoring. |
| Email | Not implemented. | Mailbox adapter, inbound authentication and outbound delivery integration. |
| Webchat | Not implemented. | Hosted widget, authenticated session model and message transport. |
| Instagram | Not implemented. | Meta messaging adapter and review-compliant webhook setup. |

Only a real connection with `connected` status may appear as connected in the
dashboard.

## Security and reliability

- Opaque server-side sessions and workspace membership checks protect tenancy.
- Server-to-server callers present `Authorization: Bearer <key>` instead of a
  session. Both credentials resolve through the same `resolveWorkspaceId()`, so a
  key gains no route a session lacks and skips no check a session makes: it names
  exactly one workspace, carries a read or read+write scope, is stored only as a
  hash, and is throttled per key rather than per address. A request carrying both
  a cookie and a key is refused rather than resolved by precedence.
- Channel secrets are encrypted at rest and never returned to the browser.
- Provider webhooks authenticate independently because they lack user sessions.
- Approval policy gates replies/actions that affect money.
- Money is stored as integer paise.
- Each Twin mutation creates an append-only event for inspection and replay.
- List endpoints are keyset-paginated. The cursor carries the sort key rather
  than a row id, so it can only narrow a query already scoped to the workspace
  and cannot be used to shift another tenant's window or hide a row.
- Cross-origin reads of key-authenticated responses are denied by default. An
  origin is allowed per workspace, never globally, and credentials are never
  allowed with it, so no third-party page can ride an operator's cookie.
- Events posted from outside are namespaced under `external.`, so nothing a
  caller writes can pose as something the ingest path observed.

## Near-term priorities

1. Complete WhatsApp app-secret handling and production webhook deployment.
   Signature verification currently uses the operator verify token, so a real
   Meta webhook cannot authenticate.
2. Add customer, order and invoice import connectors with provenance metadata.
3. Add idempotent provider-message handling using external message IDs. The
   channel adapters already parse them; the webhook route discards them, so a
   provider retry runs the ingest loop twice.
4. Add saved evaluation suites with expected outcomes and release gates.
5. Release reserved stock on order completion, cancellation and rejection.
   `reserved` currently only ever increments.

Done: inventory connectors with idempotency, cursors, reconciliation and an
operator-visible exception queue.
