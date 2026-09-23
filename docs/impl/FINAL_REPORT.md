# FINAL REPORT

What was built, what it was verified with, and what is honestly not there.

Every number below was copied from output observed in this session. Where
something is not verified, it says so rather than being softened.

---

## A. Implementation summary

The repository began as a good, narrow product: a digital-twin layer for
conversational commerce, with one implicit agent, a deterministic `ingest()`
that decides what is true, and a model-voiced `sell()` that decides only what
is said. 826 tests, all passing. The PRD describes something considerably
larger.

Seven things were added, in dependency order. Each is real — it executes
against the database, it is covered by tests that assert values rather than
shapes, and where it depends on a credential this deployment does not have, it
returns nothing and says why instead of returning something plausible.

**1. An agent and skill domain model.** `Agent` and `AgentSkill` rows, and a
skill registry (`server/agents/registry.ts`) built as one array of declarative
specs plus a pure `run` — the same shape the channel registry already had.
Adding a skill is a file and a line, never a branch.

**2. One execution boundary.** `server/agents/execute.ts` is the only place a
skill runs, and every check lives there rather than inside the skills: the
skill exists, the agent is this workspace's, it holds the skill, it is enabled,
the arguments satisfy the schema, nothing trips an escalation trigger, the
quote is inside the ceiling, the customer has no past-due invoices, the
approval policy allows it. A refusal is a value, not an exception.

**3. Five skills**, each schema-validated, guarded and audited:
`Inventory_Lookup`, `Discount_Calculator`, `Stripe_Invoice`, `Lead_Scoring`,
`Calendar_Negotiation`.

**4. The Personal PA twin.** `PaProfile`, `CalendarEvent` and
`SchedulingNegotiation`, plus pure scheduling arithmetic over working hours,
focus blocks, buffers, a daily ceiling and the owner's timezone — asserted
across a daylight-saving boundary.

**5. The bespoke SDK.** `web/sdk/` is `@lipi-ai/sdk-node`, mapped so the PRD's
own import line resolves verbatim. A `CustomSkill` produces exactly the
`SkillSpec` a built-in one does and runs through exactly the same executor, so
it cannot skip a single check.

**6. The website generator.** `POST /v1/builder/sites/generate` produces a
structure deterministically; blocks carry *bindings*, not data, so
`resolveBlocks()` reads live rows on every request; `/s/{slug}` actually serves
the site. The quote formula is a tokeniser and a Pratt parser, never `eval`.

**7. The Digital Twin rules the PRD states that nothing read.** A four-hour
reservation hold that lapses and gives stock back, the full
`Inquiry → Quoted → Confirmed → Paid → Packed → Shipped → Delivered` chain,
credit-risk flagging derived from payments, VIP routing, and a real
`PurchaseOrder` raised when a variant crosses its reorder point.

Plus four defects fixed that were nothing to do with the PRD, listed in §D.

---

## B. PRD coverage

Counted from `TRACEABILITY.md`, which has one row per requirement across ten
sections.

| | Count |
| --- | --- |
| Requirements inventoried | **80** |
| `VERIFIED` — a named test exercises the behaviour and passed | **30** |
| `IMPLEMENTED` — built and tested, one element outstanding | **20** |
| `IN_PROGRESS` | **4** |
| `BLOCKED_EXTERNAL_DEPENDENCY` — adapter built, live path needs a credential | **5** |
| `NOT_STARTED` | **21** |

Ten of the twenty-one not started are the §9 and §8.1 metrics, which are
accounted for individually in §G. The other eleven are three coherent areas:

- **Voice and telephony** (A-3, F-3, F-4, H-1, H-2, and the metrics that
  depend on them). No ASR, no VAD, no TTS, no SIP. This is the largest gap.
- **The graph and vector stores** (A-4 partly, E-17) — Neo4j and Pinecone.
  Grounding is keyword-ranked Postgres.
