# REPO_MAP

What this repository actually is, as of 2026-09-21, before any PRD work.
Written from reading the code, not from the existing documentation — where the
two disagree, the disagreement is noted.

`ARCHITECTURE.md` at the repo root is the codebase's own design document and
is accurate. This file is the delta view the PRD effort needs: what exists,
how good it is, and what the PRD asks for that is not here.

---

## 1. Shape

One deployable. A Next.js 16 App Router application in `web/` that serves the
marketing site, the operator dashboard **and** the `/v1` HTTP API from the same
process. Postgres via Prisma 7. No separate backend, no worker process, no
queue — deferred work runs in Next's `after()`.

```
repo root
├── package.json          forwards lint / typecheck / test into web/
├── .sandcastle/          an agent-orchestration harness, not part of the product
├── ARCHITECTURE.md       the codebase's own design doc (accurate)
├── docs/
│   ├── PRD.md            the target (v6.0 Master)
│   ├── adr/ agents/ integrations/ runbooks/
│   └── impl/             this effort's durable state
└── web/
    ├── prisma/schema.prisma   1215 lines, 33 models, 17 enums, 17 migrations
    ├── src/app/               routes: marketing, /login /signup /onboarding,
    │   │                      /dashboard/*, /v1/* (the API), /webhooks/*
    │   ├── v1/                ~70 route handlers + contract.ts + openapi.ts
    │   └── webhooks/          provider callbacks: meta, telegram, x, shopify, composio
    ├── src/server/            the real logic — nothing here imports from app/
    │   ├── services/          ingest, selling, extract, briefing, recommend, …
    │   ├── channels/          registry, inbound, outbound, connect
    │   └── lib/               prisma, http, session, api-key, crypto, metering, …
    ├── src/components/        ui / dash / site / auth
    ├── public/static/widget.js  the embeddable chat widget (444 lines, no deps)
    └── test/                  37 files, 824 tests, against a real Postgres
```

**Module boundary is enforced by a test**, not by convention:
`test/module-boundaries.test.ts`.

## 2. The core loop, and the invariant that makes it trustworthy

The product's centre is a two-stage split that the whole safety story rests on:

| Stage | File | Decides |
| --- | --- | --- |
| `ingest()` | `web/src/server/services/ingest.ts:83` | what is **TRUE** — matches the product, checks stock, reserves it, prices it, creates the order, writes every event |
| `sell()` | `web/src/server/services/selling.ts:301` | what is **SAID** — hands those facts to a model and asks it only for words |

`ingest()` runs entirely inside one `prisma.$transaction`, so a message mutates
every twin it should or none of them. The model never computes a price, total,
stock figure or discount; `sell()` checks the model's output and falls back to
the deterministic composed reply when it invents an offer, uses a banned
phrase, or asks permission for a sale it has already made
(`selling.ts:263`, `selling.ts:417`).

This is a genuinely good design and the PRD does not contradict it. **Every
PRD feature that produces a number must be built on the `ingest()` side, not
the `sell()` side.**

### Supporting services (`web/src/server/services/`)

| File | What it is |
| --- | --- |
| `extract.ts` | intent + entity extraction. Two implementations behind one interface: deterministic rules (always available) and OpenRouter (when keyed), validated against a Zod schema and falling back on any mismatch. Contact details are pattern-matched on **both** paths, never by the model. |
| `briefing.ts` | the grounding block: catalogue, policy and recommendations, ranked and budgeted to 8000 chars. This is the repo's RAG — **keyword ranking, not embeddings**. |
| `recommend.ts` | deterministic alternative / cross-sell / upsell candidates from stock and this workspace's own order history. |
| `voice.ts` | brand voice: formality, length, banned phrases, and the composer used when the model is absent. **Not audio** — nothing in this repo touches sound. |
| `leads.ts` / `contacts.ts` / `attribution.ts` | lead scoring, progressive contact capture, first-touch attribution. |
| `invoicing.ts` | invoice numbering and PDF rendering (pdfkit). |
| `inventory.ts` / `shopify.ts` | push connectors and the one pull connector, both settling through `applySync()`. |
| `webhooks.ts` | outbound webhooks: the `TwinEvent` log delivered to a customer's own server, signed, with backoff and an at-least-once queue. |
| `metering.ts` (lib) | per-workspace and per-customer model budgets, counted in Postgres. |

