# PROGRESS

Durable state for the PRD-completion effort. Updated at every milestone, never
only at the end. If you are resuming after a compaction, read this file, then
`TRACEABILITY.md`, `DECISIONS.md` and `BLOCKERS.md`, then re-read the PRD
section named under "Next step".

---

## Current phase

**M2 — Agent & Skill domain model.** Discovery is complete: `REPO_MAP.md` and
`TRACEABILITY.md` are written and M1 is committed.

## Next step

Finish `web/src/server/agents/` — registry, executor, the five PRD skills and
the four templates — then the builder deploy endpoint (M3).

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
| M2 | Agent & Skill domain model — registry/plugin pattern, templates, guardrails | in flight |
| M3 | Builder API — `POST /v1/agents/builder/deploy`, templates, skill catalogue | not started |
| M4 | `POST /v1/conversations/ingest` to the PRD's contract | not started |
| M5 | Digital Twin completion — order state machine, 4h reservation hold, customer credit/margin/VIP rules, fitment graph, supplier auto-PO | not started |
| M6 | The five named PRD skills, each schema-validated, guarded and audited | not started |
| M7 | Personal PA twin + calendar adapter + negotiation (Use Case 2) | not started |
| M8 | Bespoke SDK (TypeScript, then Python parity) + fabrication pricing tests | not started |
| M9 | Website generator — `POST /v1/builder/sites/generate`, twin binding, deployment config | not started |
| M10 | Voice + conversation intelligence — ASR/VAD/TTS adapters, `AUDIO_INTERRUPT`, PII/PHI redaction (Use Cases 3, 4) | not started |
| M11 | Remaining PRD channels — Slack, phone/VoIP, LinkedIn, Zoom/Teams | not started |
| M12 | UI — split-pane workspace, Agent Studio canvas, Web Customizer, PRD design tokens | not started |
| M13 | Security review, tenancy tests, performance measurement, final PRD audit, `FINAL_REPORT.md` | not started |

Each row is a checkpoint under §0.2: suite green, the four state files updated,
one commit.