- **The Product & Fitment graph and the ABM twin** (E-5, E-7, E-14, E-15).

Everything else is either done or has a named external dependency.

Counts were taken with:

```
grep -oE '^\| [A-J]-[0-9]+ \|' docs/impl/TRACEABILITY.md | tr -d '| ' | sort -u | wc -l
grep -E '^\| [A-J]-[0-9]+ \|' docs/impl/TRACEABILITY.md \
  | awk -F'|' '{print $(NF-1)}' \
  | grep -oE 'NOT_STARTED|BLOCKED_EXTERNAL_DEPENDENCY|IN_PROGRESS|IMPLEMENTED|VERIFIED' \
  | sort | uniq -c
```

---

## C. Tests

All commands run from the repository root, which forwards into `web/`.

| Command | Result |
| --- | --- |
| `npm run lint` | **pass**, exit 0 |
| `npm run typecheck` | **pass**, exit 0 |
| `npm test` | **1147 passed / 1147**, 50 files, 194.7 s |
| `npm run build` | **success**, exit 0, 25.01 s, 119 routes |

Baseline for comparison: **826 passed / 826**, 37 files, 137.7 s.

### What was added

| File | Tests | Covers |
| --- | --- | --- |
| `test/agents.test.ts` | 36 | the registry, guardrails, and every check in the execution boundary |
| `test/scheduling.test.ts` | 22 | scheduling arithmetic, including DST and the buffer rule |
| `test/calendar.test.ts` | 11 | propose / counter / confirm, and PRD Use Case 2 |
| `test/agent-builder.test.ts` | 24 | the builder API, at both path prefixes |
| `test/prd-ingest.test.ts` | 13 | the PRD's ingest contract |
| `test/sdk.test.ts` | 26 | the PRD's fabrication quoter, asserted against hand-computed values |
| `test/formula.test.ts` | 23 | the quote language, two thirds of it about what it refuses |
| `test/sites.test.ts` | 28 | the three site phases and the deployment seam |
| `test/twin-rules.test.ts` | 22 | the four-hour hold, credit risk, VIP routing, auto-PO, the state machine |
| `test/use-case-1.test.ts` | 4 | PRD §6 Use Case 1, end to end |
| `test/route-tenancy.test.ts` | 96 | one assertion per route: it accounts for its tenant |
| `test/inbox-filter.test.ts` | 6 | the channel rail's server-side filter |
| `test/performance.test.ts` | 5 | the PRD acceptance criteria that can be measured |

311 tests added, and the 826 that were already here still pass.

### Regression

The pre-existing suite was not modified except where a behaviour deliberately
changed, and nothing was skipped, deleted or weakened. Two pre-existing tests
were touched:

- `test/webhook-delivery.test.ts` — the "starts at the moment of subscription"
  case kept its assertion and gained two neighbours that force the race it was
  failing intermittently.
- `test/helpers.ts` and `test/setup.ts` — new tables in `resetDatabase()`, and
  a rate-limit reset in the shared `beforeEach`.

One test harness bug was found and fixed: `test/dispatch.ts` collapsed repeated
query parameters with `set` instead of `append`, so every repeatable parameter
in the API (`?stage=`, `?status=`, `?channel=`) had never been tested with more
than one value.

---

## D. Important files changed, and why

### Fixed, unrelated to the PRD

| Where | What |
| --- | --- |
| `server/services/webhooks.ts` | A subscription's cursor came off the wall clock, so an event written in the same millisecond was replayed to an endpoint promised no history. It now comes off the log. The suite failed this about one run in twenty. |
| `server/sites/formula.ts` | Two holes found by writing tests: `name in scope` was true for `__proto__`, `constructor` and `toString`, and source length was not a bound on recursion depth. |
| `server/lib/auth-throttle.ts` | `/v1/auth/login` and `/v1/auth/signup` were the only unauthenticated write endpoints with no ceiling. |
| `app/dashboard/inbox/*` | The thread list rendered inert `<li>`s and the page always opened the newest conversation — a selector that selected nothing, unreachable by keyboard. |

