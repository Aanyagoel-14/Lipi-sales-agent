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
