# TRACEABILITY

One row per PRD requirement, from `docs/PRD.md` read end to end.

**Format.** The master prompt asks for thirteen columns. Thirteen columns in one
markdown table is unreadable, so each section carries two tables keyed by the
same ID: **Implementation** (PRD section, requirement, what exists, what is
missing, files, status) and **Verification** (unit, integration, E2E, manual,
acceptance criterion, final verification). No field is dropped.

**Status:** `NOT_STARTED` · `IN_PROGRESS` · `IMPLEMENTED` · `TESTING` ·
`VERIFIED` · `BLOCKED_EXTERNAL_DEPENDENCY`.

**`VERIFIED` requires evidence** — a named test that exercises the behaviour and
passed, or a recorded direct verification. Code having been written is not
evidence.

Baseline column values below were established by reading the code on
2026-09-21; see `REPO_MAP.md`.

---

## A. Architecture (PRD §1)

| ID | PRD | Requirement | Existing | Missing | Files | Status |
| --- | --- | --- | --- | --- | --- | --- |
| A-1 | §1 | Omnichannel ingestion across eight channels | 4 of 8 end to end (WhatsApp, Telegram, Instagram DM, Web SDK), plus Messenger, X and Gmail outbound | Slack, Phone/VoIP, LinkedIn, Zoom/Teams | `server/channels/registry.ts` | BLOCKED_EXTERNAL_DEPENDENCY — `BLOCKERS.md` B-010, B-007 |
| A-2 | §1 | No-code builder + developer extension: 3-step builder <2 min, 50+ modular skills, instant web generator, bespoke agent SDK | none of the four | all four | — | NOT_STARTED |
| A-3 | §1 | Conversation intelligence layer: streaming ASR <300ms, VAD turn-taking, prosody/emotion, PII/PHI NER | text intent extraction only (`extract.ts`) | every audio and NER component | `server/services/extract.ts` | NOT_STARTED |
| A-4 | §1 | Living Digital Twin graph (Neo4j): Customer, Product & Fitment, Inventory, Supplier, Order, PA Calendar, ABM | Customer, Product, Inventory, Supplier, Order as Postgres rows | Neo4j, PA Calendar twin, ABM twin, fitment graph | `prisma/schema.prisma` | NOT_STARTED |
| A-5 | §1 | Autonomous agent orchestration: Sales Negotiator, Personal PA, Procurement, Support, Compliance, Expert Voice | four agent *labels* emitted by an if/else in `ingest()` | any agent entity, orchestration, PA, compliance, expert voice | `server/services/ingest.ts:433` | NOT_STARTED |
| A-6 | §1 | Enterprise connectors: ERP (SAP/NetSuite), CRM (Salesforce/HubSpot), Stripe, Twilio SIP, Google Calendar, edge webhooks | outbound webhooks (real, signed, retried); Shopify; generic push inventory connector | ERP, CRM, Stripe, Twilio, Google Calendar | `server/services/webhooks.ts`, `shopify.ts` | NOT_STARTED |

| ID | Unit | Integration | E2E | Manual | Acceptance criterion | Final |
| --- | --- | --- | --- | --- | --- | --- |
| A-1 | — | — | — | — | every listed channel has inbound + outbound + audit | pending |
| A-2 | — | — | — | — | all four capabilities reachable from the product | pending |
| A-3 | — | — | — | — | ASR/VAD/NER present behind adapters with deterministic tests | pending |
| A-4 | — | — | — | — | seven twin types modelled, mutated and audited | pending |
| A-5 | — | — | — | — | agents are data, not branches | pending |
| A-6 | — | — | — | — | each connector present or recorded in `BLOCKERS.md` | pending |

---

## B. 3-Step No-Code Agent Builder (PRD §2)

