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
| A-1 | §1 | Omnichannel ingestion across WhatsApp, Telegram, Slack, Phone/VoIP, Instagram DM, LinkedIn, Zoom/Teams, Web SDK | 4 of 8: WhatsApp, Telegram, Instagram DM, Web SDK (widget). Plus Messenger, X, partial Gmail. | Slack, Phone/VoIP, LinkedIn, Zoom/Teams | `server/channels/registry.ts` | NOT_STARTED |
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
| B-1 | §2 Step 01 | Pick a template from a marketplace: Customer Support, SDR, Calendar PA, Inbound Reception | none | templates, marketplace, `Agent` entity | — | NOT_STARTED |
| B-2 | §2 Step 01 | Assemble a custom agent from 50+ modular skills | none | skill abstraction entirely | — | NOT_STARTED |
| B-3 | §2 Step 01 | The five named skills: `Calendar_Negotiation`, `Inventory_Lookup`, `Discount_Calculator`, `Stripe_Invoice`, `Lead_Scoring` | lead scoring and stock checking exist as inline code inside `ingest()`, not as skills | all five as addressable skills; discount and calendar logic do not exist at all | `services/leads.ts`, `services/ingest.ts` | NOT_STARTED |
| B-4 | §2 Step 02 | Upload PDF catalogues, spreadsheets, call transcripts, website URLs for training | CSV variant import; manual knowledge entries | PDF, transcript and URL ingestion | `v1/catalogue/import`, `v1/twin/knowledge` | NOT_STARTED |
| B-5 | §2 Step 02 | Define brand voice personality | **works** — formality, length, emoji, greeting, sign-off, always/never phrases, enforced on the model's output | — | `services/voice.ts`, `v1/twin/voice` | IMPLEMENTED |
| B-6 | §2 Step 02 | Establish discount authorisation floors | the twin is forbidden to offer *any* discount (`UNAUTHORISED_OFFER`) | an authorised floor it may work within | `services/voice.ts:98` | NOT_STARTED |
| B-7 | §2 Step 02 | Set human-in-the-loop escalation thresholds | one workspace-wide policy: everything / money_only / nothing | per-agent thresholds and named triggers | `schema.prisma:473` | NOT_STARTED |
| B-8 | §2 Step 03 | Publish across WhatsApp, Telegram, Slack, Website Chat, Phone/VoIP, LinkedIn in one click | per-channel connect flows | a deploy action, and 3 of the 6 channels | `v1/channels/[channel]/connect` | NOT_STARTED |
| B-9 | §2 Step 03 | Monitor real-time conversation telemetry | dashboard KPIs, volume, intent mix, model spend — all request-time, none live | live updates | `services/analytics.ts` | NOT_STARTED |
| B-10 | §2 Step 03 | Review audit trails | **works** — append-only `TwinEvent`, exposed at `/v1/events` and `/dashboard/events` | — | `server/lib/events.ts` | IMPLEMENTED |
| B-11 | §2 Step 03 | Fine-tune agent behaviour live | voice, knowledge and policy are editable and take effect on the next message | per-agent tuning | `/dashboard/train` | IMPLEMENTED |
| B-12 | §2 | Whole flow completes in under 2 minutes | — | the flow, and a measurement of it | — | NOT_STARTED |

| ID | Unit | Integration | E2E | Manual | Acceptance criterion | Final |
| --- | --- | --- | --- | --- | --- | --- |
| B-1 | — | — | — | — | four templates instantiate a working agent | pending |
| B-2 | — | — | — | — | skills compose without touching agent code | pending |
| B-3 | — | — | — | — | each of the five validates, guards, executes and audits | pending |
| B-4 | — | — | — | — | each source type produces retrievable knowledge | pending |
| B-5 | `test/selling.test.ts` (voice violations), `test/ingest.test.ts` | `test/api-contract.test.ts` | — | — | a banned phrase never reaches a customer | **baseline green** |
| B-6 | — | — | — | — | a discount within the floor is offered; beyond it escalates | pending |
| B-7 | `test/ingest.test.ts` (approval policy) | — | — | — | a named trigger holds the reply | pending |
| B-8 | — | — | — | — | one call deploys to every named channel | pending |
| B-9 | — | — | — | — | telemetry reflects a conversation that just happened | pending |
| B-10 | `test/tenancy.test.ts`, `test/ingest.test.ts` | `test/api-contract.test.ts` | — | — | every mutation appears in the trail | **baseline green** |
| B-11 | `test/twin-chat.test.ts` | — | — | — | an edit changes the next reply | **baseline green** |
| B-12 | — | — | — | — | measured, in `PERFORMANCE.md` | pending |

