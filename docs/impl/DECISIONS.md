# DECISIONS

Every non-obvious engineering or product interpretation made while taking the
repository to the PRD, with the PRD section it derives from and the
alternatives rejected. Newest last.

---

## D-001 — The stale generated Prisma client is an environment fact, not a code change

**Derives from:** master prompt §1 (record the baseline), §41.3 (do not assume
existing code works).

`npm run typecheck` failed on checkout with 54 errors. All 54 came from
`web/src/generated/` being older than two applied migrations; the directory is
gitignored and is rebuilt by `prisma generate`, which `npm ci` runs on
`postinstall`. No committed source was wrong.

**Decision.** Regenerate and record the *post-generate* run as the true
baseline, rather than "fixing" 54 errors that do not exist in a correctly
installed tree. Noted in `PROGRESS.md` so the next session does not rediscover
it.

**Rejected:** committing the generated client (it is deliberately ignored, and
it is 2 MB of machine output); widening types to accept `"x"` (would have
papered over a client that was simply out of date).

---

## D-002 — Webhook subscription cursors are read off the log, not off the clock

**Derives from:** the existing contract documented at
`web/prisma/schema.prisma:1076` ("Set to the moment of creation, so a new
endpoint starts with what happens next rather than with the whole history")
and master prompt §25/§33 (fix root causes, never weaken a test).

A subscription created in the same millisecond as the event before it replayed
that event. `occurredAt` is millisecond-resolution, and a cursor of
`(thatMillisecond, "")` sorts before every event in that millisecond.

**Decision.** `subscribe()` reads `(occurredAt, id)` off the newest event for
the workspace and starts there; an empty log still starts at `new Date()`.
This makes the documented promise exact regardless of clock resolution and
costs one indexed `findFirst` per subscription creation.

**Rejected:**
- *Relaxing the test to `occurredAt > cursorAt`* — would drop every legitimate
  event that shares a millisecond with the cursor, trading a rare duplicate for
  a rare silent loss, which is strictly worse for an at-least-once queue.
- *A sentinel `cursorId` that sorts above any event id* — depends on Postgres
  collation and on the `evt_` id scheme never changing.
- *Adding a monotonic sequence column to `TwinEvent`* — the correct long-term
  fix for total ordering, but it is a migration plus a change to the keyset in
  `server/lib/page.ts`, and it is not what this defect requires. Recorded in
  `BLOCKERS.md` as a known residual instead.

**Residual, accepted and documented:** two events written in the *same*
millisecond *after* a subscription can still be ordered by the random suffix in
`eventId()`, so one of them could be scanned out of order within that
millisecond. Delivery is at-least-once with `skipDuplicates`, so this cannot
duplicate; it could in principle delay. A monotonic event sequence is the fix
if it ever matters.