| ID | PRD | Requirement | Existing | Missing | Files | Status |
| --- | --- | --- | --- | --- | --- | --- |
| B-1 | §2 Step 01 | Pick a template from a marketplace: Customer Support, SDR, Calendar PA, Inbound Reception | **all four, as data, each deploying a working agent** | a browser UI for picking one (M12) | `server/agents/templates.ts`, `v1/agents/templates` | VERIFIED |
| B-2 | §2 Step 01 | Assemble a custom agent from 50+ modular skills | a registry; an agent holds any subset; the SDK adds more without touching agent code | 45 more skills — the shape is done, the catalogue is five | `server/agents/registry.ts` | IMPLEMENTED |
| B-3 | §2 Step 01 | The five named skills | **all five**, each with an argument schema, guardrails, audit and tests | — | `server/agents/skills/*` | VERIFIED |
| B-4 | §2 Step 02 | Upload PDF catalogues, spreadsheets, call transcripts, website URLs for training | CSV variant import; manual knowledge entries | PDF, transcript and URL ingestion | `v1/catalogue/import`, `v1/twin/knowledge` | NOT_STARTED |
| B-5 | §2 Step 02 | Define brand voice personality | **works** — formality, length, emoji, greeting, sign-off, always/never phrases, enforced on the model's output | — | `services/voice.ts`, `v1/twin/voice` | IMPLEMENTED |
| B-6 | §2 Step 02 | Establish discount authorisation floors | three floors — allowance, price floor, margin — checked in order by `Discount_Calculator`; over the floor escalates with a counter-offer | wiring the floors into `ingest()`'s own reply path (M5) | `server/agents/skills/discount-calculator.ts` | IMPLEMENTED |
| B-7 | §2 Step 02 | Set human-in-the-loop escalation thresholds | per-agent guardrails: named triggers, quote ceiling, margin floor, past-due rule — all enforced in `execute.ts` and raising a real `Approval` | — | `server/agents/guardrails.ts` | VERIFIED |
| B-8 | §2 Step 03 | Publish across WhatsApp, Telegram, Slack, Website Chat, Phone/VoIP, LinkedIn in one click | one `POST` publishes to every named channel, refusing any that is not connected | Slack, Phone/VoIP, LinkedIn as channels (M11) | `server/agents/deploy.ts` | IN_PROGRESS |
| B-9 | §2 Step 03 | Monitor real-time conversation telemetry | dashboard KPIs, volume, intent mix, model spend — all request-time, none live | live updates | `services/analytics.ts` | NOT_STARTED |
| B-10 | §2 Step 03 | Review audit trails | **works** — append-only `TwinEvent`, exposed at `/v1/events` and `/dashboard/events` | — | `server/lib/events.ts` | IMPLEMENTED |
| B-11 | §2 Step 03 | Fine-tune agent behaviour live | voice, knowledge and policy are editable and take effect on the next message | per-agent tuning | `/dashboard/train` | IMPLEMENTED |
| B-12 | §2 | Whole flow completes in under 2 minutes | — | the flow, and a measurement of it | — | NOT_STARTED |

| ID | Unit | Integration | E2E | Manual | Acceptance criterion | Final |
| --- | --- | --- | --- | --- | --- | --- |
| B-1 | `test/agents.test.ts` "every template names only skills that exist" | `test/agent-builder.test.ts` "offers the four templates", "takes its skills and guardrails from a template" | — | — | four templates instantiate a working agent | **green** |
| B-2 | `test/agents.test.ts` "the registry" (5 cases) | `test/sdk.test.ts` "registering a custom skill" | — | — | skills compose without touching agent code | **green** |
| B-3 | `test/agents.test.ts` per-skill blocks, `test/calendar.test.ts` | `test/agent-builder.test.ts` "executing a skill over HTTP" | — | — | each of the five validates, guards, executes and audits | **green** |
| B-4 | — | — | — | — | each source type produces retrievable knowledge | pending |
| B-5 | `test/selling.test.ts` (voice violations), `test/ingest.test.ts` | `test/api-contract.test.ts` | — | — | a banned phrase never reaches a customer | **baseline green** |
| B-6 | `test/agents.test.ts` "Discount_Calculator" (4 cases) | — | — | — | a discount within the floor is offered; beyond it escalates | **green** |
| B-7 | `test/agents.test.ts` "guardrails", "guardrails at execution time" (7 cases) | `test/agent-builder.test.ts` "answers 202 when a guardrail holds" | — | — | a named trigger holds the reply | **green** |
| B-8 | — | `test/agent-builder.test.ts` "step 3 — deploying" (10 cases) | — | — | one call deploys to every named channel | **green for the 4 channels that exist** |
| B-9 | — | — | — | — | telemetry reflects a conversation that just happened | pending |
| B-10 | `test/tenancy.test.ts`, `test/ingest.test.ts` | `test/api-contract.test.ts` | — | — | every mutation appears in the trail | **baseline green** |
| B-11 | `test/twin-chat.test.ts` | — | — | — | an edit changes the next reply | **baseline green** |
| B-12 | `test/performance.test.ts` | — | — | — | measured, in `PERFORMANCE.md` | **green for the deploy step (5.8 ms)**; the operator's own time through a UI is not measured |

