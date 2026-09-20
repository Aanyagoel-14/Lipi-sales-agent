// Parallel Planner with Review — four-phase orchestration loop
//
// This template drives a multi-phase workflow:
//   Phase 1 (Plan):             An opus agent analyzes open issues, builds a
//                               dependency graph, and outputs a <plan> JSON
//                               listing unblocked issues with branch names.
//   Phase 2 (Execute + Review): For each issue, a sandbox is created via
//                               createSandbox(). The implementer runs first
//                               (100 iterations). If it produces commits, a
//                               reviewer runs in the same sandbox on the same
//                               branch (1 iteration). All issue pipelines run
//                               concurrently via Promise.allSettled().
//   Phase 3 (Merge):            A single agent merges all completed branches
//                               into the current branch, from a worktree
//                               (merge-to-head) so it can run the suite.
//
// The outer loop repeats up to MAX_ITERATIONS times so that newly unblocked
// issues are picked up after each round of merges.
//
// Usage:
//   npx tsx .sandcastle/main.mts
// Or add to package.json:
//   "scripts": { "sandcastle": "npx tsx .sandcastle/main.mts" }

import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { z } from "zod";

// The planner emits its plan as JSON inside <plan> tags; Output.object extracts
// and validates it against this schema. We use Zod here, but any Standard
// Schema validator works just as well — Valibot, ArkType, etc. See
// https://standardschema.dev.
const planSchema = z.object({
  issues: z.array(
    z.object({ id: z.string(), title: z.string(), branch: z.string() }),
  ),
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Maximum number of plan→execute→merge cycles before stopping.
// Raise this if your backlog is large; lower it for a quick smoke-test run.
const MAX_ITERATIONS = 10;

// Issues live on the fork, not on `origin` (which is the upstream
// kritucapital repo and has no token here). `GH_REPO` makes every bare `gh`
// call inside a sandbox target the right place even though the worktree's
// git remotes point at host paths that do not exist in the container. The
// prompts also pass `-R` explicitly — belt and braces, because getting this
// wrong means an agent silently reads or writes the wrong tracker.
const ISSUE_REPO = "Aanyagoel-14/Lipi-sales-agent";

// The app is in web/, not at the repo root, and its suite talks to a real
// Postgres — see `web/test/global-setup.ts`. The Dockerfile bakes in a
// `lipi_test` database; this is the URL the suite reaches it on, overriding
// `web/test/database-url.ts`'s OS-user-derived default.
const TEST_DATABASE_URL = "postgresql://agent@127.0.0.1:5432/lipi_test";

const sandboxEnv = { GH_REPO: ISSUE_REPO, TEST_DATABASE_URL };

// The escape hatch. An agent that hits a question only the repo's owner can
// answer — a pricing policy, a missing credential, two incompatible readings of
// a spec — comments the question on its issue, labels the issue, and emits
// DECISION_SIGNAL instead of grinding out a guess. Because the signal is passed
// as a completion signal, it also ends that agent's own run immediately rather
// than burning the remaining iterations.
//
// The loop then finishes the round it is in (the other agents are already
// mid-flight, and their work is worth keeping), merges whatever is green, and
// stops. It does not start another round: the planner's next plan would be
// drawn from a backlog whose shape the pending answer may change.
const COMPLETION_SIGNAL = "<promise>COMPLETE</promise>";
const DECISION_SIGNAL = "<decision>NEEDS-HUMAN</decision>";
const DECISION_LABEL = "needs-human-decision";
const AGENT_SIGNALS = [COMPLETION_SIGNAL, DECISION_SIGNAL];

// Ten minutes of silence is Sandcastle's default for calling an agent dead. It
// is too short here: an agent running the full suite against Postgres can be
// quiet for a while, and a host that sleeps mid-round comes back to a wall
// clock that jumped — every in-flight agent trips the timer at once on resume,
// which is exactly how the 2026-09-20 02:46 round died with three agents
// mid-edit. Half an hour costs nothing when the agent is alive and saves the
// round when the host merely blinked.
const IDLE_TIMEOUT_SECONDS = 1800;

// Where the loop writes the questions it stopped on, so they survive the
// scrollback. Regenerated from GitHub on every stop — the issues are the
// record, this file is a convenience.
const DECISION_REPORT = ".sandcastle/DECISIONS.md";

// Which model every agent in the loop runs on. Override with SANDCASTLE_MODEL
// to run a cheaper planner or to pin a known-good version.
const MODEL = process.env.SANDCASTLE_MODEL ?? "claude-opus-5";

// Hooks run inside the sandbox once it is ready — for the sandboxes that run
// code, which is the implementer/reviewer pairs and the merger. The script
// starts Postgres, links `web/node_modules` to the tree baked into the image,
// and generates the Prisma client from the worktree's own schema. It never
// downloads the dependency tree; see the script and the Dockerfile for why.
//
// The planner gets NO hooks, deliberately. `sandcastle.run()` defaults to the
// `head` branch strategy, which bind-mounts this repo's own checkout into the
// container rather than a worktree — so a hook there runs against the working
// copy on the host machine. The first version of this file gave the planner
// an `npm ci` hook, and it replaced the host's macOS `web/node_modules` with a
// Linux one, then with nothing when the download failed. The planner only
// reads issues; it needs neither Postgres nor node_modules.
const workerHooks = {
  sandbox: {
    onSandboxReady: [
      { command: "sh .sandcastle/sandbox-setup.sh", timeoutMs: 600_000 },
    ],
  },
};

// Deliberately empty. The template copies the host's node_modules to skip a
// cold install, but this host is macOS and the sandbox is linux/glibc: Prisma's
// query engine and vitest's esbuild binary are both platform-specific, and a
// copied darwin tree does not get repaired by a later `npm install` that finds
// package.json already satisfied. A clean `npm ci` costs a couple of minutes
// once per sandbox and is the difference between a working feedback loop and
// a hundred iterations of the same native-module error.
const copyToWorktree: string[] = [];

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

// Does this branch hold work the current branch does not? Commits produced by
// an earlier round survive on their branch, and `RunResult.commits` only ever
// reports what the run in hand produced — so an agent that finishes, then loses
// its round to a crashed sibling, leaves green work no later round can see.
// Asking git instead of the run result closes that gap: the branch is the
// record. The merger still runs the suite before it merges anything, so a
// half-finished branch from a killed agent gets left behind rather than landed.
function hasUnmergedWork(branch: string): boolean {
  try {
    return Number(git("rev-list", "--count", `HEAD..${branch}`)) > 0;
  } catch {
    // No such branch — the sandbox never got far enough to create one.
    return false;
  }
}

// ---------------------------------------------------------------------------
// Planner input
// ---------------------------------------------------------------------------

// The planner's two inputs, fetched here and written to disk rather than
// expanded inside the prompt. Sandcastle gives a prompt's `!` shell expressions
// 30 seconds and no retry, and the blocker graph alone is one API call per open
// issue — twenty-five of them, on a network that had just come back from a
// host sleep when it blew the budget and took the whole loop down with it.
// Host-side, the fetch can be slow, can be retried, and can fail without
// killing the run: `cat` of a file that already exists cannot time out.
const ISSUES_FILE = ".sandcastle/issues.json";
const BLOCKERS_FILE = ".sandcastle/blockers.json";

function gh(args: string[]): string {
  return execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

// Issues carrying DECISION_LABEL are filtered out here, not in the prompt: a
// parked issue is one an agent would have to guess at, and the planner should
// never see it.
function fetchIssues(): string {
  return gh([
    "issue",
    "list",
    "-R",
    ISSUE_REPO,
    "--state",
    "open",
    "--label",
    "sandcastle",
    "--limit",
    "100",
    "--json",
    "number,title,body,labels,comments",
    "--jq",
    `[.[] | select([.labels[].name] | index("${DECISION_LABEL}") | not) | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]`,
  ]);
}

// GitHub's own dependency graph, as an open-blocker count per issue. One call
// per issue, six at a time — the planner treats a non-zero count as
// authoritative, so this is worth the wait.
function fetchBlockers(issueNumbers: number[]): string {
  const results = [];
  for (let i = 0; i < issueNumbers.length; i += 6) {
    const batch = issueNumbers.slice(i, i + 6);
    results.push(
      ...batch.map((number) => {
        try {
          return JSON.parse(
            gh([
              "api",
              `repos/${ISSUE_REPO}/issues/${number}`,
              "--jq",
              "{number: .number, openBlockers: .issue_dependencies_summary.blocked_by}",
            ]),
          );
        } catch {
          // A single unreadable issue must not cost us the graph. Reporting it
          // as unblocked is the safe default: the planner's own file-overlap
          // analysis still applies, and the issue body's `Blocked by:` line is
          // in the issue JSON either way.
          console.error(`  ! could not read blockers for #${number}`);
          return { number, openBlockers: 0 };
        }
      }),
    );
  }
  return JSON.stringify(results, null, 2);
}

// Two attempts, because the failure this guards against is a network that is
// coming back rather than one that is down.
function writePlannerInput(): boolean {
  for (const attempt of [1, 2]) {
    try {
      const issues = fetchIssues();
      const numbers = (JSON.parse(issues) as { number: number }[]).map(
        (issue) => issue.number,
      );
      writeFileSync(ISSUES_FILE, issues);
      writeFileSync(BLOCKERS_FILE, fetchBlockers(numbers));
      console.log(`Planner input: ${numbers.length} open issue(s).`);
      return true;
    } catch (error) {
      console.error(`  ! planner input fetch failed (attempt ${attempt}): ${error}`);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Pending decisions
// ---------------------------------------------------------------------------

type ParkedIssue = {
  number: number;
  title: string;
  url: string;
  question: string;
};

// Read back the issues the agents parked. The signal tells us to stop; this
// tells the human what to answer. Reading it from GitHub rather than from agent
// stdout means a question parked by a run that later crashed is still reported,
// and that re-running the loop after answering is a label removal away.
function fetchParkedIssues(): ParkedIssue[] {
  try {
    const raw = execFileSync(
      "gh",
      [
        "issue",
        "list",
        "-R",
        ISSUE_REPO,
        "--state",
        "open",
        "--label",
        DECISION_LABEL,
        "--limit",
        "100",
        "--json",
        "number,title,url,comments",
      ],
      { encoding: "utf8" },
    );
    const issues = JSON.parse(raw) as {
      number: number;
      title: string;
      url: string;
      comments: { body: string }[];
    }[];
    return issues.map((issue) => ({
      number: issue.number,
      title: issue.title,
      url: issue.url,
      // The parking comment is the last one the agent left.
      question: issue.comments.at(-1)?.body.trim() ?? "(no comment left)",
    }));
  } catch (error) {
    console.error(`  ! could not read parked issues: ${error}`);
    return [];
  }
}

function reportDecisions(parked: ParkedIssue[]): void {
  const lines = [
    "# Sandcastle stopped — decisions waiting on a human",
    "",
    `Generated ${new Date().toISOString()} by \`.sandcastle/main.mts\`.`,
    "",
    "The loop will not start another round until these are answered. To resume:",
    "answer the question in the issue thread, then remove the label —",
    `\`gh issue edit <ID> -R ${ISSUE_REPO} --remove-label ${DECISION_LABEL}\` —`,
    "and run `npm run sandcastle` again.",
    "",
  ];
  for (const issue of parked) {
    lines.push(`## #${issue.number}: ${issue.title}`, "", issue.url, "", issue.question, "");
  }
  writeFileSync(DECISION_REPORT, lines.join("\n"));

  console.log("\n=== Stopped: a human has to decide ===\n");
  for (const issue of parked) {
    console.log(`  #${issue.number}: ${issue.title}`);
    console.log(`    ${issue.url}`);
  }
  console.log(`\nQuestions written to ${DECISION_REPORT}.`);
  console.log(
    `Answer them, then \`gh issue edit <ID> -R ${ISSUE_REPO} --remove-label ${DECISION_LABEL}\` and re-run.`,
  );
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

// A question parked by an earlier run is still a question. Starting a round on
// the rest of the backlog would bury it, so the loop refuses to start until the
// label is gone — answering it is one `gh issue edit --remove-label` away.
const alreadyParked = fetchParkedIssues();
if (alreadyParked.length > 0) {
  reportDecisions(alreadyParked);
  process.exit(0);
}

for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
  console.log(`\n=== Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);

  // -------------------------------------------------------------------------
  // Phase 1: Plan
  //
  // The planning agent (opus, for deeper reasoning) reads the open issue list,
  // builds a dependency graph, and selects the issues that can be worked in
  // parallel right now (i.e., no blocking dependencies on other open issues).
  //
  // It outputs a <plan> JSON block — Output.object parses and validates it.
  // -------------------------------------------------------------------------
  if (!writePlannerInput()) {
    console.error("Could not read the issue tracker. Stopping.");
    break;
  }

  const plan = await sandcastle.run({
    // No hooks: head mode, host checkout, read-only work. See `workerHooks`.
    sandbox: docker({ env: sandboxEnv }),
    name: "planner",
    // One iteration is enough: the planner just needs to read and reason,
    // not write code. (Structured output requires maxIterations: 1.)
    maxIterations: 1,
    // Opus for planning: dependency analysis benefits from deeper reasoning.
    agent: sandcastle.claudeCode(MODEL),
    idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
    promptFile: "./.sandcastle/plan-prompt.md",
    // Extract and validate the <plan> JSON into a typed object. Throws
    // StructuredOutputError if the tag is missing, the JSON is malformed, or
    // validation fails — which aborts the loop.
    output: sandcastle.Output.object({ tag: "plan", schema: planSchema }),
  });

  const issues = plan.output.issues;

  if (issues.length === 0) {
    // No unblocked work — everything is done, blocked, or parked on a human.
    console.log("No unblocked issues to work on. Exiting.");
    const parked = fetchParkedIssues();
    if (parked.length > 0) reportDecisions(parked);
    break;
  }

  console.log(
    `Planning complete. ${issues.length} issue(s) to work in parallel:`,
  );
  for (const issue of issues) {
    console.log(`  ${issue.id}: ${issue.title} → ${issue.branch}`);
  }

  // -------------------------------------------------------------------------
  // Phase 2: Execute + Review
  //
  // For each issue, create a sandbox via createSandbox() so the implementer
  // and reviewer share the same sandbox instance per branch. The implementer
  // runs first; if it produces commits, the reviewer runs in the same sandbox.
  //
  // Promise.allSettled means one failing pipeline doesn't cancel the others.
  // -------------------------------------------------------------------------

  const settled = await Promise.allSettled(
    issues.map(async (issue) => {
      const sandbox = await sandcastle.createSandbox({
        branch: issue.branch,
        sandbox: docker({ env: sandboxEnv }),
        hooks: workerHooks,
        copyToWorktree,
      });

      try {
        // Run the implementer
        const implement = await sandbox.run({
          name: "implementer",
          maxIterations: 100,
          agent: sandcastle.claudeCode(MODEL),
          // Either signal ends the run. `completionSignal` on the result says
          // which one fired, and DECISION_SIGNAL is what stops the loop.
          completionSignal: AGENT_SIGNALS,
          idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
          promptFile: "./.sandcastle/implement-prompt.md",
          promptArgs: {
            TASK_ID: issue.id,
            ISSUE_TITLE: issue.title,
            BRANCH: issue.branch,
          },
        });

        const needsDecision = implement.completionSignal === DECISION_SIGNAL;

        if (needsDecision) {
          console.log(
            `  ⏸ ${issue.id} (${issue.branch}) parked: needs a human decision`,
          );
        }

        // Only review if the implementer produced commits — and not when it
        // parked, because polishing half a feature whose shape the pending
        // answer may change is work thrown away twice.
        if (implement.commits.length > 0 && !needsDecision) {
          try {
            const review = await sandbox.run({
              name: "reviewer",
              maxIterations: 1,
              agent: sandcastle.claudeCode(MODEL),
              idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
              promptFile: "./.sandcastle/review-prompt.md",
              promptArgs: {
                BRANCH: issue.branch,
              },
            });

            // Merge commits from both runs so the merge phase sees all of them.
            // Each sandbox.run() only returns commits from its own run.
            return {
              ...review,
              commits: [...implement.commits, ...review.commits],
              needsDecision,
            };
          } catch (error) {
            // The review is a polish pass, not a gate. Letting it take the
            // implementer's commits down with it is how a finished, green
            // branch ends up looking like a round that produced nothing.
            console.error(
              `  ! ${issue.id} implemented, but the review failed: ${error}`,
            );
            return { ...implement, needsDecision };
          }
        }

        return { ...implement, needsDecision };
      } finally {
        await sandbox.close();
      }
    }),
  );

  // Log any agents that threw (network error, sandbox crash, etc.).
  for (const [i, outcome] of settled.entries()) {
    if (outcome.status === "rejected") {
      console.error(
        `  ✗ ${issues[i]!.id} (${issues[i]!.branch}) failed: ${outcome.reason}`,
      );
    }
  }

  // Which branches have something to merge? Ask git, not the run results. A
  // pipeline that rejected may still have committed before it died, and a
  // branch carried over from an earlier round holds commits no run in this
  // round reports. Both are green work that would otherwise sit on a branch
  // forever, invisible to every subsequent round.
  const completedIssues = issues.filter((issue) => hasUnmergedWork(issue.branch));

  const completedBranches = completedIssues.map((i) => i.branch);

  // Did anyone park a question this round? A rejected pipeline cannot tell us,
  // so the label query at the stop is the backstop for those.
  const parkedThisRound = settled.some(
    (outcome) => outcome.status === "fulfilled" && outcome.value.needsDecision,
  );

  console.log(
    `\nExecution complete. ${completedBranches.length} branch(es) with commits:`,
  );
  for (const branch of completedBranches) {
    console.log(`  ${branch}`);
  }

  if (completedBranches.length === 0) {
    // All agents ran but none made commits — nothing to merge this cycle.
    console.log("No commits produced. Nothing to merge.");
    if (parkedThisRound) {
      reportDecisions(fetchParkedIssues());
      break;
    }
    continue;
  }

  // -------------------------------------------------------------------------
  // Phase 3: Merge
  //
  // One agent merges all completed branches into the current branch,
  // resolving any conflicts and running tests to confirm everything works.
  //
  // The {{BRANCHES}} and {{ISSUES}} prompt arguments are lists that the agent
  // uses to know which branches to merge and which issues to close.
  // -------------------------------------------------------------------------
  const merge = await sandcastle.run({
    hooks: workerHooks,
    // Not head mode. The merger runs the suite, so it needs the sandbox's
    // node_modules and Postgres — and it must not get them by writing into the
    // host checkout. merge-to-head runs it in a worktree on a temporary
    // branch; when it finishes, Sandcastle merges that branch into the host's
    // current branch (a fast-forward, since nothing else moved it) and deletes
    // it. If that merge fails the temporary branch is kept and the error names
    // it.
    branchStrategy: { type: "merge-to-head" },
    sandbox: docker({ env: sandboxEnv }),
    name: "merger",
    maxIterations: 1,
    agent: sandcastle.claudeCode(MODEL),
    completionSignal: AGENT_SIGNALS,
    idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
    promptFile: "./.sandcastle/merge-prompt.md",
    promptArgs: {
      // A markdown list of branch names, one per line.
      BRANCHES: completedBranches.map((b) => `- ${b}`).join("\n"),
      // A markdown list of issue IDs and titles, one per line.
      ISSUES: completedIssues.map((i) => `- ${i.id}: ${i.title}`).join("\n"),
    },
  });

  console.log("\nBranches merged.");

  if (parkedThisRound || merge.completionSignal === DECISION_SIGNAL) {
    reportDecisions(fetchParkedIssues());
    break;
  }
}

console.log("\nAll done.");
