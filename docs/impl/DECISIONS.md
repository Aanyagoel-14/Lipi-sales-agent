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

---

## D-003 — Agents and skills are rows and a registry, not branches

**Derives from:** PRD §2 Step 01, §4; master prompt §7 ("registry/plugin
pattern, not a switch statement in an agent class") and §9.

Before this, a workspace had exactly one implicit agent and "which agent acted"
was a string literal chosen by a branch inside `ingest()` — `"Sales"`,
`"Inventory"`, `"Procurement"`, `"Support"`. That is a reasonable shape for a
fixed product and an impossible one for a builder: there is nothing to
configure, nothing to deploy and nothing for a guardrail to attach to.

**Decision.** Two new tables (`agents`, `agent_skills`), and a skill registry
modelled directly on `server/channels/registry.ts` — one array of declarative
specs plus a pure `run`. `AgentRun` gains a nullable `agentId` and `skill`.

`AgentSkill.skill` is a **registry slug, not a foreign key**: skills are code,
they ship with a release, and a table of them would let a tenant name one with
no implementation. Deploy refuses a slug the registry does not know.

**`ingest()` was deliberately not rewritten.** Its four role names are not
rows and never were, so `AgentRun.agentId` is nullable and the built-in
commerce loop keeps raising runs exactly as before. Rewriting the one code path
that mutates every twin inside a single transaction, in the same change that
introduces the thing it would be rewritten onto, would put 800 passing tests
and invariant 1 at risk for no capability that is not already delivered by the
registry standing beside it.

**Rejected:** a `Skill` table (lets a tenant name an unimplementable skill); a
`skills` JSON column on `Agent` (no way to configure or disable one
individually); making `ingest()` dispatch through the registry in this
milestone (see above — it is a later, separately testable change).

---

## D-004 — One executor, and it is the security boundary

**Derives from:** master prompt §19 ("agent tool execution is a hard security
boundary … enforce and test: allowed-tool lists, argument schemas,
authorization, guardrails, tenant context, audit logging, maximum values,
escalation rules").

**Decision.** `server/agents/execute.ts` is the only place a skill runs, and
every check lives there rather than inside the skills. Nine of them, in order:
the skill exists; the agent is this workspace's; the agent holds the skill; it
is enabled; the arguments satisfy the skill's own schema; nothing in the
request trips an escalation trigger; the quoted value is inside
`maxSingleQuoteValue`; the customer has no past-due invoices; the workspace's
approval policy allows it.

A check inside a skill is a check the *next* skill's author has to remember to
copy, and the caller is in the general case a language model choosing a
function name and a bag of arguments.

Two properties worth stating because they were choices:

- **A refusal is a value, not an exception.** A model that asks for something
  it may not have gets a structured "no" it can act on. `POST
  /v1/agents/{id}/execute` renders that as **422**, and a held result as
  **202** — the work is real and waiting for a person, which is neither
  success nor failure.
- **The post-checks can only hold a result back; they never edit one.**
  Quietly halving a number to fit a ceiling would be the fact/voice split
  broken from the other end.

**Rejected:** guardrail checks inside each skill (copied and forgotten);
clamping an over-ceiling quote to the ceiling (hands the customer a number
nobody authorised and tells the operator a discount was granted).

---

## D-005 — `/v1` stays canonical; the PRD's `/api/v1` paths are aliases

**Derives from:** PRD §3.1 and §8.1, which write `/api/v1/...`; master prompt
§12 and §31.

This API has always served `/v1`. ~70 route modules, the generated OpenAPI
document, the dashboard's own fetch helpers and every existing integrator use
that prefix; `next.config.ts` has no rewrites and there is no middleware.

**Decision.** `/v1` stays canonical. The three endpoints the PRD names by path
also answer at `/api/v1/...`, through a module that re-exports the canonical
handlers — the same function object, not a copy, so there is one
implementation and no way for the two to drift. Recorded in
`src/app/api/v1/README.md` next to the aliases.

**Rejected:** moving everything to `/api/v1` (a breaking change to a published
API for a path segment); serving only `/v1` (an integrator reading the PRD
would be wrong, and the PRD is the specification).

---

## D-006 — The PRD's ingest contract is translated, not adopted

**Derives from:** PRD §8.1.

The PRD's inbound body is `{ source_channel, external_sender_id, payload: {
type, content }, metadata: { business_account_id } }` — upper-case channels,
snake_case, nested. The repository speaks `{ channel, handle, text, name }`.

**Decision.** `POST /v1/conversations/ingest` accepts the PRD's body exactly as
printed and translates it, then calls the same `sell()` every channel webhook
uses. Neither vocabulary leaks past that module.

Two sub-decisions worth recording:

- It calls **`sell()`, not `ingest()`**. `ingest()` decides what is true and
  composes a plain reply; `sell()` runs `ingest()` and lets the model voice
  the facts it produced. An integrator posting a customer message wants the
  reply the customer would have got.
- **`metadata.business_account_id` is checked, not ignored.** It names a
  channel connection, and a caller naming one that belongs to another tenant
  or to another channel is told so. Ignoring it would let an integrator believe
  they had routed a message somewhere they had not.

---

## D-007 — `payload.type` other than `text` is refused, not dropped

**Derives from:** PRD §8.1, whose contract carries a `type` field; master
prompt §6 and §21.

Nothing in this deployment can read an image, an audio file or a document.

**Decision.** The field is accepted and validated, and a non-text type answers
**422** naming what is supported. Silently ingesting the caption, or accepting
and dropping the message, would be a 201 for a message that never reached
anybody.

---

## D-008 — The SDK lives in the repository and shares the runtime

**Derives from:** PRD §4; master prompt §10.

**Decision.** `@lipi-ai/sdk-node` is `web/sdk/`, mapped by a `tsconfig` path
and a vitest alias so the PRD's own import line resolves verbatim. A
`CustomSkill` produces exactly the `SkillSpec` a built-in skill produces and is
executed by exactly the boundary in `execute.ts` a built-in one is.

A custom skill therefore gets the allowed-tool check, the argument schema, the
guardrails, the tenant scoping, the transaction and the audit trail for free —
and, more to the point, cannot skip any of them.

Three translations happen at that boundary and nowhere else:

1. **JSON-schema-ish parameters → Zod**, strictly, so an argument nobody
   declared is refused rather than dropped, and `NaN`/`Infinity` are refused
   although `z.number()` accepts them.
2. **Major units → integer minor units**, once, rounding half away from zero.
   The PRD's handler computes `unitPrice` as a float and its guardrail says
   `maxSingleQuoteValue: 25000`; both are read as major units.
3. **snake_case draft fields → camelCase**, because §4.1 writes
   `custom_specs` / `calculated_unit_price` / `estimated_lead_days`.

The SDK also records the largest draft value a handler committed, so
`maxSingleQuoteValue` is checked against what the handler *did* rather than
against what it chose to report.

**Rejected:** a published npm package (a second executor is a second set of
checks to get wrong); a separate sandbox process (no capability the shared
executor does not already give, and a large amount of new surface).

---

## D-009 — Prices are in the workspace's minor units, and the PRD's dollars are read as such

**Derives from:** PRD §4.1 and §6 Use Case 1 (both in US dollars); invariant 4.

This codebase stores integer paise and renders `…Inr` fields. The PRD's
examples are in dollars.

**Decision.** Nothing is converted and no currency column is added. Every
amount is "integer minor units of whatever this deployment sells in", which is
what the storage layer has always meant, and the PRD's `$8.50` and `25000` are
read as 850 and 2,500,000 minor units. `STRIPE_CURRENCY` names the ISO code
that goes on a payment page and is the only place a currency is asserted.

**Rejected:** a per-workspace currency column (a real feature, with display,
rounding and FX consequences across 70 endpoints, that no PRD requirement
actually asks for); converting the PRD's figures to rupees (invents an
exchange rate).

---

## D-010 — A checkout link is real or absent, never plausible

**Derives from:** PRD §2 Step 01 (`Stripe_Invoice`), §3 Phase 2, §6 Use Case 1;
master prompt §6 and §29.

Stripe needs a secret key and this deployment has none.

**Decision.** `server/lib/payments.ts` is a provider seam with a real Stripe
implementation and a `none` provider that **returns no link and says why**. The
`Stripe_Invoice` skill always issues a real invoice — a row, a gap-free number,
a due date from the customer's segment, a downloadable PDF — and returns
`checkoutUrl: null` with `paymentProvider: "none"` when no provider is
configured. Both outcomes are written to the event trail.

A link-shaped string nobody can pay is worse than no link: the customer
believes they have been sent a way to pay, and the first person to find out
otherwise is the customer.

---

## D-011 — The PA twin's constraints are rows, and scheduling is pure arithmetic

**Derives from:** PRD §5 (Personal PA Twin) and §6 Use Case 2; invariant 2.

**Decision.** `PaProfile`, `CalendarEvent` and `SchedulingNegotiation` are
tables; `server/agents/scheduling.ts` is a pure function over plain data with
no database, no clock of its own and no model.

A model may read "avoid mornings" out of a sentence. It may not decide whether
14:00 on Wednesday is free — the owner's buffers, focus blocks and daily
ceiling are facts, and a plausible-sounding answer to a factual question is
just a wrong answer said confidently.

Sub-decisions:

- **Instants are stored UTC and compared UTC**; the owner's zone is read off
  their profile and used only for questions that are about their day. Asserted
  across a daylight-saving boundary, because every scheduler bug is that.
- **A negotiation persists.** "Find 45 minutes with Dr. Chen" is a proposal,
  possibly a counter, and a confirmation, spread over hours. The constraints
  are parsed once and every later turn is decided against the stored ones.
- **Only a slot that was actually offered may be confirmed.** Otherwise
  confirmation steps around every rule the proposal step exists to enforce.
- **A counter-offer is checked against the owner's rules**, not accepted
  because the counterpart suggested it. Their own stated preferences are
  waived — they may have changed their mind — the owner's are not.
- **`blockedMostlyBy` excludes structural reasons.** Over any horizon longer
  than a day most of a 15-minute grid is outside working hours; reporting that
  as the cause is true, useless, and hides the reason the operator could act
  on. A test asserts the ranking.

---

## D-012 — Deploy is an upsert, and every check happens before any write

**Derives from:** PRD §2 Step 03, §8.1; master prompt §6.

**Decision.** `POST /v1/agents/builder/deploy` upserts on
`(workspaceId, agent_name)`. Publishing twice is how an operator edits an
agent; a second row with the same name and half the traffic is what makes
telemetry lie. A skill removed from the list is actually removed; the
configuration of a skill that survives is kept.

Everything is validated before anything is written: the skills exist, the
channels are known **and connected**, the knowledge entries belong to this
workspace, the guardrails parse. An agent published to a channel it cannot
answer on is "live" and silent, and the operator finds out from an empty inbox.

Webchat is exempt from the connection check — the widget is its own transport.

Whether a deploy was a first publish is taken **from the transaction**, not
from comparing `createdAt` to the clock. The clock-based version reported
`agent.deployed` twice when two deploys landed inside a second, which is
exactly the class of bug D-002 was.

---

## D-013 — The quote formula is a parser, never `eval`

**Derives from:** PRD §3.1, which puts
`BASE_VEHICLE_SIZE * COATING_GRADE + (PAINT_CORRECTION ? 250 : 0)` in the
request body; master prompt §19.

An operator types an expression into a form and a stranger's browser then asks
for a price computed from it.

**Decision.** `web/src/server/sites/formula.ts` is a tokeniser and a Pratt
parser over a deliberately tiny grammar: numbers, variables, arithmetic,
comparison, a ternary, grouping, unary minus and not. No function calls, no
property access, no assignment, no strings, and no way to name anything the
evaluator did not put in scope.

Three things this caught that are worth recording, because each was a real
hole found by writing the test rather than by reading the code:

1. **`name in scope` was wrong.** Every object literal inherits `constructor`,
   `toString`, `hasOwnProperty` and `__proto__` from `Object.prototype`, so
   `"__proto__" in scope` is true for a scope that has never heard of it, and
   the lookup returned a function that flowed into the arithmetic as `NaN` and
   out the other side as a price. It is `Object.hasOwn` now, and the value must
   be a number or a boolean.
2. **Source length is not a bound on nesting.** 1,500 open parentheses is 1,501
   characters and 1,500 stack frames. There is an explicit depth limit of 20.
3. **A missing variable is an error, never a zero.** Silently treating
   `PAINT_CORRECTION` as false quotes a price the business never agreed to and
   nobody finds out until the invoice.

Division by zero and a negative result are refused for the same reason: both
render as a price, and the customer is the one who finds out.

---

## D-014 — The generated structure holds no business data

**Derives from:** PRD §3 Phase 2 — "Product/Service Twins, dynamic quote
formulas, Stripe checkout links, and Google reviews automatically bind to UI
elements without manual SQL migrations or backend glue code".

**Decision.** A block carries a *binding*, not data. `{ source: "catalogue",
limit: 12 }` means "the products this workspace stocks"; it does not carry
products. `resolveBlocks()` reads the bindings on every request and fetches
live rows.

That is what makes the PRD's sentence true rather than decorative: a site
generated in March shows September's prices in September, and adding a product
changes every generated site that binds to the catalogue, with no migration and
no regeneration.

**Rejected:** materialising the catalogue into the structure at generation
(fast, and wrong by the first price change); a build step per site (a static
export that is stale the moment stock moves).

---

## D-015 — The structure is generated deterministically; only copy is a model's job

**Derives from:** PRD §3 Phase 1, which says "the LLM generates responsive
Tailwind/React components, semantic schema, and sitemaps"; invariant 2.

**Decision.** Which pages exist, which blocks are on them, what each binds to,
what the schema.org document says and what the sitemap lists are computed from
the business profile by code. Each block carries an empty `body` slot for
model-written copy.

A structure is a set of *facts* about a business — this shop takes bookings,
that one publishes a catalogue — and a model asked to invent one will
eventually generate a booking page for a business that cannot take bookings. A
headline is words, and words are exactly what a model should write. Keeping
them apart means copy can be regenerated without moving a page, and the same
profile always produces the same structure, which is what makes a regenerate
safe and a test meaningful.

---

## D-016 — A generated site is actually served

**Derives from:** master prompt §6 ("never implement only the UI") read in
reverse, and §32.

**Decision.** `/s/{slug}` and `/s/{slug}/{...path}` render the structure
against live twin rows, with `generateMetadata` SEO tags, the JSON-LD and the
embedded assistant. The deploy endpoint reports two separate facts — where the
site is served (always) and whether an edge host took it (`edge.ok`).

Without this, "generated a website" means a row of JSON an operator has to take
on trust. Conflating "generated" with "deployed to a CDN" is how an operator
ends up sending a customer a link that does not exist.

The pricing maths never reaches the browser. The quote block ships the variable
*names* and an endpoint; the formula stays on the server, because a visitor's
page source would otherwise carry the business's margin.

---

## D-017 — The PRD's palette is the generated sites' theme

**Derives from:** PRD §3.1 (`theme_mode: "DARK_SLATE_PREMIUM"`) and §8.1.

**Decision.** `web/src/server/sites/theme.ts` holds §8.1's five colours
verbatim — `#0B0F19`, `#111827`, `#6366F1`, `#10B981`, `#EF4444` — as
`DARK_SLATE_PREMIUM`, emitted as CSS custom properties on the page.