---

## C. Instant Website Builder (PRD §3)

| ID | PRD | Requirement | Existing | Missing | Files | Status |
| --- | --- | --- | --- | --- | --- | --- |
| C-1 | §3 Ph.1 | Intent → structure: business context prompt produces responsive components, semantic schema, sitemap | nothing | all | — | NOT_STARTED |
| C-2 | §3 Ph.2 | Dynamic twin binding: product/service twins, quote formulas, Stripe checkout links, Google reviews bound to UI | nothing | all | — | NOT_STARTED |
| C-3 | §3 Ph.3 | Global edge hosting: Cloudflare/Vercel deploy, SSL, custom domain DNS, SEO tags, embedded sub-400ms assistant | the embeddable widget exists and is real | deployment of a generated site | `public/static/widget.js` | NOT_STARTED |
| C-4 | §3.1 | `POST /api/v1/builder/sites/generate` with `business_profile` / `site_features` / `deployment_target` | nothing | the endpoint and everything behind it | — | NOT_STARTED |
| C-5 | §3 | Generation completes in under 3 minutes | — | — | — | NOT_STARTED |

| ID | Unit | Integration | E2E | Manual | Acceptance criterion | Final |
| --- | --- | --- | --- | --- | --- | --- |
| C-1 | — | — | — | — | a profile yields a persisted, renderable structure | pending |
| C-2 | — | — | — | — | a bound price comes from a twin row, never from the model | pending |
| C-3 | — | — | — | — | deployment config is produced; the deploy itself is adapter-backed | pending |
| C-4 | — | — | — | — | request/response schemas, auth, errors and persistence all tested | pending |
| C-5 | — | — | — | — | measured (§28) | pending |

---

## D. Bespoke SDK (PRD §4)

| ID | PRD | Requirement | Existing | Missing | Files | Status |
| --- | --- | --- | --- | --- | --- | --- |
| D-1 | §4 | Sandboxed TypeScript SDK: `LipiAgent`, `CustomSkill`, `ToolContext` | nothing | all | — | NOT_STARTED |
| D-2 | §4 | Python SDK parity | nothing | all | — | NOT_STARTED |
| D-3 | §4.1 | Tool parameter schema with enum validation (`material`, `thickness_mm`, `cut_length_cm`, `quantity`) | nothing | all | — | NOT_STARTED |
| D-4 | §4.1 | `ctx.twinStore.updateOrderDraft` mutates the living Order twin | nothing | all | — | NOT_STARTED |
| D-5 | §4.1 | Guardrails `maxSingleQuoteValue: 25000`, `escalateIfMaterialUnknown: true` | nothing | all | — | NOT_STARTED |
| D-6 | §4.1 | Deterministic fabrication pricing: density, material cost, machine time, quantity break at >50, lead time break at >100 | nothing | all | — | NOT_STARTED |
| D-7 | §4.1 | Deploy a bespoke agent across WhatsApp, Telegram and Web | nothing | all | — | NOT_STARTED |

| ID | Unit | Integration | E2E | Manual | Acceptance criterion | Final |
| --- | --- | --- | --- | --- | --- | --- |
| D-1 | — | — | — | — | the PRD's own snippet compiles and runs | pending |
| D-2 | — | — | — | — | same tool, same numbers, both languages | pending |
| D-3 | — | — | — | — | invalid material rejected, valid accepted | pending |
| D-4 | — | — | — | — | the order draft row actually changes | pending |
| D-5 | — | — | — | — | a quote over 25000 escalates rather than being sent | pending |
| D-6 | — | — | — | — | **asserted against actual values** for each named boundary | pending |
| D-7 | — | — | — | — | the deployed agent answers on each channel | pending |

---

## E. Digital Twin entities (PRD §5)

