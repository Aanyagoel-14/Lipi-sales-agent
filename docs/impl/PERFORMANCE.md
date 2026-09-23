# PERFORMANCE

Every figure here was measured on this machine, by a command written next to
it, and copied from the output. Nothing is estimated and nothing is projected.

**`MEASURED LOCALLY`** — a development laptop, local Postgres 15, no model in
the loop, no network. It is a real measurement of this code and it is **not** a
production figure. A deployed system adds network latency, connection-pool
contention, cold starts and — on any model-backed path — a provider's own
response time, which dominates everything below.

**`REQUIRES PRODUCTION INFRASTRUCTURE VALIDATION`** — cannot be established
here, and no number is offered for it.

Environment: Darwin 23.5.0 (arm64), Node v25.6.1, Postgres 15 on localhost,
`lipi_test`.

---

## PRD §9 acceptance criteria

### Measured

| PRD criterion | Budget | Measured | Verdict |
| --- | --- | --- | --- |
| I-1 Site build | < 180 s | **3.6 ms** (median of 5) | **VERIFIED** |
| I-2 Agent deploy | < 2 min | **5.8 ms** (median of 5) | **VERIFIED** |
| I-7 Custom tool overhead | < 120 ms | **1.4 ms** (median of 21) | **VERIFIED** |

Command: `npx vitest run test/performance.test.ts --reporter=verbose`
(from `web/`). The thresholds are asserted, so a regression past the PRD's own
budget fails CI; the measurements are printed so this file can quote a figure
somebody saw.

Two caveats that matter more than the numbers:

- **"Site build" here means generating and persisting the structure**, which
  is what `POST /v1/builder/sites/generate` does. It does not include a static
  export or an edge deployment, because neither exists — see `BLOCKERS.md`
  B-005. The PRD's 180 seconds was plainly budgeted for an LLM writing copy
  and a CDN propagating; three milliseconds is the deterministic part of that,
  and the honest reading is "the part that was built is not the part that will
  cost 180 seconds".
- **"Custom tool overhead" is measured as a difference**, not a wall clock:
  the same handler called through `executeSkill()` minus the same handler
  called directly. That difference is what the executor costs — the
  allowed-tool check, the schema parse, the transaction, the guardrails, the
  `AgentRun` row and the events — which is what the PRD's figure is about.
  Measuring a skill that does real work would be measuring the work.

### Not measured, and why

| PRD criterion | Status |
| --- | --- |
| I-3 Word error rate < 5% | **NOT VERIFIED** — no ASR exists (`BLOCKERS.md` B-007) |
| I-4 80% auto-resolution | **NOT VERIFIED** — needs a labelled corpus of real conversations and an agreed definition of "resolved" |
| I-5 Intent F1 > 0.92 | **NOT VERIFIED** — needs a labelled corpus; the extractor is tested for correctness on specific cases, not scored |
| I-6 Sub-400 ms voice turn-taking | **NOT VERIFIED** — no voice pipeline |
| I-8 SOC 2 / HIPAA BAA ready | **NOT VERIFIED** — a process and infrastructure question, not a code one |
| I-9 4× faster quote-to-cash | **NOT VERIFIED** — a business outcome |
| I-10 56:1 LTV:CAC | **NOT VERIFIED** — a business outcome |

`G-6` (UI response < 150 ms) and `G-7` (streaming > 35 tokens/sec) are also
not verified: §8.1's UI budget needs a browser and a deployed origin, and
replies are not streamed at all.

---

## What the rest of the system costs

`MEASURED LOCALLY`. Not PRD criteria — the numbers everything above sits on.

| Operation | Measured | Notes |
| --- | --- | --- |
| `ingest()`, one inbound message | **10.2 ms** (median of 7) | the whole deterministic loop in one transaction: extract, match, reserve, order, events, agent runs, reply |
| `Inventory_Lookup` end to end | **2.8 ms** (median of 11) | through the full executor, including its transaction and audit rows |

`ingest()` is the number to watch. It is the hot path — every inbound message
on every channel goes through it — and it currently loads **every product and
every variant** for the workspace on each call, a limitation the code itself
documents in `matchVariant`'s comment in `services/ingest.ts`. At the seeded
scale that is the 10 ms above. At fifty thousand variants it is a full table
scan holding a transaction open on every customer message, and the honest
statement is that this figure does not extrapolate.

---

## Build

`MEASURED LOCALLY`. Command: `/usr/bin/time -p npm run build` (from `web/`).

| | |
| --- | --- |
| Production build | **25.01 s** real, 64.20 s user |
| Result | success, exit 0 |
| Routes compiled | 119 |

The build is listed here because it is also the evidence for §43's "the
repository builds": every route added by this effort appears in the output,
including `/s/[slug]`, `/s/[slug]/[...path]`, the six `/v1/builder/sites/*`
routes, the seven `/v1/agents/*` routes and the three `/api/v1/*` aliases.

---

## Test suite

`MEASURED LOCALLY`. Command: `npm test` (from the repository root).

| | |
| --- | --- |
| Baseline, before this effort | 826 tests, 37 files, 137.7 s |
| Now | **1147 tests, 50 files, 194.7 s** |

The suite runs against a real Postgres with `fileParallelism: false`, so its
duration is dominated by sequential database round trips rather than by CPU.

**A measurement hazard worth recording**, because it cost two bad runs: a
figure taken while a second vitest process or a `prisma generate` was running
is not a measurement of anything. Both produced cascades of failures —
`deadlock detected` on the `TRUNCATE` in `resetDatabase()`, 60-second hook
timeouts — that look like logic failures and are not. One test run at a time.