Custom properties rather than Tailwind classes because a generated site's theme
is chosen per site at request time and Tailwind's classes are decided at build
time. The blocks reference the tokens, so `theme_mode` changes appearance
without changing markup.

This is the *generated sites'* palette. Applying it to Lipi's own dashboard is
G-4 and a separate change — that app has a carefully built light theme with
measured contrast ratios recorded per token, and re-theming it is a piece of
work with its own verification, not a find-and-replace.

---

## D-018 — The order state machine gains `Inquiry` and `Confirmed`, and that is a breaking change to transitions

**Derives from:** PRD §5, Order & Supply Twin — "State (Inquiry → Quote →
Confirmed → Paid → Packed → Shipped)"; master prompt §31.

The stored chain was `Quoted → Paid → Packed → Shipped → Delivered`, with
`Returned` reachable from anywhere, and `POST /v1/orders/{id}/stage` enforcing
one step forward.

**Decision.** `Inquiry` and `Confirmed` are added. `Quoted` keeps its spelling
— it is this codebase's word for the PRD's "Quote", and renaming a stored enum
member to change a participle is not worth a migration. `Delivered` and
`Returned` stay; an order that has shipped still has to arrive.

**What breaks, precisely.** The *vocabulary* is additive — no member changed
spelling and none was removed — so a consumer that reads stages keeps working,
and `docs/openapi.json` gained two enum values and nothing else. The
*transition rule* is not additive: a caller that moved `Quoted → Paid` now has
to move `Quoted → Confirmed → Paid`, and gets a 409 naming the next stage if it
does not.

