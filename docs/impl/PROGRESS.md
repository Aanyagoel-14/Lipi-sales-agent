# PROGRESS

Durable state for the PRD-completion effort. Updated at every milestone, never
only at the end. If you are resuming after a compaction, read this file, then
`TRACEABILITY.md`, `DECISIONS.md` and `BLOCKERS.md`, then re-read the PRD
section named under "Next step".

---

## Current phase

**Complete.** `FINAL_REPORT.md` is written. Everything that was built is
verified; everything that was not is named in `BLOCKERS.md` and marked in
`TRACEABILITY.md`. M2, M3, M4, M6, M7, M8 and M9 are done.

## Next step

For whoever picks this up: the largest remaining gap is the voice pipeline
(`BLOCKERS.md` B-007), and the cheapest remaining win is Slack — the channel
registry makes it a spec and two pure functions, and it is the only one of the
four missing channels that needs no new infrastructure (B-010).

---

## Baseline (recorded 2026-09-21, branch `sandcastle/integration` @ `be970c0`)

All commands run from the repository root; the root `package.json` forwards
each into `web/`.

| Command | Result | Notes |
| --- | --- | --- |
| `npm run lint` | **pass**, exit 0 | eslint, no output |
| `npm run typecheck` | **pass**, exit 0 | *only after* `npx prisma generate` — see below |
| `npm test` | **823 passed / 1 failed** of 824, 37 files, 139.6s | the one failure is analysed below |

Logs: `docs/impl/logs/baseline-lint.txt`, `baseline-typecheck.txt` (stale
client), `baseline-typecheck2.txt` (after generate), `baseline-test.txt`.

### Environment notes discovered during baseline

- Postgres 15 is running via `brew services`, but its binaries are **not on
  `PATH`**. Prefix commands with
  `export PATH="/opt/homebrew/opt/postgresql@15/bin:$PATH"`.
- `lipi_dev` **and** `lipi_test` both exist. `CLAUDE.md` says `lipi_test` does
  not — that claim is stale.
- `web/src/generated/` is gitignored and was **stale** on checkout: it
  predated the `20260921000000_x_dm_channel` and `20260920233000_contact_capture`
  migrations, which produced 54 phantom `tsc` errors (`Type '"x"' is not
  assignable to type 'Channel'`, `Property 'emailSource' does not exist`).
  `npx prisma generate` in `web/` clears all 54. Nothing in the committed
  source was wrong. Any fresh clone needs `npm ci` (whose `postinstall` runs
  `prisma generate`) before `typecheck` means anything.

### Baseline defect found and fixed

`test/webhook-delivery.test.ts > the queue > starts at the moment of
subscription` failed in the full run and passed in isolation — a real race,
not a flaky assertion.

- **Root cause.** `subscribe()` set the delivery cursor from the wall clock
  (`cursorAt: new Date()`, `cursorId` defaulting to `""`). `TwinEvent.occurredAt`
  has millisecond resolution, so an event written in the same millisecond as the
  subscription satisfied the keyset's tie-break branch
  (`occurredAt == cursorAt AND id > ""`) and was replayed to an endpoint that
  had explicitly been promised no history.
- **Fix.** `web/src/server/services/webhooks.ts:65` — the cursor is now read off
  the newest event in the log (`(occurredAt, id)` of the last row), falling back
  to `new Date()` only when the workspace has no events at all.
- **Evidence.** Two new tests in `test/webhook-delivery.test.ts` pin the clock
  with `vi.useFakeTimers({ toFake: ["Date"] })` so the collision is forced
  rather than raced for. Reverting the fix makes
  `does not replay events written in the same millisecond it was created` fail
  with `expected [ 'before', 'after' ] to deeply equal [ 'after' ]`; with the fix
  the file is 30/30.

---

## Verification log

| When | Command | Result |
| --- | --- | --- |
| baseline | `npm run lint` | exit 0 |
| baseline | `npm run typecheck` (after `prisma generate`) | exit 0 |
| baseline | `npm test` | 823/824, 1 pre-existing race |
| after webhook fix | `npx vitest run test/webhook-delivery.test.ts` | 30/30 |
| after webhook fix, reverted impl | same, `-t "same millisecond"` | 1 failed — regression test proven |
| M1 checkpoint | `npm run lint` | exit 0 |
| M1 checkpoint | `npm run typecheck` | exit 0 |
| M1 checkpoint | `npm test` | **826 passed / 826**, 37 files, 137.7s |
| M2/M3/M4 checkpoint | `npm run lint` / `typecheck` | exit 0 / exit 0 |
| M2/M3/M4 checkpoint | `npm test` | **932 passed / 932**, 42 files, 154.8s |
| M8 checkpoint | `npm run lint` / `typecheck` | exit 0 / exit 0 |
| M8 checkpoint | `npm test` | **981 passed / 981**, 44 files |
| M9 checkpoint | `npm run lint` / `typecheck` | exit 0 / exit 0 |
| M9 checkpoint | `npm test` | **1010 passed / 1010**, 45 files, 169.6s |
| M5 checkpoint | `npm test` | **1136 passed / 1136**, 48 files, 207.4s |
| final | `npm run lint` / `typecheck` | exit 0 / exit 0 |
| final | `npm test` | **1147 passed / 1147**, 50 files, 194.7s |
| final | `npm run build` | **success**, exit 0, 25.01s, 119 routes |
| final | `npx vitest run test/performance.test.ts` | 5/5; site 3.6ms, deploy 5.8ms, tool overhead 1.4ms |

### A second self-inflicted bad run