| ID | PRD | Requirement | Existing | Missing | Files | Status |
| --- | --- | --- | --- | --- | --- | --- |
| E-1 | §5 | **Customer/Lead Twin** attributes: CLV, price sensitivity, channel history, negotiation style, risk score, open invoices | all present as columns, plus lead score/stage and first-touch attribution | — | `schema.prisma:77` | IMPLEMENTED |
| E-2 | §5 | Rule: authorise custom quotes if margin > 18% | `Product.marginPct` exists; no rule reads it | the rule | `schema.prisma:212` | NOT_STARTED |
| E-3 | §5 | Rule: flag credit risk if past-due invoices > 0 | invoices and ageing buckets exist | the flag, and its effect on a sale | `services/billing.ts` | NOT_STARTED |
| E-4 | §5 | Rule: route VIP inquiries instantly | `segment` exists | routing | — | NOT_STARTED |
| E-5 | §5 | **Product & Fitment Twin**: SKU, real-time stock, margin %, fitment graph (Make/Model/Year/VIN), superseded part numbers, marine engine hours | SKU, stock, margin, per-vertical JSON attributes, two variant axes | the fitment graph and supersession | `schema.prisma:198` | NOT_STARTED |
| E-6 | §5 | Rule: lock reserved stock for 4 hours on checkout-link generation | reservation is permanent until the order settles | the 4-hour hold and its expiry | `services/ingest.ts:243` | NOT_STARTED |
| E-7 | §5 | Rule: traverse the graph for OEM/aftermarket cross-references | `crossSell` string array | traversal | `schema.prisma:217` | NOT_STARTED |
| E-8 | §5 | **Order & Supply Twin** state: Inquiry → Quote → Confirmed → Paid → Packed → Shipped | Quoted → Paid → Packed → Shipped → Delivered, + Returned | `Inquiry` and `Confirmed` | `schema.prisma:42` | NOT_STARTED |
| E-9 | §5 | Supplier lead time, defect rate, MOQ | **works** — all three on `Supplier` | — | `schema.prisma:181` | IMPLEMENTED |
| E-10 | §5 | Rule: auto-dispatch POs when reserved inventory drops below threshold | a Procurement *run* is raised at the reorder point; no PO is dispatched | the dispatch | `services/ingest.ts:255` | NOT_STARTED |
| E-11 | §5 | Rule: sync shipment tracking via webhooks | outbound webhook delivery is real | shipment tracking itself | `services/webhooks.ts` | NOT_STARTED |
| E-12 | §5 | **Personal PA Twin**: focus blocks, max daily meeting hours, 15-min buffers, fatigue index, active negotiations | nothing | all | — | NOT_STARTED |
| E-13 | §5 | Rule: autonomous multi-turn calendar negotiation, timezone resolution, focus-time enforcement | nothing | all | — | NOT_STARTED |
| E-14 | §5 | **Opportunity & ABM Twin**: org chart, champion/blocker map, buying intent 0–1.0, 10-K filings, hiring telemetry, mutual connections | nothing | all | — | NOT_STARTED |
| E-15 | §5 | Rule: intent score rises on executive LinkedIn engagement; drafts contextual outreach | nothing | all | — | NOT_STARTED |
| E-16 | §5 | Event-driven: every conversation, message and transaction mutates shared state | **works** — one transaction per message, append-only `TwinEvent` for every mutation | — | `services/ingest.ts:83` | IMPLEMENTED |
| E-17 | §5 | Graph (Neo4j) + Vector (Pinecone) + Document (PostgreSQL) | PostgreSQL only; grounding is keyword-ranked | graph and vector stores | `services/briefing.ts` | NOT_STARTED |

| ID | Unit | Integration | E2E | Manual | Acceptance criterion | Final |
| --- | --- | --- | --- | --- | --- | --- |
| E-1 | `test/ingest.test.ts` | `test/api-contract.test.ts` | — | — | attributes persist and are served | **baseline green** |
| E-2 | — | — | — | — | a quote below the margin floor is refused | pending |
| E-3 | — | — | — | — | a past-due customer is flagged before a sale completes | pending |
| E-4 | — | — | — | — | a VIP message is routed differently and the routing is audited | pending |
| E-5 | `test/inventory.test.ts` | — | — | — | fitment resolves a part from vehicle attributes | pending |
| E-6 | — | — | — | — | a hold expires and the stock returns | pending |
| E-7 | — | — | — | — | an OEM number resolves its aftermarket equivalents | pending |
| E-8 | — | — | — | — | the full six-state machine, forward-only, with settlement | pending |
| E-9 | `test/inventory.test.ts` | — | — | — | present and served | **baseline green** |
| E-10 | — | — | — | — | crossing the threshold creates a PO | pending |
| E-11 | `test/webhook-delivery.test.ts` | — | — | — | a tracking update reaches a subscriber | pending |
| E-12 | — | — | — | — | the twin exists, persists and is audited | pending |
| E-13 | — | — | — | — | Use Case 2 passes end to end | pending |
| E-14 | — | — | — | — | the twin exists, persists and is audited | pending |
| E-15 | — | — | — | — | an engagement event moves the score deterministically | pending |
| E-16 | `test/ingest.test.ts`, `test/tenancy.test.ts` | `test/webhook-delivery.test.ts` | — | — | all-or-nothing per message | **baseline green** |
| E-17 | — | — | — | — | one adapter each, deterministic test implementation | pending |