**Consumers checked and updated.** One test exercised the endpoint
(`test/tenancy.test.ts`, a 404 case, unaffected). Shopify's importer writes
stages directly rather than transitioning, so it is unaffected. The dashboard's
`StageAction` reads the next stage from the API. Nothing else in the repository
calls it.

**Rejected:** allowing a skip over `Confirmed` (then it is not a state, it is a
label, and the four-hour hold has nothing to end on); a compatibility window
accepting both (two transition rules, and the wrong one is the one that stays).

---

## D-019 — A reservation lapses after four hours, and confirming makes it permanent

**Derives from:** PRD §5 — "Locks reserved stock for 4 hours upon checkout link
generation".

`Variant.reserved` only ever went up until an order settled. A customer who
asked for four polos and never came back held four polos for ever, so the twin
reported the business as having less to sell than it had — and the more quotes
it produced the wronger it got, which is the worst shape a bug can have because
the system punishes its own success.

**Decision.** `Order.reservedUntil`, stamped when `ingest()` reserves, cleared
when the order reaches `Confirmed`. `releaseExpiredReservations()` gives back
the stock of any lapsed hold on a provisional stage, and is reachable as a tick
at `POST /v1/inventory/reservations/sweep` — the same shape as
`/v1/webhooks/dispatch`, because this deployment has no scheduler.