---

## C. Instant Website Builder (PRD §3)

| ID | PRD | Requirement | Existing | Missing | Files | Status |
| --- | --- | --- | --- | --- | --- | --- |
| C-1 | §3 Ph.1 | Intent → structure | pages, blocks, schema.org JSON-LD and a sitemap, computed deterministically from the profile; each block carries an empty slot for model-written copy | model-written copy is not generated yet — the slot is | `server/sites/structure.ts` | IMPLEMENTED |
| C-2 | §3 Ph.2 | Dynamic twin binding | blocks carry bindings, not data; `resolveBlocks()` reads live rows on every request; the quote formula is parsed and evaluated server-side | Stripe links on a site page (B-002), Google reviews (B-006) | `server/sites/generate.ts`, `formula.ts` | IMPLEMENTED |
| C-3 | §3 Ph.3 | Global edge hosting | the site **is served** at `/s/{slug}` with SEO tags, JSON-LD, sitemap and the embedded assistant; the deploy endpoint reports separately whether an edge host took it | CDN, custom domain, certificate — see `BLOCKERS.md` B-005 | `server/sites/hosting.ts`, `app/s/[slug]` | BLOCKED_EXTERNAL_DEPENDENCY |
| C-4 | §3.1 | `POST /api/v1/builder/sites/generate` | the PRD's body verbatim, at both `/v1` and `/api/v1`, persisting a real site | — | `v1/builder/sites/generate/route.ts` | VERIFIED |
| C-5 | §3 | Generation completes in under 3 minutes | 3.6 ms measured | — | `test/performance.test.ts` | VERIFIED |

| ID | Unit | Integration | E2E | Manual | Acceptance criterion | Final |
| --- | --- | --- | --- | --- | --- | --- |
| C-1 | `test/sites.test.ts` "phase 1" (12 cases) | — | — | — | a profile yields a persisted, renderable structure | **green** |
| C-2 | `test/formula.test.ts` (23 cases) | `test/sites.test.ts` "phase 2", "quoting" (8 cases) | — | — | a bound price comes from a twin row, never from the model | **green** |
| C-3 | — | `test/sites.test.ts` "phase 3" (3 cases) | — | — | deployment config is produced; the deploy itself is adapter-backed | **green for the adapter; the edge itself is B-005** |
| C-4 | — | `test/sites.test.ts` (28 cases) | — | — | request/response schemas, auth, errors and persistence all tested | **green** |
| C-5 | `test/performance.test.ts` | — | — | — | measured (§28) | **green** |

---

## D. Bespoke SDK (PRD §4)