## 3. Data model

33 Prisma models. The ones the PRD cares about:

- **Twins today:** `Customer`, `Product` + `Variant` (variant-native stock,
  two axes per vertical), `Order`, `Supplier`, `Conversation` + `Message`.
- **Config:** `Workspace`, `TwinVoice`, `KnowledgeEntry`, `VoiceExample`,
  `ChannelConnection`.
- **Audit:** `TwinEvent` (append-only), `AgentRun`, `Approval`.
- **Money:** `Invoice`, `Payment`. Integer paise throughout.
- **Platform:** `User`, `Membership`, `Session`, `ApiKey`,
  `WebhookSubscription`/`WebhookDelivery`, `ModelCall`, `VisitorSession`.

`Order.stage` is `Quoted → Paid → Packed → Shipped → Delivered`, plus
`Returned` reachable from anywhere; the transition route enforces
one-step-forward and settles stock on `Delivered`/`Returned`
(`web/src/app/v1/orders/[id]/stage/route.ts`).

**There is no `Agent` model and no `Skill` model.** `AgentRun.agent` is a free
string (`"Sales"`, `"Inventory"`, `"Procurement"`, `"Support"`) written by the
if/else chain inside `ingest()`. A workspace has exactly one implicit agent,
and nothing in the product creates, configures or deploys an individual one.

## 4. Channels

A declarative registry (`web/src/server/channels/registry.ts:932`,
`channelSpecs`) of plain data plus pure `parse`/`send` functions, one inbound
funnel (`channels/inbound.ts:67` `receive()`), one outbound funnel
(`channels/outbound.ts:281` `sendReply()`), and all provider network I/O behind
a single Composio wrapper (`server/lib/composio.ts`). Every channel normalises
to `InboundMessage` (`registry.ts:28`).

**This registry is the pattern the PRD's skill system should copy.** It is
already exactly the "plugin registry, not a switch statement" shape.

| Channel | State |
| --- | --- |
| WhatsApp, Telegram, Instagram, Messenger | real end to end: signature verification, per-connection idempotency on the provider's message id, retry classification, credential-death detection |
| X (Twitter DM) | complete code path, tested against a fake; toolkit version and tool slugs were never checked against a live Composio account (`registry.ts:206`) |
| Webchat | real, by a different mechanism — the widget is the transport, so `sell()` is called in-process and the reply returns in the HTTP response |
| Email (Gmail) | **partial, and it presents as working.** Outbound and the parser are real; inbound is dead — `upsertTrigger()` is implemented and never called from `src/`, and `/webhooks/composio` logs `composio.trigger.message` instead of routing it. A connected Gmail shows "Live" and delivers nothing. |
| Slack, Phone/VoIP, LinkedIn, Zoom/Teams | **absent.** Not in the `Channel` enum, not in the registry, no env keys, zero occurrences in `web/src`. |

## 5. The HTTP API

**77 route modules under `web/src/app/v1/`.** There is no `middleware.ts` and
no rewrites: the paths are literally `/v1/...`, **not** `/api/v1/...` as the
PRD writes them.

- **One wrapper.** `route()` (`web/src/server/lib/http.ts:63`) opens an
  `AsyncLocalStorage` store for the request, turns a thrown `HttpError` into
  the one error envelope `{ error, details? }`, and attaches CORS on both the
  success and the failure path. An unexpected throw is logged and becomes a
  bare 500 — no stack ever reaches a client.
- **One auth choke point.** `resolveWorkspaceId()`
  (`web/src/server/lib/workspace.ts:43`) resolves the tenant from the
  credential and never from client input. A session may only *choose among*
  the caller's own workspaces; an API key *names* its workspace and an
  `x-workspace-id` that disagrees is 403. A request carrying both a cookie and
  a key is refused rather than resolved by precedence. Scope (`read`/`write`)
  is derived from the HTTP method and **fails closed to `write`**.