Sub-decisions:

- **Null means "does not lapse."** That is what an order past `Confirmed`
  carries, and it is also what every pre-existing order carries. Backfilling
  history to a four-hour window would have released stock a live quote was
  legitimately holding, so the migration writes nothing.
- **The sweep is per workspace and bounded to 500.** A tick that swept every
  tenant would be a tick any tenant could make expensive.
- **The release re-reads inside its transaction and clamps the decrement at
  zero.** Two sweeps racing must not decrement the same reservation twice, and
  stock arithmetic that can go negative produces a twin reporting negative
  availability.

---

## D-020 — Credit risk and VIP routing flag; they never refuse

**Derives from:** PRD §5, Customer/Lead Twin — "flags credit risk if past-due
invoices > 0", "routes VIP inquiries instantly".

**Decision.** Both are read once per message, after the customer twin is
settled, in `services/twin-rules.ts`. `creditRisk` derives what is owed from
payments rather than from a stored status, because `services/billing.ts` is
explicit that storing it lets the total drift — and two definitions of "paid"
is how a customer gets chased for money they sent.

Neither refuses a sale. The credit verdict lands on `Order.creditHold`, on the
event trail, and — through the skill executor — on the approval a money skill
raises. Declining a sale because an invoice is late is a decision with a
relationship attached to it, and not one to make unattended.