### Added

`server/agents/` (registry, execute, guardrails, twin-store, scheduling,
templates, deploy, five skills) · `server/sites/` (formula, structure,
generate, hosting, theme) · `server/services/reservations.ts` ·
`server/services/twin-rules.ts` · `server/lib/payments.ts` · `web/sdk/` ·
seventeen route modules · `app/s/[slug]/` · three migrations.

### Changed

`services/ingest.ts` gained the twin rules inside its existing transaction —
no write was added outside it. `services/invoicing.ts` was split so a skill can
invoice inside a transaction the executor already opened, rather than nesting
one. `v1/contract.ts` and `docs/openapi.json` gained two order stages.

---

## E. External dependencies

Nothing below is faked. Each has a clean adapter, a deterministic test
implementation, and a provider that returns *nothing and a reason* when the
credential is absent.

| What | Needs | What happens without it |
| --- | --- | --- |
| Stripe | `STRIPE_SECRET_KEY` | The invoice is still real — a row, a gap-free number, a downloadable PDF. `checkoutUrl` is `null` with the reason, and `checkout.link_unavailable` is on the event trail. |
| Edge hosting | `VERCEL_TOKEN` / `CLOUDFLARE_API_TOKEN` | The site is still served at `/s/{slug}`. `edge.ok` is false with the reason. No CDN, domain or certificate. |
| Google Calendar | OAuth credentials | The PA twin, the arithmetic and the negotiation all work against `CalendarEvent` rows. Nothing syncs outward. |
| Google reviews | a connector | The block resolves to an empty list and a stated reason. No testimonials are invented. |
| ASR / VAD / TTS / SIP | providers and a GPU or a Twilio account | Nothing. See §F. |
| Slack, LinkedIn, Zoom/Teams | provider apps | Not built. Deploy refuses to publish an agent to an unconnected channel. |
| Neo4j, Pinecone | the services | Grounding is keyword-ranked Postgres. |

---

## F. Remaining limitations

Stated plainly, because a reader who finds one of these themselves will
reasonably distrust everything above it.

**1. There is no voice pipeline at all.** PRD §1, §6.3, §6.4, §8 and half of §9
describe streaming ASR, VAD turn-taking, prosody analysis, PII/PHI redaction,
voice cloning and SIP trunking. None of it exists. `services/voice.ts` is
*brand* voice — formality and banned phrases — and always was. `BLOCKERS.md`
B-007.

**2. PII/PHI detection and redaction are not implemented.** `extract.ts`
pattern-matches contact details in order to *store* them, which is the opposite
operation. Use Case 3 is not delivered.

**3. The Agent Studio canvas and the Web Customizer are not built.**
Everything they would edit is a row behind a tested API, and both are editable
over HTTP today. The canvas and the block editor are not. `BLOCKERS.md` B-011.

**4. Four of the PRD's eight channels are missing** — Slack, phone/VoIP,
LinkedIn, Zoom/Teams. `BLOCKERS.md` B-010.

**5. No graph or vector store.** Grounding is keyword ranking over Postgres,
budgeted to 8000 characters. It works and it is not Graph-RAG.

**6. The Product & Fitment graph and the ABM twin do not exist.** No
Make/Model/Year/VIN traversal, no superseded part numbers, no org chart or
buying-intent score.

**7. Gmail inbound is dead while the channel presents as live.** Found during
discovery, pre-existing, and *not fixed here*: `upsertTrigger()` is implemented
and never called. A connected Gmail shows "Live" and delivers nothing. It is in
`REPO_MAP.md` and in `ARCHITECTURE.md`'s priorities.

**8. `matchVariant()` loads every product and variant on every message**,
inside the ingest transaction. Fine at seeded scale — 10.2 ms — and a full
table scan at fifty thousand variants. The code documents it; the measurement
in `PERFORMANCE.md` explicitly does not extrapolate.

