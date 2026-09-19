# HANDOFF — running the Sandcastle orchestration loop

This document is the operating manual for the autonomous loop that works the backlog in
`docs/Priority-list.md`. It assumes no context from the session that set it up.

The loop is **not** the phase protocol in `CLAUDE.md`. That protocol is for a human-driven
session working one phase from `~/Desktop/Lipi-plan/`. This is a different thing running against
a different backlog: GitHub issues labelled `sandcastle` on the fork. Both are live. Do not let
an agent working a phase and the loop edit the same files at the same time.

---

## 1. What the loop does

`.sandcastle/main.mts` runs up to `MAX_ITERATIONS` (10) cycles. Each cycle is three phases:

| Phase | Agents | Iterations | What it does |
| --- | --- | --- | --- |
| **Plan** | 1 | 1 | Reads every open `sandcastle` issue plus GitHub's own blocking graph, and emits a `<plan>` JSON of the issues that are unblocked right now, each with a deterministic branch `sandcastle/issue-N`. |
| **Execute + Review** | 2 per issue, all issues in parallel | 100 / 1 | One Docker sandbox per issue. The implementer works the issue red-green-refactor and commits; if it produced commits, a reviewer runs in the same sandbox on the same branch and tidies. |
| **Merge** | 1 | 1 | In a worktree on a temporary branch, merges every branch that produced commits, resolves conflicts, runs the checks, and closes the issues it merged; Sandcastle then fast-forwards the host's current branch to the result. |

Because the branch name is derived from the issue number, an issue that is not finished in one
cycle resumes on the same branch in the next one with its work intact.

## 2. Preconditions

| | Check | State as of 2026-09-19 |
| --- | --- | --- |
| Docker daemon | `docker info` | up, v29.8.0 |
| Sandbox image | `docker images sandcastle:lipi-sales-agent` | built, 4.4 GB — includes the app's dependency tree |
| `gh` authenticated | `gh auth status` | logged in as `Aanyagoel-14` |
| Fork remote | `git remote -v` | `fork` → `Aanyagoel-14/Lipi-sales-agent` |
| Tokens | `.sandcastle/.env` | `CLAUDE_CODE_OAUTH_TOKEN` and `GH_TOKEN` both set |
| Baseline green | `npm run check` | 383 tests, lint and typecheck all passing |

`.sandcastle/.env` is gitignored and holds live credentials. Never commit it, never echo it.

Rebuild the image after any change to `.sandcastle/Dockerfile`, and after `web/package-lock.json`
changes on the integration branch:

```
./node_modules/.bin/sandcastle docker build-image --dockerfile .sandcastle/Dockerfile
```

Use that command, not `docker build` directly: it passes the host UID/GID as build args so the
bind-mounted worktree and the image's files share an owner, and it uses the repo root as the build
context, which the Dockerfile's `COPY web/...` lines depend on. A stale image is not fatal — a
sandbox whose lockfile differs from the image's installs its own tree from the image's npm cache —
it is just slower to start (about 80 s instead of 6 s).

## 3. Run it

```
cd ~/Desktop/Lipi-sales-agent
git checkout sandcastle/integration     # the merge phase merges into whatever branch you are on
npm run sandcastle
```

To run everything on a different model:

```
SANDCASTLE_MODEL=claude-sonnet-5 npm run sandcastle
```

**Stay on `sandcastle/integration`.** The merge agent merges into the host's active branch. On
`main` that violates `CLAUDE.md`; on `phase-c3-inbound` it would push commits onto an open PR.

Logs land in `.sandcastle/logs/`, worktrees in `.sandcastle/worktrees/`. Both are gitignored.

## 4. The queue

25 issues, `#6`–`#30`, all labelled `sandcastle`, one per deliverable in `docs/Priority-list.md`.
Each body carries: why the gap exists in *this* codebase with the file that proves it, what to
build, acceptance criteria, the files to touch, the invariants that apply, and a `Do not`
section.

Blocking is recorded twice, on purpose: as a `Blocked by: #N` line in the body, and as GitHub's
own native issue dependencies. The planner is told to treat the native graph as authoritative
and to use its own judgement only for file-overlap conflicts the graph cannot know about.

**Wave 1 — the five issues that are unblocked right now:**

