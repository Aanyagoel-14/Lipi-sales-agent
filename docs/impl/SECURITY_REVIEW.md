# SECURITY_REVIEW

A review of the implementation against master prompt §19, covering both the
code written for this effort and what was already here. Findings are numbered,
each states what it is, whether it was fixed, and what evidence there is.

Written from reading the code and from writing tests against it. Where a test
found the problem rather than the reading, that is said — those are the ones
worth trusting most.

**Severity** is about this system, not in the abstract: *high* means a tenant's
data or money is reachable; *medium* means an attacker gets a meaningful
advantage; *low* means correctness or defence in depth.

---

## The part that matters most: agent tool execution

The master prompt is explicit that this is a hard boundary — "an LLM-generated
tool call must never be able to run a dangerous operation unchecked". It is
also the newest surface in the codebase, so it got the most attention.

**Everything that decides lives in one place**,
`web/src/server/agents/execute.ts`, and nothing decides inside a skill. A check
inside a skill is a check the next skill's author has to remember to copy.

| Requirement (§19) | Where | Test |
| --- | --- | --- |
| allowed-tool lists | the agent's `AgentSkill` rows, checked before arguments are parsed | `agents.test.ts` "refuses a skill the agent does not hold", "…switched off" |
| argument schemas | each spec's Zod schema; the SDK compiles JSON-schema-ish declarations into **strict** objects | `agents.test.ts`, `sdk.test.ts` "parameter validation" (5 cases) |
| authorization | the agent must be this workspace's and `deployed` | `agents.test.ts` "refuses another tenant's agent", "…not been deployed" |
| guardrails | `maxSingleQuoteValue`, margin floor, discount allowance, escalation triggers | `agents.test.ts` "guardrails at execution time" (6 cases) |
| tenant context | `twinStore` is built per execution, closed over one workspace; **no method takes a `workspaceId`** | `agents.test.ts`, `sdk.test.ts` |
| audit logging | one `AgentRun` and its `TwinEvent`s, inside the execution's transaction | `agents.test.ts` "writes one run and its events" |
| maximum values | checked against **what the handler committed**, not what it reported | `sdk.test.ts` "holds a quote past maxSingleQuoteValue without the handler reporting it" |
| escalation rules | agent triggers and the skill's own, matched before the skill runs | `agents.test.ts` "holds anything a customer said that trips a trigger" |

Two design properties worth stating because they were choices, not accidents:

- **A refusal is a value, not an exception.** A model that asks for something
  it may not have gets a structured "no" it can act on, and the route renders
  it as 422 rather than 500.
- **The post-checks can only hold a result back; they never edit one.**
  Clamping an over-ceiling quote to the ceiling would hand a customer a number
  nobody authorised and tell the operator a discount had been granted.

**A skill that throws leaves nothing behind.** The transaction rolls back, and
no event claims otherwise — asserted in `agents.test.ts` "rolls back everything
when a skill throws" and `sdk.test.ts` "rolls the draft back when the handler
throws after writing it".

---

## Findings

### F-1 — Prototype chain reachable through the quote formula's scope — **fixed**

**Severity:** high. **Found by:** writing the test, not by reading the code.

`evaluateFormula` resolved a variable with `if (!(node.name in scope))`. Every
object literal inherits `constructor`, `toString`, `hasOwnProperty` and
`__proto__` from `Object.prototype`, so `"__proto__" in scope` is **true** for a
scope that has never heard of it. The lookup then returned a function or the
prototype itself, which flowed into the arithmetic as `NaN` and out the other
side as a price on a public page.

An operator writes the formula and a stranger's browser supplies the variables,
so this was reachable from an unauthenticated request.

**Fix.** `Object.hasOwn`, plus a type check: a resolved value must be a number
or a boolean. `web/src/server/sites/formula.ts`.

**Evidence.** `test/formula.test.ts` "resolves only names somebody actually put
in the scope" asserts six inherited names are refused, both bare and in
arithmetic.

### F-2 — Unbounded recursion in the formula parser — **fixed**

