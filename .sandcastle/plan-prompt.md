# ISSUES

Here are the open issues in the repo:

<issues-json>

!`gh issue list -R Aanyagoel-14/Lipi-sales-agent --state open --label sandcastle --limit 100 --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`

</issues-json>

Here is the blocking graph GitHub itself holds, as open-blocker counts per issue:

<blockers-json>

!`gh issue list -R Aanyagoel-14/Lipi-sales-agent --state open --label sandcastle --limit 100 --json number --jq '.[].number' | while read n; do gh api repos/Aanyagoel-14/Lipi-sales-agent/issues/$n --jq '{number: .number, openBlockers: .issue_dependencies_summary.blocked_by}'; done | jq -s .`

</blockers-json>

The list above has already been filtered to issues carrying the `sandcastle` label.

Each issue body also ends with an explicit `Blocked by: #N` line where it has
dependencies. **Treat `openBlockers > 0` as authoritative: that issue is blocked,
full stop.** Use your own analysis only to find blocking relationships the graph
does not already record — chiefly two unblocked issues that would edit the same
files and conflict on merge.

# TASK

Analyze the open issues and build a dependency graph. For each issue, determine whether it **blocks** or **is blocked by** any other open issue.

An issue B is **blocked by** issue A if:

- B requires code or infrastructure that A introduces
- B and A modify overlapping files or modules, making concurrent work likely to produce merge conflicts
- B's requirements depend on a decision or API shape that A will establish

An issue is **unblocked** if it has zero blocking dependencies on other open issues.

For each unblocked issue, assign a branch name using the exact format `sandcastle/issue-{id}` (no slug or other suffix). This must be deterministic so that re-planning the same issue always produces the same branch name and accumulated progress is preserved.

# OUTPUT

Output your plan as a JSON object wrapped in `<plan>` tags:

<plan>
{"issues": [{"id": "42", "title": "Fix auth bug", "branch": "sandcastle/issue-42"}]}
</plan>

Include only unblocked issues. If every issue is blocked, include the single highest-priority candidate (the one with the fewest or weakest dependencies).

Always emit the `<plan>` tags, even when there is nothing to do. If there are no issues to work on at all, output `<plan>{"issues": []}</plan>` so the run can exit cleanly.
