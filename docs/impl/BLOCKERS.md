# BLOCKERS

Work that cannot be completed in this environment, exactly what is missing,
and what was built instead. Nothing here is a reason to skip a requirement —
each entry names the production-ready abstraction that stands in its place.

Status key: **OPEN** (needs something external) · **MITIGATED** (adapter +
deterministic test implementation shipped, live path unverified).

---

## B-001 — `TwinEvent` has no monotonic sequence

**Status:** OPEN, low severity. Not externally blocked — deliberately deferred.

`TwinEvent.occurredAt` is millisecond-resolution and `id` carries a random
suffix, so `(occurredAt, id)` is *total* but not *causal*: two events written
in the same millisecond may be ordered differently from how they happened.
Every reader is at-least-once with de-duplication, so this cannot duplicate or
lose an event; it can only reorder within a millisecond.

The fix is a monotonic sequence column plus a change to the keyset in
`web/src/server/lib/page.ts`. It is a migration and a behavioural change to
pagination, so it is recorded rather than smuggled into an unrelated fix. See
`DECISIONS.md` D-002.