- **Keys** are `lipi_sk_…`, stored only as a SHA-256 hash under a unique
  index, throttled at 600/60s per key, revocable, and refused by the three
  `/v1/api-keys` routes themselves (`sessionOnly: true`) so a leaked key
  cannot mint its successor.
- **Pagination** is keyset-only, in one place (`server/lib/page.ts`),
  deliberately not Prisma's `cursor` option, with an opaque
  `base64url("<sortKey>.<id>")` cursor and an `id` tiebreak.
- **OpenAPI 3.1 is generated** from the Zod schemas in `v1/contract.ts`, checked
  in at `docs/openapi.json`, and CI fails if it has drifted
  (`test/openapi.test.ts`). Only ~17 endpoints are in the documented table; the
  dashboard-facing surface is undocumented by design.

### The three PRD endpoints

| PRD | Reality |
| --- | --- |
| `POST /api/v1/builder/sites/generate` | **absent.** No site builder code anywhere. |
| `POST /api/v1/conversations/ingest` | **absent as a path.** The pipeline exists and is reachable at `POST /v1/messages`, `POST /v1/conversations` and `POST /v1/webchat/{workspaceId}/message`, all in the repo's camelCase, none matching the PRD's snake_case body. |
| `POST /api/v1/agents/builder/deploy` | **absent.** `/v1/agents` holds only `GET /v1/agents/runs`. |

## 6. Frontend

Light theme, violet accent, Plus Jakarta Sans + JetBrains Mono, tokens declared
in Tailwind v4 `@theme` blocks in `web/src/app/globals.css` (there is no
`tailwind.config`). Accessibility is unusually well handled — measured contrast
ratios recorded per token, skip link, 44px targets, `aria-live` regions,
`prefers-reduced-motion` guards, colour never carrying meaning alone.

17 dashboard screens behind an auth gate. Server components fetch through
`web/src/lib/dash.ts`; client components through `web/src/lib/client.ts`
(`apiFetch`/`apiJson`), which forwards the session cookie and the
`x-workspace-id` header.

## 7. Testing

824 tests in 37 files, run by vitest against a **real Postgres** (`lipi_test`),
`fileParallelism: false`. External services are swapped at one seam each
(`setComposioClient`, `setShopifyClient`, `setWebhookPoster`) rather than mocked
per call site, so signature verification, idempotency, retry classification and
every database effect are exercised for real. CI runs lint, typecheck and the
full suite on every push against a Postgres 15 service container.

This is a good suite. It is the safety net for everything that follows.

---

## 8. Gap register against the PRD

Classification: **works** · **partial** · **stub** · **missing**.