The VIP threshold (`VIP_LIFETIME_VALUE`) is a figure the PRD does not give. It
is named, and it sits next to the rule it governs rather than inline in a
condition where the next reader has to work out what the number meant.

---

## D-021 — Crossing the reorder point raises a purchase order, not a sentence

**Derives from:** PRD §5 — "Auto-dispatches POs when reserved inventory drops
below threshold".

Crossing the threshold used to push an `AgentRun` whose `action` read "Draft
restock of …". Prose in a log: nobody can count it, reconcile it against what
arrived, or send it to a supplier.

**Decision.** A `PurchaseOrder` row, at `draft`, for the supplier's MOQ or the
shortfall back to twice the reorder point, whichever is larger — ordering below
a minimum is an order the supplier refuses, and ordering exactly the shortfall
puts the twin back at the threshold it just crossed. `expectedOn` is the
supplier's own average lead time.

**`draft`, never `sent`.** Dispatching money to a supplier is a commitment and
there is no supplier integration here to dispatch through. What is automatic is
the *raising*.

**De-duplicated per variant.** The reorder point is crossed again by every
subsequent message until stock arrives; a rule that raised a PO each time would
bury the operator in duplicates of a decision they had already made. The
`AgentRun` is still raised either way, so the operator sees the threshold was
hit — only the PO is de-duplicated.

