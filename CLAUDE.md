# CLAUDE.md — how to implement a phase

This repo is being built out phase by phase. The plan lives **outside the repo**, at
`~/Desktop/Lipi-plan/`:

```
~/Desktop/Lipi-plan/
├── HANDOFF.md                  the gap register — what is not built and why
├── PHASE_PLAN.md               the master index: 36 phases, 4 milestones, ledger, decisions
└── phases/
    ├── INDEX.md
    ├── phase-00-baseline-safety-net.md
    ├── phase-01-read-side-unlock.md
    └── … through phase-35
```

One phase = one session ≈ **150k tokens**. Read only that phase's file. Everything needed to
execute it is in there; it is written to be self-contained precisely so the session does not
have to load the master plan or the register.

---

## The protocol

### 1. Start clean

Fresh session, no carried context. Read, in this order:

1. `~/Desktop/Lipi-plan/phases/phase-NN-*.md` — the only plan file you need
2. The files that phase's **Files** table names
3. The tests that already cover them

Do **not** read `HANDOFF.md` or `PHASE_PLAN.md` during execution. Their content is already
distilled into the phase file, and re-reading them costs 20k tokens for nothing.

### 2. Confirm the ground truth before editing

Every phase file states a **Current state**. It was written on 2026-09-17. Verify the two or
three claims it depends on before you build on them — a line number moves, a field gets renamed.
If reality differs, say so in the PR and adjust; do not implement against a stale premise.

### 3. Branch

```
git checkout -b phase-<N>-<slug>      # slug is in the phase file's header table
```

Never work on `main`.

### 4. Work the tasks in order

They are ordered by dependency, not by size. The **Do not** section of each phase file is the
part most likely to cost a day if ignored — read it before the first edit, not after.

### 5. Migrations

```
npm run db:migrate         # generates and applies against lipi_dev
```

One migration per phase at most. Backfills must be idempotent — assume they run twice.

### 6. Tests

Write the tests the phase file names, plus whatever the implementation revealed. Then:

```
npm run lint
npm run typecheck
npm test
```

All three green before committing. A skipped test is a failed test.

### 7. Budget discipline

If the session passes **~120k tokens** and the suite is not green: stop, commit what is green,
and move the remainder into a phase `N.5` file in `~/Desktop/Lipi-plan/phases/`. Do not spill
into the next phase's budget — the sizing only works if each phase holds its edges.

Signs you are over budget: re-reading a file you already read, running the full suite more than
three times, or exploring code no task in the phase names.

### 8. Commit and hand off

```
git commit        # end the message with the Co-Authored-By line the session specifies
gh pr create      # end the body with the Generated-with line
```

Then:

- tick the phase's row in the ledger in `~/Desktop/Lipi-plan/PHASE_PLAN.md`
- write the phase's **Hand to next** facts into the next phase's file, under a
  `## Notes from the previous phase` heading
- record every decision the phase forced, with the alternatives rejected

The handoff note is not optional. It is the only channel between two sessions that share no
context.

---

## Working commands

| | |
| --- | --- |
| `npm run dev` | Next.js on http://localhost:3000 |
| `npm test` | vitest, full suite |
| `npm run lint` / `npm run typecheck` | must both pass |
| `npm run db:migrate` / `db:seed` / `db:studio` | Prisma |

All of these run from `web/`, not the repo root.

**Local environment as last left running:** Postgres 15 via `brew services`, port 5432,
database `lipi_dev`, 7 migrations applied and seeded. Dashboard login `demo@lipi.test` /
`lipidemo123`. `web/.env` points at local Postgres and holds live secrets — it is gitignored and
must never be committed or echoed into output. The Supabase pooler is unreachable from this
network; the old value is kept commented in `.env`.

`lipi_test` does not exist yet — Phase 0 creates it.

---

## Invariants — every phase, no exceptions

These are the properties that make the existing code trustworthy. A phase that breaks one has
failed even if its own tests pass.

1. **Transactional ingest.** A message mutates all twins or none. Never add a write outside the
   `$transaction` in `ingest()`.
2. **Fact/voice split.** `ingest()` decides what is TRUE; `sell()` decides what is SAID. The
   model never computes a price, total, stock figure or discount. If a feature needs a number,
   compute it deterministically and hand it to the model as a fact.
3. **First-touch attribution.** Never overwritten by a later touch.
4. **Money is integer paise.** No floats, no conversion in the display layer, no client-supplied
   amounts.
5. **Tenant scoping.** Every query filtered by `workspaceId`. `test/tenancy.test.ts` stays green.
6. **Append-only `TwinEvent`.** Events are evidence. Never updated, never deleted.
7. **Green before commit.** lint, typecheck, full suite.

## House style

- Match the surrounding code — naming, comment density, idiom. This codebase is consistent;
  keep it that way.
- Colours come from the Phase 12 token layer once it exists. No literal hex after that.
- Next.js here is version 16 with breaking changes from older conventions — `web/AGENTS.md`
  says to read `node_modules/next/dist/docs/` before writing routing or rendering code. Do it.
- Prefer extending an existing service over adding a parallel one. The repo has one order path,
  one retrieval path, one connector framework per direction — keep it that way.

## Decisions

Eight decisions are listed at the end of `PHASE_PLAN.md`, each mapped to the phase that forces
it. Defaults are already chosen so no phase blocks on a question. If you overturn a default,
record the reasoning in the PR — the plan's ordering may depend on it.

Decisions 1, 2 and 3 (Phase 1 target, when voice happens, whether the graph migration happens)
change the **order** of milestones rather than their contents. They should be settled before
Phase 0 closes.

## Agent skills

### Issue tracker

Issues live as GitHub issues on the fork `Aanyagoel-14/Lipi-sales-agent`, not on
`origin` (`kritucapital/Lipi-sales-agent`). See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles, each label string equal to its name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