---

## F. Use cases as acceptance tests (PRD §6)

| ID | PRD | Requirement | Existing | Missing | Files | Status |
| --- | --- | --- | --- | --- | --- | --- |
| F-1 | §6.1 | **Use Case 1** — WhatsApp wholesaler: extract item/colour/size/qty/offer/deadline; inventory confirms; price floor validated; customer has no overdue invoices; lock units; generate checkout link; reply on WhatsApp; push order draft to ERP | extraction, stock check, reservation, order creation, WhatsApp reply, audit trail | price-floor validation, credit check, checkout link, ERP push | `services/ingest.ts` | NOT_STARTED |
| F-2 | §6.2 | **Use Case 2** — PA: 45 min with Dr. Chen next week, avoid mornings, 15-min buffers; negotiate; confirm; sync Google Calendar | nothing | all | — | NOT_STARTED |
| F-3 | §6.3 | **Use Case 3** — regulated meeting intelligence: audio capture, ASR, stress flags, PII/PHI redaction, SOAP notes / case timelines against a precedent graph | nothing | all | — | NOT_STARTED |
| F-4 | §6.4 | **Use Case 4** — inbound phone reception: SIP routing, brand voice, grounded RAG answers, appointment booking, SMS confirmation | grounded answers exist (text) | telephony, voice, booking, SMS | `services/briefing.ts` | NOT_STARTED |

| ID | Unit | Integration | E2E | Manual | Acceptance criterion | Final |
| --- | --- | --- | --- | --- | --- | --- |
| F-1 | — | — | — | — | the PRD's exact sentence drives the whole chain and every step is asserted | pending |
| F-2 | — | — | — | — | the PRD's exact sentence yields a booked slot honouring both constraints | pending |
| F-3 | — | — | — | — | redaction verified; compliance *claims* explicitly not made | pending |
| F-4 | — | — | — | — | call → answer → booking → confirmation, with failures and retries | pending |

---

## G. UI/UX (PRD §7) and design system (PRD §8.1)

| ID | PRD | Requirement | Existing | Missing | Files | Status |
| --- | --- | --- | --- | --- | --- | --- |
| G-1 | §7.1 | Omnichannel split-pane: channel sidebar, transcript centre, 360° twin inspector | a real 3-pane inbox with transcript, entity chips, delivery state and a customer-twin inspector | a **channel** rail, and working thread selection — rows are inert and the page always opens the newest thread | `app/dashboard/inbox/page.tsx:60` | IN_PROGRESS |
| G-2 | §7.2 | Agent Studio canvas: drag-and-drop node graph for triggers, margin guardrails, fallback conditions, escalation rules | one workspace-wide autonomy radio group | the canvas and everything it configures | `dashboard/train/policy-form.tsx` | NOT_STARTED |
| G-3 | §7.3 | Instant Web Customizer: mobile/desktop preview, block library, theme token editor, prompt-driven layout modifier | nothing | all | — | NOT_STARTED |
| G-4 | §8.1 | Colours: `#0B0F19` canvas, `#111827` surface, `#6366F1` indigo, `#10B981` emerald, `#EF4444` coral | a light theme with `--color-violet #7856ff`; semantic token layer already exists and is used everywhere | the PRD's values | `app/globals.css:8` | NOT_STARTED |
| G-5 | §8.1 | Inter for UI, JetBrains Mono for SKUs/JSON/timestamps | JetBrains Mono **is** the mono face; UI face is Plus Jakarta Sans | Inter | `app/layout.tsx:5` | NOT_STARTED |
| G-6 | §8.1 | UI response < 150 ms | — | measurement | — | NOT_STARTED |
| G-7 | §8.1 | Streaming text generation > 35 tokens/sec | replies are not streamed at all | streaming | `services/selling.ts` | NOT_STARTED |
| G-8 | §7 | Works on desktop and mobile | **works** — documented responsive behaviour, 44px targets, skip link, `aria-live`, reduced-motion guards, measured contrast | — | `globals.css`, `components/dash/nav.tsx` | IMPLEMENTED |