| PRD area | State | Evidence |
| --- | --- | --- |
| Omnichannel ingestion (8 channels) | **partial** — 4 of 8 (WhatsApp, Telegram, Instagram DM, Web SDK-as-widget); Slack, Phone/VoIP, LinkedIn, Zoom/Teams missing | §4 above |
| 3-step no-code agent builder | **missing** — no `Agent` entity, no template marketplace, no skill assembly. The `/dashboard/train` 4-step flow and the 7-step onboarding wizard configure *the workspace*, not an agent. | `dashboard/train/page.tsx:52`, `onboarding/steps.ts:57` |
| 50+ modular skills | **missing** — no skill abstraction of any kind | no `Skill` model, no registry |
| Instant website generator | **missing** — `components/site/**` is Lipi's own marketing page; the only artefact shipped to a customer's site is `widget.js` | agent report §7 |
| `POST /api/v1/builder/sites/generate` | **missing** | — |
| Bespoke SDK (`@lipi-ai/sdk-node`) | **missing** — no package, no `LipiAgent`, no `CustomSkill`, no `ToolContext` | — |
| Digital Twin: Customer | **partial** — rich attributes exist (CLV, price sensitivity, risk, channel, negotiation style, lead score, attribution). The PRD's *rules* (authorise if margin > 18%, flag credit risk on past-due, route VIP instantly) are absent. | `schema.prisma:77` |
| Digital Twin: Product & Fitment | **partial** — SKU, real-time stock, margin %, vertical attributes, variant axes. No fitment graph (Make/Model/Year/VIN), no superseded part numbers, no cross-reference traversal. | `schema.prisma:198` |
| Digital Twin: Order & Supply | **partial** — stage machine, supplier lead time / defect rate / MOQ on `Supplier`. Missing `Inquiry` and `Confirmed` stages, the 4-hour reservation hold, auto-PO dispatch, shipment tracking sync. | `schema.prisma:181,257` |
| Digital Twin: Personal PA | **missing** | no calendar anything |
| Digital Twin: Opportunity & ABM | **missing** | — |
| Neo4j graph / Pinecone vectors | **missing** — grounding is keyword-ranked Postgres | `briefing.ts` |
| Voice: ASR, VAD, turn-taking, `AUDIO_INTERRUPT`, TTS | **missing** — `services/voice.ts` is brand voice, not audio | — |
| PII/PHI detection and redaction | **missing** — `extract.ts` pattern-matches contact details *to store them*, which is the opposite operation | `extract.ts:173` |
| Agent Studio node graph | **missing** | agent report §5b |
| Instant Web Customizer | **missing** | agent report §5c |
| Omnichannel split-pane workspace | **partial** — the 3-pane inbox exists and is good, but the left rail lists threads rather than channels, and **thread rows are not interactive**: the page always renders `conversations[0]`, so the list is decorative | `dashboard/inbox/page.tsx:60,79`, `thread-list.tsx:29` |
| Design tokens (#0B0F19 / #111827 / #6366F1 / #10B981 / #EF4444, Inter) | **missing** — the app is light-themed with `--color-violet #7856ff` and Plus Jakarta Sans | `globals.css:8` |
| `POST /api/v1/conversations/ingest` | see the API section | — |
| `POST /api/v1/agents/builder/deploy` | **missing** | — |
| Model tiering (light extractor / heavy reasoner) | **works** — `OPENROUTER_MODEL` for extraction, `OPENROUTER_CHAT_MODEL` for reasoning, with per-workspace and per-customer budgets | `env.ts`, `lib/metering.ts` |
| Auditability / append-only event trail | **works** | `TwinEvent`, `test/tenancy.test.ts` |
| Multi-tenancy | **works** — one `resolveWorkspaceId()` choke point, keyset cursors that cannot widen a query, per-workspace CORS allow-lists | `server/lib/workspace.ts` |

### Defects found during discovery, independent of the PRD

1. **Webhook subscription cursor race** — fixed in this branch. See
   `PROGRESS.md`.
2. **Gmail inbound is dead while presenting as live** — a connected Gmail shows
   "Live" and can never receive. This is exactly the fake success state master
   prompt §6 prohibits.
3. **Inbox thread list is decorative** — rows are non-interactive `<li>`s and
   the page always opens the newest conversation. Same category as (2).
4. **`externalId` and `threadId` are dropped** between `ParsedMessage` and
   `IngestInput`, so Gmail's `GMAIL_REPLY_TO_THREAD` can never fire from the
   inbound path.
5. **Rate limiting is per-process in memory** — documented in the code, wrong
   under horizontal scaling.

### Security observations from the API read, carried into §19 work

6. **No throttle on `/v1/auth/login` or `/v1/auth/signup`** — rate limiting
   exists for API keys and for the public webchat routes, and nowhere else, so
   the password endpoints have no brute-force or enumeration budget.
7. **A `write`-scoped API key can PATCH its own workspace's
   `allowedOrigins`** via `/v1/workspaces/current`, widening the set of browser
   origins from which keys are usable. `/v1/api-keys` is session-gated for
   exactly this class of self-perpetuation; this route is not.
8. **Nothing structurally requires a new route to scope by workspace.**
   `route()` does not demand `resolveWorkspaceId()`, there is no Prisma
   extension or RLS, and `test/tenancy.test.ts` covers named endpoints by hand
   — so a newly added route that forgets the call passes CI. This is the
   sharpest structural gap in an otherwise careful design.
