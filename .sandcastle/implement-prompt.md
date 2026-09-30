# TASK

Fix issue {{TASK_ID}}: {{ISSUE_TITLE}}

Pull in the issue using `gh issue view <ID> -R Aanyagoel-14/Lipi-sales-agent --comments`. If it has a parent PRD, pull that in too.

Only work on the issue specified.

Work on branch {{BRANCH}}. Make commits and run tests.

# CONTEXT

Here are the last 10 commits:

<recent-commits>

!`git log -n 10 --format="%H%n%ad%n%B---" --date=short`

</recent-commits>

# EXPLORATION

Explore the repo and fill your context window with relevant information that will allow you to complete the task.

Pay extra attention to test files that touch the relevant parts of the code.

# EXECUTION

If applicable, use RGR to complete the task.

1. RED: write one test
2. GREEN: write the implementation to pass that test
3. REPEAT until done
4. REFACTOR the code

# THIS REPO

The application lives in `web/`, not at the repo root. `web/CLAUDE.md` and
`web/AGENTS.md` are binding; read them. `CLAUDE.md` at the root lists seven
invariants — transactional ingest, the fact/voice split, first-touch
attribution, integer paise, tenant scoping, append-only `TwinEvent`, and green
before commit. **A change that breaks one of those has failed even if its own
tests pass.**

Next.js here is version 16. Before writing any routing or rendering code, read
`web/node_modules/next/dist/docs/` as `web/AGENTS.md` instructs.

# FEEDBACK LOOPS

From the repo root: `npm run lint`, `npm run typecheck`, `npm test` — all three
must pass before you commit. They delegate into `web/`. The suite needs the
Postgres that the sandbox started for you; if it is not up, run
`sudo service postgresql start`. A skipped test is a failed test.

# COMMIT

Make a git commit. The commit message must:

1. Start with `RALPH:` prefix
2. Include task completed + PRD reference
3. Key decisions made
4. Files changed
5. Blockers or notes for next iteration

Keep it concise.

# THE ISSUE

If the task is not complete, leave a comment on the issue with what was done:
`gh issue comment <ID> -R Aanyagoel-14/Lipi-sales-agent --body "..."`

Do not close the issue - this will be done later.

Once complete, output <promise>COMPLETE</promise>.

# FINAL RULES

ONLY WORK ON A SINGLE TASK.

# WHEN A HUMAN HAS TO DECIDE

Some issues cannot be finished by an agent alone. Stop and hand the question
back when — and only when — one of these is true:

- The issue turns on a **product or business call** that the repo does not
  already answer: pricing, discount policy, what a customer is promised, which
  of two incompatible UX flows to ship, what counts as a conversion.
- It needs a **credential, account or external resource** you do not have: an
  API key, an OAuth app, a paid plan, a DNS record, a provider sandbox.
- The issue **contradicts** one of the seven invariants in `CLAUDE.md`, or
  contradicts another open issue, and satisfying it means overturning a
  recorded decision.
- Delivering it requires an **irreversible or outward-facing action**: sending
  real messages, charging real money, writing to a production system.
- The issue's spec is **ambiguous in a way that changes the work**, and both
  readings are plausible — not merely underspecified detail you can settle with
  a sensible default.

Do not use this to escape a hard bug, a flaky test, or a task that is merely
large. Those you work. A missing default that a careful engineer would just
choose is not a human decision.

When one of the above is genuinely true:

1. Commit whatever is already green — partial work is kept, not thrown away.
2. Comment on the issue with, in this order: what you built, the exact question,
   the options with their consequences, and your recommendation.
   `gh issue comment <ID> -R Aanyagoel-14/Lipi-sales-agent --body "..."`
3. Label it: `gh issue edit <ID> -R Aanyagoel-14/Lipi-sales-agent --add-label needs-human-decision`
4. Output, on its own line:

   `<decision>NEEDS-HUMAN</decision>`

That signal stops the whole loop, not just this issue — the other agents
finish their round and no new round starts. Use it when the answer really is
the human's to give, and never as a substitute for finishing the work.