| # | Title |
| --- | --- |
| 6 | P0: CI pipeline — lint, typecheck and the full suite against a real Postgres |
| 7 | P0: Automated tests for webchat, leads, attribution and rate limiting |
| 8 | P2: Capture the visitor at page load, not when the chat panel opens |
| 14 | P3: API keys and server-to-server authentication for /v1 |
| 15 | P6/P8: A real Shopify connector — OAuth, products, inventory, orders |

Everything else unlocks behind them. The critical path is
`#7 → #9 → #12 → #13`: get the webchat tested, route it through `sell()`, ground the
salesperson, then teach it to recommend. **#9 is the single highest-value issue in the set** —
`sell()` exists and works and has exactly one caller, the dashboard's own test page, so no real
customer has ever spoken to it.

Check what is ready at any moment:

```
gh issue list -R Aanyagoel-14/Lipi-sales-agent --state open --label sandcastle --json number --jq '.[].number' \
  | while read n; do gh api repos/Aanyagoel-14/Lipi-sales-agent/issues/$n \
      --jq 'select(.issue_dependencies_summary.blocked_by==0) | "#\(.number) \(.title)"'; done
```

## 5. Controlling scale and cost

The loop will start five sandboxes at once on the first cycle, each running an implementer for
up to 100 iterations on Opus. That is the expensive part. Three throttles, in order of
bluntness:

1. **Remove the label.** The planner only sees issues labelled `sandcastle`. Take the label off
   everything except the two or three you want worked, and the loop works those.
   `gh issue edit N -R Aanyagoel-14/Lipi-sales-agent --remove-label sandcastle`
2. **Lower `MAX_ITERATIONS`** in `.sandcastle/main.mts` — set it to 1 for a single
   plan → execute → merge cycle, which is the right setting for the first real run.
3. **Lower the implementer's `maxIterations`** from 100. It is a ceiling, not a target, but a
   stuck agent will spend all of it.

**Do the first run with `MAX_ITERATIONS = 1` and only `#6` and `#7` labelled.** Those two are
the cheapest, the most independent, and the ones whose output tells you whether the harness is
sound — if CI and the test suite come back green from a sandbox, everything else is just more of
the same. Read those two diffs yourself before letting the loop near the `sell()` path.

## 6. What was changed to make this runnable

The stock Sandcastle template did not fit this repo. Five things were wrong and are now fixed;
if you regenerate the template, you will have to redo them.

- **Wrong repo.** The plan prompt ran `gh issue list` with no `-R`, so it would have inferred
  `origin` — `kritucapital/Lipi-sales-agent`, the upstream, for which there is no token. Every
  `gh` call in every prompt now passes `-R`, and `GH_REPO` is set in the sandbox environment.
- **Wrong label.** The prompt filtered on `Sandcastle`; the label is `sandcastle`.
- **Wrong scripts.** The prompts run `npm run typecheck` and `npm test`, which live in `web/`,
  not at the repo root. The root `package.json` now delegates.
- **No database.** `web/vitest.config.mts` talks to a real Postgres and
  `web/test/global-setup.ts` refuses any URL not containing `lipi_test`. The base image had no
  database, so every agent's feedback loop would have died at the first `npm test`. The
  Dockerfile now installs Postgres, bakes in the `lipi_test` database and an `agent` role, and a
  sandbox hook starts the cluster. `sudo` had to be installed too — Sandcastle implements
  `sudo: true` by literally prefixing `sudo`.
- **Wrong `node_modules`.** The template copies the host's `node_modules` into each worktree to
  skip a cold install. This host is macOS and the sandbox is linux: Prisma's query engine and
  vitest's esbuild binary are platform-specific, and a later `npm install` will not repair a
  copied darwin tree because `package.json` is already satisfied. `copyToWorktree` is now empty.
  The first replacement — a hook running `npm ci` in every sandbox — was its own failure: one
  full registry download per sandbox, several in parallel per iteration, and the run died on
  the first `ECONNRESET`. The dependency tree is now baked into the image at
  `/opt/lipi/web/node_modules`, and `.sandcastle/sandbox-setup.sh` symlinks each worktree's
  `web/node_modules` to it, so a sandbox needs no registry access to start. If a branch's
  lockfile differs from the image's, the script installs that branch's tree with
  `--prefer-offline` from the npm cache the image build left behind; only genuinely new packages
  reach the network, and `~/.npmrc` in the image retries those five times.