| ID | PRD | Requirement | Existing | Missing | Files | Status |
| --- | --- | --- | --- | --- | --- | --- |
| D-1 | §4 | Sandboxed TypeScript SDK: `LipiAgent`, `CustomSkill`, `ToolContext` | **all three**; the PRD's import line resolves verbatim | — | `web/sdk/src/index.ts` | VERIFIED |
| D-2 | §4 | Python SDK parity | nothing | all | — | BLOCKED_EXTERNAL_DEPENDENCY — see `BLOCKERS.md` B-004 |
| D-3 | §4.1 | Tool parameter schema with enum validation | JSON-schema-ish declarations compiled to strict Zod; unknown keys, wrong types, `NaN` and `Infinity` all refused | — | `web/sdk/src/index.ts` | VERIFIED |
| D-4 | §4.1 | `ctx.twinStore.updateOrderDraft` mutates the living Order twin | writes a real `Order` row, in integer minor units, updating the draft rather than growing one per revision | — | `server/agents/twin-store.ts` | VERIFIED |
| D-5 | §4.1 | Guardrails `maxSingleQuoteValue: 25000`, `escalateIfMaterialUnknown: true` | both parsed; the ceiling checked against what the handler actually committed, not what it reported | — | `server/agents/guardrails.ts`, `execute.ts` | VERIFIED |
| D-6 | §4.1 | Deterministic fabrication pricing | the PRD's formula, asserted against hand-computed values at every boundary it has | — | `test/sdk.test.ts` | VERIFIED |
| D-7 | §4.1 | Deploy a bespoke agent across WhatsApp, Telegram and Web | `LipiAgent.deploy()` goes through the same validated path the builder does | — | `web/sdk/src/index.ts` | VERIFIED |

