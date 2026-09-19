# TASK

Merge the following branches into the current branch:

{{BRANCHES}}

For each branch:

1. Run `git merge <branch> --no-edit`
2. If there are merge conflicts, resolve them intelligently by reading both sides and choosing the correct resolution
3. After resolving conflicts, run `npm run lint`, `npm run typecheck` and `npm test` from the repo root to verify everything works (they delegate into `web/`; the suite needs Postgres — `sudo service postgresql start` if it is down)
4. If tests fail, fix the issues before proceeding to the next branch

If a branch's tests cannot be made to pass, do not merge it. Leave it
unmerged, comment on its issue saying why, and carry on with the rest — a red
main is worse than a late feature.

If two branches both changed `web/prisma/schema.prisma`, check that their
migrations still apply in sequence against a clean `lipi_test` before you call
the merge good. Two phases each adding a migration is the one conflict that
passes `git merge` and fails at deploy.

After all branches are merged, make a single commit summarizing the merge.

# CLOSE ISSUES

For each branch that was merged, close its issue using the following command:

`gh issue close <ID> -R Aanyagoel-14/Lipi-sales-agent --comment "Completed by Sandcastle"`

Here are all the issues:

{{ISSUES}}

Once you've merged everything you can, output <promise>COMPLETE</promise>.