**Severity:** medium (denial of service). **Found by:** writing the test.

The parser recurses on `(`, and the only bound was a 2,000-character source
limit. 1,500 open parentheses is 1,501 characters and 1,500 stack frames.

**Fix.** An explicit depth limit of 20, checked where the recursion happens.

**Evidence.** `test/formula.test.ts` "refuses a formula that nests deeper than
a person would write".

### F-3 — No throttle on the password endpoints — **fixed**

**Severity:** medium. **Pre-existing.**

`/v1/auth/login` and `/v1/auth/signup` were the only unauthenticated write
endpoints in the API with no ceiling. Every other public surface already had
one — the widget's in `lib/cors.ts`, per-key in `lib/api-key.ts` — so these two
simply predated the habit. The result was an unbounded budget for guessing a
password and for learning which addresses have accounts.

**Fix.** `web/src/server/lib/auth-throttle.ts`, applied to both routes.

Two keys, because either alone is defeated: **per address** (20 per 15 minutes)
bounds one machine working through a list; **per email** (10 per 15 minutes)
bounds a distributed attempt on one account. The refusal is identical for both
— a distinct message for the per-email ceiling would confirm that the address
has an account, which is exactly the enumeration the login route's "same
message either way" already guards against. The check runs **before** the
password is verified, so a refused attempt costs a map lookup rather than an
Argon2 hash.

**Evidence.** `test/auth.test.ts` "the password endpoints have a budget" —
four cases, including that both refusals read the same.

**Residual:** the limiter is per process and in memory (see F-6).

### F-4 — Nothing structurally required a route to scope by tenant — **fixed**

**Severity:** medium (latent; no instance found). **Pre-existing.**

Tenant isolation is one choke point plus a `where: { workspaceId }` written by
hand in every handler. That is a good design with one hole: `route()` does not
demand the call, there is no Prisma extension or RLS, and `test/tenancy.test.ts`
covers named endpoints by hand — so a route added next month that forgets it
passes CI and serves another tenant's rows.

Every route currently in the repository was checked. **None is missing it.**

**Fix.** `test/route-tenancy.test.ts` reads every `route.ts` and requires each
to resolve a tenant, require a user, verify a provider secret, or appear in an
exemption list **with the reason written next to it**. It also fails an exempt
route that starts authenticating, so the list stays short enough to read.

It cannot prove a handler *uses* the id it resolved. It can prove nobody added
a route without considering the question, which is the failure that happens.

**Evidence.** 96 assertions, one per route module, plus a guard against the
glob silently matching nothing.

### F-5 — A `write`-scoped API key can widen its own workspace's CORS allow-list — **open**

**Severity:** medium. **Pre-existing.** Not fixed — see below.

`PATCH /v1/workspaces/current` accepts `allowedOrigins` and resolves through
`resolveWorkspaceId()` with no `sessionOnly` flag, so a leaked API key can add
an origin to the list of browser origins from which keys may be used. The three
`/v1/api-keys` routes are session-gated for exactly this class of
self-perpetuation; this one is not.

The blast radius is bounded: the origin is per workspace, credentials are never
allowed with it, and the key already has whatever access it is widening. What
it buys an attacker is *persistence from a browser they control*.

**Why it is not fixed here.** Splitting `allowedOrigins` out of
`PATCH /v1/workspaces/current` into a session-only route is a breaking change
to a published endpoint, and it is not one any PRD requirement asks for. It
belongs in a change of its own, with its own note in the API docs, rather than
smuggled into a feature commit. Recorded here and in `BLOCKERS.md` so it is not
lost.

### F-6 — Rate limiting is per process and in memory — **open, documented**

**Severity:** low here, medium in a scaled deployment. **Pre-existing,
self-documented** at `web/src/server/lib/rate-limit.ts:22-31`.

Every ceiling in the system — the widget's, the per-key budget, and the new
auth throttle — lives in one process's `Map`. Horizontally scaled, each
instance enforces its own, so the effective limit multiplies by instance count.