**9. Rate limits are per process and in memory.** Horizontally scaled, each
instance enforces its own. Model *spend* is unaffected — that is counted in
Postgres.

**10. `recordEvent()` writes outside its caller's transaction.** Pre-existing;
a rollback leaves an event claiming something that did not happen. No new code
does this.

**11. The Python SDK does not exist.** The TypeScript half is complete. The
Python half is an HTTP client against `/v1/agents/{id}/execute` rather than an
in-process library, and that is a design decision worth making deliberately.

**12. Model-written copy is not generated for sites.** The structure produces
the slots; nothing fills them yet.

---

## G. Acceptance criteria

PRD §9, each marked exactly once. No metric is claimed that was not measured.

| Criterion | Verdict | Evidence |
| --- | --- | --- |
| Site build < 180 s | **VERIFIED** | 3.6 ms median. `test/performance.test.ts`. Caveat: this is structure generation, not a static export or CDN propagation, neither of which exists |
| Agent deploy < 2 min | **VERIFIED** | 5.8 ms median, same file |
| Custom tool overhead < 120 ms | **VERIFIED** | 1.4 ms median, measured as executor cost above a bare handler |
| 50+ modular skills | **NOT VERIFIED** | five are implemented; the registry makes the fiftieth cheap, which is not the same as having it |
| WER < 5% | **NOT VERIFIED** | no ASR (B-007) |
| 80% auto-resolution | **NOT VERIFIED** | needs a labelled corpus and an agreed definition of "resolved" |
| Intent F1 > 0.92 | **NOT VERIFIED** | needs a labelled corpus; the extractor is tested for correctness on named cases, not scored |
| Sub-400 ms voice turn-taking | **NOT VERIFIED** | no voice pipeline (B-007) |
| SOC 2 / HIPAA BAA ready | **NOT VERIFIED** | `SECURITY_REVIEW.md` documents what is implemented and makes no compliance claim. Certification is a process and infrastructure question |
| UI response < 150 ms | **REQUIRES PRODUCTION VALIDATION** | needs a browser against a deployed origin |
| Streaming > 35 tokens/sec | **NOT VERIFIED** | replies are not streamed |
| 4× faster quote-to-cash | **NOT VERIFIED** | a business outcome, not measurable in a repository |
| 56:1 LTV:CAC | **NOT VERIFIED** | likewise |

### PRD §6 use cases

| | Verdict |
| --- | --- |
| **1 — Autonomous conversational commerce** | **VERIFIED**. The PRD's own sentence drives extraction, the 600-in-stock check, the $8.40 floor, the credit check, 400 units locked under a four-hour hold, the checkout link, the WhatsApp reply, the signed ERP push and twelve named events. `test/use-case-1.test.ts` |
| **2 — Agentic personal assistant** | **VERIFIED except the Google Calendar write**. The PRD's sentence drives propose → confirm; every offered slot is asserted 45 minutes, next week, not a morning in the owner's zone, and buffer-clear of a real booking. `test/calendar.test.ts` |
| **3 — Regulated meeting intelligence** | **NOT DELIVERED**. No audio, no redaction. No compliance claim is made |
| **4 — Inbound phone reception** | **NOT DELIVERED**. Grounded answers exist in text; telephony, voice and SMS do not |

---

## Where to look

| | |
| --- | --- |
| `PROGRESS.md` | the baseline, the milestone ledger, every verification command and its result |
| `TRACEABILITY.md` | one row per PRD requirement, with the test that proves it |
| `DECISIONS.md` | 23 decisions, each with the alternatives rejected and why |
| `BLOCKERS.md` | 11 entries: what is missing, what stands in for it, what it would take |
| `SECURITY_REVIEW.md` | 7 findings, 4 fixed; and what was reviewed and found sound |
| `PERFORMANCE.md` | every measurement, with the command that produced it |
| `REPO_MAP.md` | what the repository was before any of this |