| ID | Unit | Integration | E2E | Manual | Acceptance criterion | Final |
| --- | --- | --- | --- | --- | --- | --- |
| G-1 | — | — | — | — | selecting a thread changes the transcript; channels filter | pending |
| G-2 | — | — | — | — | a graph edit changes agent behaviour on the next message | pending |
| G-3 | — | — | — | — | a block added in the customizer appears in the generated site | pending |
| G-4 | — | — | — | — | the five PRD hex values are the theme, contrast re-measured | pending |
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
| H-4 | §8.1 | `POST /api/v1/conversations/ingest` with the PRD's exact body | the pipeline is reachable at `/v1/messages` and `/v1/conversations`, in camelCase | the path and the snake_case contract | `v1/messages/route.ts` | NOT_STARTED |
| H-5 | §8.1 | `POST /api/v1/agents/builder/deploy` with `agent_name`, `skills`, `knowledge_base_ids`, `channels`, `guardrails` | nothing | all | — | NOT_STARTED |

| ID | Unit | Integration | E2E | Manual | Acceptance criterion | Final |
| --- | --- | --- | --- | --- | --- | --- |
| H-1 | — | — | — | — | transport adapter with a deterministic test implementation | pending |
| H-2 | — | — | — | — | 200 ms threshold asserted both sides of the boundary | pending |
| H-3 | `test/model-budget.test.ts`, `test/openrouter.test.ts` | `test/selling.test.ts` | — | — | over budget degrades rather than failing | **baseline green** |
| H-4 | — | — | — | — | the PRD's literal request body is accepted and performs a real ingest | pending |
| H-5 | — | — | — | — | the PRD's literal request body deploys a real agent | pending |

---

## I. Acceptance criteria (PRD §9)

Each is `VERIFIED` (with the measurement), `NOT VERIFIED`,
`REQUIRES PRODUCTION VALIDATION`, or `BLOCKED BY EXTERNAL DEPENDENCY`.
Never a claimed number that was not measured.

| ID | PRD | Criterion | Status |
| --- | --- | --- | --- |
| I-1 | §9 Ph.1 | Site build < 180 s | NOT VERIFIED |
| I-2 | §9 Ph.1 | Agent deploy < 2 min | NOT VERIFIED |
| I-3 | §9 Ph.1 | Word error rate < 5% | NOT VERIFIED |
| I-4 | §9 Ph.1 | 80% auto-resolution | NOT VERIFIED |
| I-5 | §9 Ph.2 | Intent F1 > 0.92 | NOT VERIFIED |
| I-6 | §9 Ph.2 | Sub-400 ms voice turn-taking | NOT VERIFIED |
| I-7 | §9 Ph.2 | Custom tool overhead < 120 ms | NOT VERIFIED |
| I-8 | §9 Ph.2 | SOC 2 / HIPAA BAA ready | NOT VERIFIED — a compliance *claim* will not be made; what is implemented will be documented, and what needs infrastructure and process validation will be named |
| I-9 | §9 Ph.3 | 4× faster quote-to-cash | NOT VERIFIED — a business outcome, not measurable in this repository |
| I-10 | §9 Ph.3 | 56:1 LTV:CAC | NOT VERIFIED — likewise |

---

## J. Cross-cutting requirements the PRD implies

| ID | Source | Requirement | Existing | Status |
| --- | --- | --- | --- | --- |
| J-1 | §5, §8 | Tenant isolation across every object | **works** — one `resolveWorkspaceId()` choke point, keyset cursors, per-workspace CORS. But nothing structurally *requires* a new route to scope. | IN_PROGRESS |
| J-2 | §8 | Agent tool execution is a hard security boundary | no tool execution exists yet to bound | NOT_STARTED |
| J-3 | §2, §5 | Every mutation audited | **works** | IMPLEMENTED |
| J-4 | §4 | Deterministic business math, never model-computed | **works** — the whole `ingest`/`sell` split | IMPLEMENTED |
| J-5 | — | Money as integer minor units | **works** — paise throughout | IMPLEMENTED |
| J-6 | §8 | Errors actionable, no secrets, no stack traces | **works** — one envelope produced in one place | IMPLEMENTED |