Model *spend* is not affected: that is counted in Postgres per workspace and
per customer thread (`lib/metering.ts`), deliberately, and that is the control
that bounds money.

**What it would take.** A shared store — Redis, or a Postgres table with the
same shape as `model_calls`. The interface (`checkRateLimit(key, limit,
windowMs)`) is already the right one, so this is a swap and not a redesign.

### F-7 — `recordEvent()` inside a transaction writes outside it — **open**

**Severity:** low. **Pre-existing.**

`server/lib/events.ts`'s `recordEvent()` uses the module-level `prisma` client.
Several callers invoke it inside a `prisma.$transaction(...)` — notably
`v1/orders/[id]/stage/route.ts` — so if that transaction rolls back, the event
survives and the log claims something that did not happen.

Nothing in the new code does this: `execute.ts` and `ingest()` both collect
`TwinEffect`s and write them with the transaction's own client.

**What it would take.** An overload taking a `Tx`, and changing the handful of
in-transaction callers. Small, but it touches the audit path, so it wants its
own change and its own test rather than being bundled here.

---

## Reviewed and found sound

Each of these was read specifically, and the reason it holds is stated rather
than asserted.

**Tenant isolation.** `resolveWorkspaceId()` derives the tenant from the
credential and never from client input. A session may only *choose among* the
caller's own workspaces, re-checked every request; an API key *names* its
workspace and a disagreeing `x-workspace-id` is 403. A request carrying both a
cookie and a key is refused rather than resolved by precedence, which is the
right answer because either winner acts on a tenant the caller did not mean.

**Keyset pagination cannot widen a query.** The cursor carries the sort key,
not a row id, and is applied inside a `where` already scoped to the workspace —
so a forged cursor can only narrow. Deliberately not Prisma's `cursor` option,
which resolves the anchor outside the `where`.

**Secrets.** API keys are stored only as a SHA-256 hash under a unique index.
Channel credentials are AES-256-GCM encrypted at rest and never returned to the
browser. Webhook signing secrets exist in plaintext exactly once, in the
response that creates them. The Stripe key is read from the environment and
never logged.

**Injection.** Every query goes through Prisma's parameterised client. The two
raw statements are `resetDatabase()` (tests) and a `DROP DATABASE` in
`ci.test.ts`, both over file-local literals. The formula language has no
interpolation of any kind.

**XSS in the generated sites.** The one `dangerouslySetInnerHTML` is the
schema.org JSON-LD block, and it escapes `<` to `<` — a business name
containing `</script>` would otherwise end the block early. Everything else is
React children.

**SSRF.** Webhook subscription URLs must be `https` and must not be private or
link-local (loopback only outside production), and deliveries do not follow
redirects — which would re-post a signed body to a host nobody named.

**Webhook replay and forgery.** Every provider route verifies a signature over
the *raw bytes* before parsing, and idempotency is claimed on the provider's
own message id via a unique `ProcessedMessage` row, so a retried delivery
cannot run the ingest loop twice.

**Errors leak nothing.** One envelope, produced in one place; an unexpected
throw is logged server-side and becomes a bare `{"error":"Internal server
error"}`. A skill that throws returns the skill's own sentence, never a stack.

**Prompt injection and tool abuse.** The structural answer is the fact/voice
split: the model never computes a price, total, stock figure or discount, and
`sell()` discards a reply that offers money off, uses a banned phrase, or asks
permission for a sale already made. A model that invents a tool call is stopped
by the allowed-tool list; one that invents arguments is stopped by the schema;
one that invents an amount is stopped by the ceiling, which reads what was
committed rather than what was reported.

**Cross-tenant probing.** "No such agent" and "not your agent" return the same
refusal; so do "no such site" and "not your site", and "no such business
account" and "another tenant's business account". A distinct answer is an
oracle.

---

## Not claimed

No compliance assertion is made. PRD §9 lists "SOC 2 / HIPAA BAA ready"; this
review documents what is implemented and nothing about certification, process,
infrastructure or audit. PII/PHI detection and redaction are **not
implemented** — see `BLOCKERS.md` B-007.