| ID | Unit | Integration | E2E | Manual | Acceptance criterion | Final |
| --- | --- | --- | --- | --- | --- | --- |
| D-1 | `test/sdk.test.ts` (the PRD's snippet, transcribed and executed) | — | — | — | the PRD's own snippet compiles and runs | **green** |
| D-2 | — | — | — | — | same tool, same numbers, both languages | **blocked** (B-004) |
| D-3 | `test/sdk.test.ts` "parameter validation" (5 cases) | — | — | — | invalid material rejected, valid accepted | **green** |
| D-4 | `test/sdk.test.ts` "the Digital Twin mutation" (3 cases) | — | — | — | the order draft row actually changes | **green** |
| D-5 | `test/sdk.test.ts` "guardrails on a bespoke agent" (4 cases) | — | — | — | a quote over 25000 escalates rather than being sent | **green** |
| D-6 | `test/sdk.test.ts` arithmetic + quantity break + lead-time break (9 cases) | — | — | — | **asserted against actual values** for each named boundary | **green** |
| D-7 | — | `test/sdk.test.ts` "deploying a bespoke agent" | — | — | the deployed agent answers on each channel | **green for deploy**; per-channel answering is M11 |

---

## E. Digital Twin entities (PRD §5)

| ID | PRD | Requirement | Existing | Missing | Files | Status |
| --- | --- | --- | --- | --- | --- | --- |
| E-1 | §5 | **Customer/Lead Twin** attributes: CLV, price sensitivity, channel history, negotiation style, risk score, open invoices | all present as columns, plus lead score/stage and first-touch attribution | — | `schema.prisma:77` | IMPLEMENTED |
| E-2 | §5 | Rule: authorise custom quotes if margin > 18% | `minMarginPct` defaults to 18 and binds the `Discount_Calculator` floor; over it the quote escalates with a counter-offer | — | `server/agents/guardrails.ts`, `skills/discount-calculator.ts` | VERIFIED |
| E-3 | §5 | Rule: flag credit risk if past-due invoices > 0 | derived from payments, flagged onto `Order.creditHold` and the trail, and holds a money skill for a human — never refuses the sale | — | `services/twin-rules.ts` | VERIFIED |
| E-4 | §5 | Rule: route VIP inquiries instantly | Corporate segment or lifetime value over the named threshold, recorded on the trail as `customer_twin.vip_routed` | surfacing the flag in the inbox ordering (M12) | `services/twin-rules.ts` | IMPLEMENTED |
| E-5 | §5 | **Product & Fitment Twin**: SKU, real-time stock, margin %, fitment graph (Make/Model/Year/VIN), superseded part numbers, marine engine hours | SKU, stock, margin, per-vertical JSON attributes, two variant axes | the fitment graph and supersession | `schema.prisma:198` | NOT_STARTED |
| E-6 | §5 | Rule: lock reserved stock for 4 hours | `Order.reservedUntil`, a per-workspace sweep that gives the stock back, and `Confirmed` making the hold permanent | — | `services/reservations.ts` | VERIFIED |
| E-7 | §5 | Rule: traverse the graph for OEM/aftermarket cross-references | `crossSell` string array | traversal | `schema.prisma:217` | NOT_STARTED |
| E-8 | §5 | **Order & Supply Twin** state machine | the PRD's full chain, one step forward, with stock settled on Delivered and Returned | — | `v1/orders/[id]/stage/route.ts` | VERIFIED |
| E-9 | §5 | Supplier lead time, defect rate, MOQ | **works** — all three on `Supplier` | — | `schema.prisma:181` | IMPLEMENTED |
| E-10 | §5 | Rule: auto-dispatch POs when reserved inventory drops below threshold | a real `PurchaseOrder` at the supplier's MOQ with their lead time, de-duplicated per variant, raised at `draft` | sending it — there is no supplier integration | `services/twin-rules.ts` | IMPLEMENTED |
| E-11 | §5 | Rule: sync shipment tracking via webhooks | outbound webhook delivery is real | shipment tracking itself | `services/webhooks.ts` | NOT_STARTED |
| E-12 | §5 | **Personal PA Twin**: focus blocks, max daily meeting hours, 15-min buffers, active negotiations | `PaProfile`, `CalendarEvent`, `SchedulingNegotiation`, all enforced arithmetically | a derived fatigue index | `prisma/schema.prisma`, `server/agents/scheduling.ts` | IMPLEMENTED |
| E-13 | §5 | Rule: autonomous multi-turn calendar negotiation, timezone resolution, focus-time enforcement | propose / counter / confirm, persisted between turns; DST-correct; only an offered slot may be confirmed | Google Calendar sync (`BLOCKERS.md` B-003) | `server/agents/skills/calendar-negotiation.ts` | VERIFIED |
| E-14 | §5 | **Opportunity & ABM Twin**: org chart, champion/blocker map, buying intent 0–1.0, 10-K filings, hiring telemetry, mutual connections | nothing | all | — | NOT_STARTED |
| E-15 | §5 | Rule: intent score rises on executive LinkedIn engagement; drafts contextual outreach | nothing | all | — | NOT_STARTED |
| E-16 | §5 | Event-driven: every conversation, message and transaction mutates shared state | **works** — one transaction per message, append-only `TwinEvent` for every mutation | — | `services/ingest.ts:83` | IMPLEMENTED |
| E-17 | §5 | Graph (Neo4j) + Vector (Pinecone) + Document (PostgreSQL) | PostgreSQL only; grounding is keyword-ranked | graph and vector stores | `services/briefing.ts` | NOT_STARTED |

| ID | Unit | Integration | E2E | Manual | Acceptance criterion | Final |
| --- | --- | --- | --- | --- | --- | --- |
| E-1 | `test/ingest.test.ts` | `test/api-contract.test.ts` | — | — | attributes persist and are served | **baseline green** |
| E-2 | `test/agents.test.ts` "lets the margin floor bind" | `test/use-case-1.test.ts` | — | — | a quote below the margin floor is refused | **green** |
| E-3 | `test/twin-rules.test.ts` "credit risk" (3 cases) | `test/use-case-1.test.ts` "flags a buyer with an overdue invoice" | — | — | a past-due customer is flagged before a sale completes | **green** |
| E-4 | `test/twin-rules.test.ts` "VIP routing" (4 cases) | — | — | — | a VIP message is routed differently and the routing is audited | **green** |
| E-5 | `test/inventory.test.ts` | — | — | — | fitment resolves a part from vehicle attributes | pending |
| E-6 | `test/twin-rules.test.ts` "the four-hour reservation hold" (7 cases) | `test/use-case-1.test.ts` | — | — | a hold expires and the stock returns | **green** |
| E-7 | — | — | — | — | an OEM number resolves its aftermarket equivalents | pending |
| E-8 | — | `test/twin-rules.test.ts` "the completed order state machine" (4 cases) | — | — | the full chain, forward-only, with settlement | **green** |
| E-9 | `test/inventory.test.ts` | — | — | — | present and served | **baseline green** |
| E-10 | `test/twin-rules.test.ts` "auto-dispatched purchase orders" (4 cases) | — | — | crossing the threshold creates a PO | **green** |
| E-11 | `test/webhook-delivery.test.ts` | — | — | — | a tracking update reaches a subscriber | pending |
| E-12 | `test/scheduling.test.ts` (22 cases) | `test/calendar.test.ts` (11 cases) | — | — | the twin exists, persists and is audited | **green** |
| E-13 | `test/scheduling.test.ts` | `test/calendar.test.ts` "PRD §6 Use Case 2" | — | — | Use Case 2 passes end to end | **green except the Google write** |
| E-14 | — | — | — | — | the twin exists, persists and is audited | pending |
| E-15 | — | — | — | — | an engagement event moves the score deterministically | pending |
| E-16 | `test/ingest.test.ts`, `test/tenancy.test.ts` | `test/webhook-delivery.test.ts` | — | — | all-or-nothing per message | **baseline green** |
| E-17 | — | — | — | — | one adapter each, deterministic test implementation | pending |

---

## F. Use cases as acceptance tests (PRD §6)

| ID | PRD | Requirement | Existing | Missing | Files | Status |
| --- | --- | --- | --- | --- | --- | --- |
| F-1 | §6.1 | **Use Case 1** — WhatsApp wholesaler | the PRD's own sentence drives the whole chain: extraction, the 600-in-stock check, the $8.40 floor, the credit check, 400 units locked under a 4-hour hold, the checkout link, the WhatsApp reply, the signed ERP push, and twelve named events on the trail | a live NetSuite — the ERP push is the signed outbound webhook queue | `test/use-case-1.test.ts` | VERIFIED |
| F-2 | §6.2 | **Use Case 2** — PA | the PRD's own sentence drives propose → confirm; every offered slot asserted to be 45 minutes, next week, not a morning in the owner's zone, and buffer-clear of a real booking | the Google Calendar write (B-003) | `test/calendar.test.ts` | IN_PROGRESS |
| F-3 | §6.3 | **Use Case 3** — regulated meeting intelligence: audio capture, ASR, stress flags, PII/PHI redaction, SOAP notes / case timelines against a precedent graph | nothing | all | — | NOT_STARTED |
| F-4 | §6.4 | **Use Case 4** — inbound phone reception: SIP routing, brand voice, grounded RAG answers, appointment booking, SMS confirmation | grounded answers exist (text) | telephony, voice, booking, SMS | `services/briefing.ts` | NOT_STARTED |

| ID | Unit | Integration | E2E | Manual | Acceptance criterion | Final |
| --- | --- | --- | --- | --- | --- | --- |
| F-1 | — | — | `test/use-case-1.test.ts` (4 cases) | — | the PRD's exact sentence drives the whole chain and every step is asserted | **green** |
| F-2 | `test/scheduling.test.ts` "reads the PRD's scheduling request" | `test/calendar.test.ts` "PRD §6 Use Case 2" | — | — | the PRD's exact sentence yields a booked slot honouring both constraints | **green** |
| F-3 | — | — | — | — | redaction verified; compliance *claims* explicitly not made | pending |
| F-4 | — | — | — | — | call → answer → booking → confirmation, with failures and retries | pending |

---

## G. UI/UX (PRD §7) and design system (PRD §8.1)

| ID | PRD | Requirement | Existing | Missing | Files | Status |
| --- | --- | --- | --- | --- | --- | --- |
| G-1 | §7.1 | Omnichannel split-pane: channel sidebar, transcript centre, 360° twin inspector | all three: a channel rail that filters server-side, a working thread list whose rows are links, the transcript with entity chips and delivery state, and the customer-twin inspector | live updates — the page does not poll or stream | `app/dashboard/inbox/*` | IMPLEMENTED |
| G-2 | §7.2 | Agent Studio canvas | everything the canvas would edit — per-agent guardrails, skills, channels, escalation triggers — is a row behind `POST /v1/agents/builder/deploy` and is tested | the canvas itself | `server/agents/*` | BLOCKED_EXTERNAL_DEPENDENCY — see `BLOCKERS.md` B-011 |
| G-3 | §7.3 | Instant Web Customizer | site structure, blocks, bindings and theme mode are rows behind `POST /v1/builder/sites/generate`, and `/s/{slug}` renders them | the editor itself | `server/sites/*`, `app/s/[slug]` | BLOCKED_EXTERNAL_DEPENDENCY — see `BLOCKERS.md` B-011 |
| G-4 | §8.1 | Colours: `#0B0F19` canvas, `#111827` surface, `#6366F1` indigo, `#10B981` emerald, `#EF4444` coral | **generated sites** use the PRD's palette verbatim | Lipi's own dashboard is still the light violet theme — see `DECISIONS.md` D-017 | `server/sites/theme.ts` | IN_PROGRESS |
| G-5 | §8.1 | Inter for UI, JetBrains Mono for SKUs/JSON/timestamps | JetBrains Mono **is** the mono face; UI face is Plus Jakarta Sans | Inter | `app/layout.tsx:5` | NOT_STARTED |
| G-6 | §8.1 | UI response < 150 ms | — | measurement | — | NOT_STARTED |
| G-7 | §8.1 | Streaming text generation > 35 tokens/sec | replies are not streamed at all | streaming | `services/selling.ts` | NOT_STARTED |
| G-8 | §7 | Works on desktop and mobile | **works** — documented responsive behaviour, 44px targets, skip link, `aria-live`, reduced-motion guards, measured contrast | — | `globals.css`, `components/dash/nav.tsx` | IMPLEMENTED |

| ID | Unit | Integration | E2E | Manual | Acceptance criterion | Final |
| --- | --- | --- | --- | --- | --- | --- |
| G-1 | — | — | — | — | selecting a thread changes the transcript; channels filter | **implemented** — rows are links, the rail filters server-side |
| G-2 | — | `test/agent-builder.test.ts` covers the API a canvas would drive | — | — | a graph edit changes agent behaviour on the next message | **the system is green; the canvas is not built** |
| G-3 | — | `test/sites.test.ts` covers the API an editor would drive | — | — | a block added in the customizer appears in the generated site | **the system is green; the editor is not built** |
| G-4 | `test/sites.test.ts` "the theme tokens" | — | — | — | the five PRD hex values are the theme, contrast re-measured | **green for generated sites** |
| G-5 | — | — | — | — | Inter loaded for UI, JetBrains Mono for technical values | pending |
| G-6 | — | — | — | — | measured (§28) | pending |
| G-7 | — | — | — | — | measured, or recorded as not implemented | pending |
| G-8 | — | — | — | — | already true | **baseline green** |

---

## H. Technical architecture (PRD §8)

| ID | PRD | Requirement | Existing | Missing | Files | Status |
| --- | --- | --- | --- | --- | --- | --- |
| H-1 | §8 | Audio ingestion over WebSocket/WebRTC or SIP trunking | nothing | all | — | NOT_STARTED |
| H-2 | §8 | Interruption logic: caller speech > 200 ms during playback emits `AUDIO_INTERRUPT`, terminates the TTS buffer, reactivates listening | nothing | all | — | NOT_STARTED |
| H-3 | §8 | Model tiering: light model for extraction, heavy model for complex reasoning | **works** — two configured models, per-purpose metering, budget ceilings with deterministic degradation | — | `server/env.ts`, `server/lib/metering.ts` | IMPLEMENTED |
| H-4 | §8.1 | `POST /api/v1/conversations/ingest` with the PRD's exact body | the PRD's body verbatim, at both `/v1` and `/api/v1`, performing a real ingest; `business_account_id` checked, not ignored | — | `v1/conversations/ingest/route.ts` | VERIFIED |
| H-5 | §8.1 | `POST /api/v1/agents/builder/deploy` | the PRD's body verbatim, at both prefixes; upserts; refuses unknown skills, unknown or unconnected channels, foreign knowledge entries, unparseable guardrails | — | `v1/agents/builder/deploy/route.ts` | VERIFIED |

| ID | Unit | Integration | E2E | Manual | Acceptance criterion | Final |
| --- | --- | --- | --- | --- | --- | --- |
| H-1 | — | — | — | — | transport adapter with a deterministic test implementation | pending |
| H-2 | — | — | — | — | 200 ms threshold asserted both sides of the boundary | pending |
| H-3 | `test/model-budget.test.ts`, `test/openrouter.test.ts` | `test/selling.test.ts` | — | — | over budget degrades rather than failing | **baseline green** |
| H-4 | — | `test/prd-ingest.test.ts` (13 cases) | — | — | the PRD's literal request body is accepted and performs a real ingest | **green** |
| H-5 | — | `test/agent-builder.test.ts` (24 cases) | — | — | the PRD's literal request body deploys a real agent | **green** |

---

## I. Acceptance criteria (PRD §9)

Each is `VERIFIED` (with the measurement), `NOT VERIFIED`,
`REQUIRES PRODUCTION VALIDATION`, or `BLOCKED BY EXTERNAL DEPENDENCY`.
Never a claimed number that was not measured.

| ID | PRD | Criterion | Status |
| --- | --- | --- | --- |
| I-1 | §9 Ph.1 | Site build < 180 s | **VERIFIED** — 3.6 ms median, `test/performance.test.ts`. Caveat: this is the deterministic structure generation, not a static export or a CDN propagation, neither of which exists (`BLOCKERS.md` B-005) |
| I-2 | §9 Ph.1 | Agent deploy < 2 min | **VERIFIED** — 5.8 ms median, `test/performance.test.ts` |
| I-3 | §9 Ph.1 | Word error rate < 5% | NOT VERIFIED — no ASR exists (`BLOCKERS.md` B-007). No number will be claimed |
| I-4 | §9 Ph.1 | 80% auto-resolution | NOT VERIFIED |
| I-5 | §9 Ph.2 | Intent F1 > 0.92 | NOT VERIFIED — needs a labelled corpus; the extractor is tested for correctness on named cases, not scored |
| I-6 | §9 Ph.2 | Sub-400 ms voice turn-taking | NOT VERIFIED — no voice pipeline (`BLOCKERS.md` B-007) |
| I-7 | §9 Ph.2 | Custom tool overhead < 120 ms | **VERIFIED** — 1.4 ms median, measured as executor cost above the bare handler, `test/performance.test.ts` |
| I-8 | §9 Ph.2 | SOC 2 / HIPAA BAA ready | NOT VERIFIED — a compliance *claim* will not be made; what is implemented will be documented, and what needs infrastructure and process validation will be named |
| I-9 | §9 Ph.3 | 4× faster quote-to-cash | NOT VERIFIED — a business outcome, not measurable in this repository |
| I-10 | §9 Ph.3 | 56:1 LTV:CAC | NOT VERIFIED — likewise |

---

## J. Cross-cutting requirements the PRD implies

| ID | Source | Requirement | Existing | Status |
| --- | --- | --- | --- | --- |
| J-1 | §5, §8 | Tenant isolation across every object | **works** — one `resolveWorkspaceId()` choke point, keyset cursors, per-workspace CORS. But nothing structurally *requires* a new route to scope. | IN_PROGRESS |
| J-2 | §8 | Agent tool execution is a hard security boundary | nine checks in `execute.ts`, each with a test that asserts the refusal and that nothing was written | VERIFIED |
| J-3 | §2, §5 | Every mutation audited | **works** | IMPLEMENTED |
| J-4 | §4 | Deterministic business math, never model-computed | **works** — the whole `ingest`/`sell` split | IMPLEMENTED |
| J-5 | — | Money as integer minor units | **works** — paise throughout | IMPLEMENTED |
| J-6 | §8 | Errors actionable, no secrets, no stack traces | **works** — one envelope produced in one place | IMPLEMENTED |