---

## D-022 — The auth throttle does not bucket "unknown" as an address

**Derives from:** master prompt §19; `SECURITY_REVIEW.md` F-3.

`clientIp()` answers `"unknown"` when no `x-forwarded-for` or `x-real-ip` is
set. The first version of the throttle keyed on that value like any other, and
the full suite immediately went red: every test that logs in shares one bucket,
so the twenty-first `signedIn()` of the run was refused.

That is a test failure exposing a **production** bug. A deployment not behind a
proxy that sets those headers would put every one of its users in one bucket,
and the first twenty failed logins would lock out everybody — while an attacker
who sets the header themselves would not be in that bucket at all. The control
would be simultaneously useless and dangerous.

**Decision.** When the address is unknown, the per-address ceiling is skipped
and the per-email one still applies. You cannot rate-limit by address without
an address, and the per-email ceiling is the half that actually protects a
password.

The suite also resets the limiter in `test/setup.ts`'s `beforeEach`, alongside
the Composio, Shopify and webhook fakes — rate limits are process-global state
and the whole suite shares one process, so one file's attempts would otherwise
be spent on behalf of every file after it.

---

## D-023 — Inbox selection is a URL, not client state

**Derives from:** PRD §7.1 (the split-pane workspace); master prompt §6.

The thread list rendered inert `<li>`s and the page always opened
`conversations[0]`. It looked like a selector and selected nothing, and a
keyboard user could not reach a second thread at all — the same category of
defect as a button that claims to deploy an agent and does not.

**Decision.** A thread is `?thread=<id>` and the feed is `?channel=<name>`,
both read by the server component. Rows are `<Link>`s.

Selection *could* have been `useState`, since the transcript is already on the
page — but it is not: the list carries previews only and a transcript is
fetched by id, so opening one is a real navigation. Making it a URL gives it a
link an operator can send to a colleague, a working back button, and rows that
are genuinely links to anything reading the page rather than looking at it.
`scroll: false`, because below `xl` the transcript sits *above* the list and
jumping to the top of the document on every selection would push it off screen.

**The channel rail filters on the server.** `/v1/conversations` takes a
repeatable `?channel=`. Filtering the loaded page in the browser would show
three of fifty rows and call it the WhatsApp feed, and the cursor would go on
paging through the unfiltered list underneath it. `usePaged` now carries the
filter into later pages for the same reason, and resets its rows when the
filter changes.

The rail offers only channels this workspace has actually heard from: a filter
that can only ever return nothing is a control that teaches an operator to
distrust the others.