An `npm test` taken while a *second* vitest was running in the foreground
reported 173 failures. `test/ci.test.ts` creates and drops a probe database;
`DROP DATABASE` blocks while any connection to it is open, the `beforeAll`
hook timed out at 60s, and every subsequent file failed on a broken pool. The
same thing happened once more when `prisma generate` was run mid-suite.

Two rules for this repository, learned the hard way: **never run two vitest
processes at once**, and **never regenerate the Prisma client while the suite
is running**. The suite talks to one real Postgres with `fileParallelism:
false`; it is a shared resource and has to be treated as one.

### A note on a misleading run

An `npm test` invocation taken while three discovery subagents were still
running reported 7 failures across `catalogue`, `model-budget`, `selling` and
`shopify`. Every one was infrastructure — `deadlock detected` on the
`TRUNCATE` in `resetDatabase()`, 60s hook timeouts, and a unique-constraint
violation caused by a reset that had timed out. Re-run on an idle machine the
same suite is 826/826. The suite talks to one real Postgres with
`fileParallelism: false`; it is not safe to treat a run taken under heavy
concurrent load as a signal.

---

## Milestone plan

Dependency-ordered, following master prompt §5, adjusted to this repository's
architecture (one Next.js deployable, Postgres + Prisma, a deterministic
`ingest()` core with a model-voiced `sell()` layer).

| # | Milestone | State |
| --- | --- | --- |
| M0 | Baseline recorded; pre-existing webhook cursor race fixed | **done** |
| M1 | `REPO_MAP.md` + `TRACEABILITY.md` | **done** |
| M2 | Agent & Skill domain model — registry/plugin pattern, templates, guardrails | **done** |
| M3 | Builder API — `POST /v1/agents/builder/deploy`, templates, skill catalogue | **done** |
| M4 | `POST /v1/conversations/ingest` to the PRD's contract | **done** |
| M5 | Digital Twin completion — order state machine, 4h reservation hold, credit/margin/VIP rules, supplier auto-PO | **done** — the fitment graph (E-5, E-7) is not built |
| M6 | The five named PRD skills, each schema-validated, guarded and audited | **done** (folded into M2) |
| M7 | Personal PA twin + calendar adapter + negotiation (Use Case 2) | **done** — Google Calendar sync is still open, see `BLOCKERS.md` |
| M8 | Bespoke SDK (TypeScript) + fabrication pricing tests | **done** — Python parity outstanding |
| M9 | Website generator — `POST /v1/builder/sites/generate`, twin binding, deployment config, **and the site actually served** | **done** — edge hosting is `BLOCKERS.md` B-005 |
| M10 | Voice + conversation intelligence — ASR/VAD/TTS adapters, `AUDIO_INTERRUPT`, PII/PHI redaction (Use Cases 3, 4) | not started |
| M11 | Remaining PRD channels — Slack, phone/VoIP, LinkedIn, Zoom/Teams | **not built** — see `BLOCKERS.md` |
| M12 | UI — split-pane workspace fixed (thread selection + channel rail); Agent Studio canvas and Web Customizer **not built** | partial |
| M13 | Security review, tenancy tests, performance measurement, final PRD audit, `FINAL_REPORT.md` | **done** — 7 findings, 4 fixed |

Each row is a checkpoint under §0.2: suite green, the four state files updated,
one commit.


---

## What M2, M3, M4, M6, M7 and M8 delivered

**New, and each of them genuinely executing against the twins rather than
describing itself:**

| | |
| --- | --- |
| `web/src/server/agents/registry.ts` | one array of declarative skill specs plus a pure `run`, modelled on `server/channels/registry.ts`. Adding a skill is a file and a line. |
| `web/src/server/agents/execute.ts` | the only place a skill runs, and the security boundary: nine checks, in order, all before `run()` or all before the result is visible. |
| `web/src/server/agents/guardrails.ts` | per-agent ceilings, parsed from either the PRD's snake_case or camelCase, defaulting to the cautious reading. |
| `web/src/server/agents/twin-store.ts` | the narrow view of the twin a skill may touch. No `prisma`, no `workspaceId` parameter anywhere. |
| `web/src/server/agents/scheduling.ts` | pure scheduling arithmetic — working hours, focus blocks, buffers, daily ceiling, timezone, DST. |
| `web/src/server/agents/templates.ts` | the PRD's four templates, as data. |
| `web/src/server/agents/deploy.ts` | validated deploy, upserting on `(workspace, name)`. |
| `web/src/server/lib/payments.ts` | the Stripe seam: a real link, or none and the reason. |
| `web/sdk/` | `@lipi-ai/sdk-node`, resolving at the PRD's own import path. |

**Five skills**, each with an argument schema, guardrails, audit and tests:
`Inventory_Lookup`, `Discount_Calculator`, `Stripe_Invoice`, `Lead_Scoring`,
`Calendar_Negotiation`.

**Endpoints:** `POST /v1/agents/builder/deploy`, `GET /v1/agents/templates`,
`GET /v1/agents/skills`, `GET /v1/agents`, `GET|PATCH|DELETE /v1/agents/{id}`,
`POST /v1/agents/{id}/execute`, `POST /v1/conversations/ingest` — the last two
of those also at the PRD's `/api/v1/...` spelling.

**One migration**, `20260923090000_agents_and_skills`: `agents`,
`agent_skills`, `pa_profiles`, `calendar_events`, `scheduling_negotiations`,
and two nullable columns on `agent_runs`.

**Tests added:** `test/agents.test.ts` (36), `test/scheduling.test.ts` (22),
`test/calendar.test.ts` (11), `test/agent-builder.test.ts` (24),
`test/prd-ingest.test.ts` (13), `test/sdk.test.ts` (26).