- **Hooks on a head-mode run touch the host.** `sandcastle.run()` without a `branchStrategy`
  uses `head` mode, which bind-mounts this repo's own checkout into the container — not a
  worktree. The planner's `npm ci` hook therefore ran against the developer's machine and
  replaced the macOS `web/node_modules` with a Linux one, then with nothing when the download
  failed. Three changes make that unrepeatable: the planner has no hooks at all (it only reads
  issues); the merger runs with `branchStrategy: { type: "merge-to-head" }`, so it works in a
  worktree on a temporary branch that Sandcastle fast-forwards into the current branch when it
  finishes; and `sandbox-setup.sh` refuses to run anywhere `.git` is a directory rather than a
  worktree's pointer file.

**The prompts' `` !`...` `` interpolations run inside the container, not on the host.** So the
image must carry every tool a prompt shells out to. Four are load-bearing, and dropping any one
of them fails the run before an agent starts:

| Tool | Needed by |
| --- | --- |
| `gh` | every phase — the issue tracker is the loop's whole input and output |
| `jq` | the planner's blocker-graph query |
| `sudo` | Sandcastle implements `sudo: true` by prefixing the string |
| `postgresql` | `npm test`, in every sandbox |

Verified end to end inside the built image: both of the plan prompt's queries return (25 issues,
5 unblocked), `psql postgresql://agent@127.0.0.1:5432/lipi_test` connects as `agent`,
passwordless sudo works, `gh` authenticates from `GH_TOKEN`. Verified with the container's
network disabled (`docker run --network none`): a fresh worktree bootstraps in 6 s and then
passes lint, typecheck and all 383 tests; a worktree whose lockfile differs from the image's
bootstraps in 81 s from the cache alone.

## 7. Known risks

- **Migration collisions.** Eleven of the 25 issues add a Prisma migration. Two branches each
  adding one will merge cleanly in git and fail at deploy. The merge prompt now tells the merger
  to apply merged migrations in sequence against a clean `lipi_test`, but this is the failure
  most likely to escape. Prefer not to run two migration-bearing issues in the same cycle.
- **Shared-file conflicts.** `selling.ts`, `webchat.ts`, `widget.js` and `schema.prisma` are each
  touched by several issues. The dependency graph serialises the worst of it; the planner is
  asked to catch the rest.
- **Branch base.** `sandcastle/integration` is cut from `phase-c3-inbound`, which is 6 commits
  ahead of `main` with PRs #2–#5 still open. When those merge, merge `main` into
  `sandcastle/integration` before the next run.
- **`#15` (Shopify) is the largest issue in the set** and is unblocked from the start, so the
  planner will pick it up in wave 1. It is a multi-day piece of work for a human. Consider
  un-labelling it until the P0 and P1 work has landed.
- **Invariants.** The seven in `CLAUDE.md` are what makes this codebase trustworthy and no test
  enforces most of them directly. Every issue body restates the ones that apply, and the
  implementer prompt now points at them, but a reviewer agent will not reliably catch a
  violation. Read the diffs.

## 8. After a run

- The merge agent closes each merged issue with a `Completed by Sandcastle` comment. Anything
  still open either was not attempted or did not finish — check for an agent comment on it.
- Branches are left behind. `git branch --list 'sandcastle/issue-*'` lists them.
- Push when you are satisfied: `git push fork sandcastle/integration`, then open one PR per
  logical group rather than one enormous one.
- Update the ledger in `~/Desktop/Lipi-plan/PHASE_PLAN.md` for anything that overlaps a planned
  phase, so the two backlogs do not silently diverge.

## 9. Adding work

Create the issue on the fork with the `sandcastle` label and its priority label, then record its
blockers natively:

```
gh issue create -R Aanyagoel-14/Lipi-sales-agent --title "..." --body-file body.md \
  --label sandcastle --label P1

BLOCKER_ID=$(gh api repos/Aanyagoel-14/Lipi-sales-agent/issues/<blocker> --jq .id)
gh api --method POST repos/Aanyagoel-14/Lipi-sales-agent/issues/<child>/dependencies/blocked_by \
  -F issue_id=$BLOCKER_ID
```

`issue_id` is the numeric **database id**, not the `#number`. Getting that wrong silently links
the wrong issues.

Write the body the way the existing 25 are written: name the file that proves the gap, state the
acceptance criteria as things that can be checked, and put the trap in a `Do not` section. An
autonomous implementer will do exactly what the issue says and nothing it does not.
