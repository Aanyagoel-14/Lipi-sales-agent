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

---

## B-002 — Stripe: no secret key, so no checkout links

**Status:** MITIGATED.

PRD §2 Step 01 (`Stripe_Invoice`), §3 Phase 2 and §6 Use Case 1 all want a
checkout link. Stripe needs `STRIPE_SECRET_KEY` and this deployment has none.

**What was built instead.** `web/src/server/lib/payments.ts` is a provider
seam with two implementations: a real Stripe one (Checkout Sessions, one
form-encoded `fetch`, an `Idempotency-Key` derived from the invoice number so a
retried skill execution cannot create a second session) and a `none` provider
that returns **no link and the reason**. The `Stripe_Invoice` skill always
issues a real invoice — a row, a gap-free number, a due date from the
customer's segment, a downloadable PDF — and reports `checkoutUrl: null` with
`paymentProvider: "none"`. Both outcomes are written to the event trail.

**What needs a live key.** Only that the Stripe request shape is right.
Everything around it — idempotency, the failure path, what callers render — is
covered by `test/agents.test.ts` against a provider the test controls.

**Never done:** a link-shaped string nobody can pay. See `DECISIONS.md` D-010.

---

## B-003 — Google Calendar is not synced

**Status:** OPEN.

PRD §6 Use Case 2 ends "syncs Google Calendar". The Personal PA twin, the
scheduling arithmetic and the negotiation state machine are all built and
tested, and `CalendarEvent.source` already has a `google` member and a
`(profileId, externalId)` unique index so a re-sync updates rather than
duplicates.

What is missing is the OAuth connection and the sync itself. It needs Google
API credentials this deployment does not have.

The seam is the same one every other provider uses: `server/lib/composio.ts`
holds credentials and executes tools, and a calendar connector would be a
`ChannelSpec`-shaped entry beside the messaging ones. Nothing in
`scheduling.ts` or the negotiation skill would change — they read
`CalendarEvent` rows and do not care who wrote them.

---

## B-004 — The Python SDK has no parity yet

**Status:** OPEN. Not externally blocked; not yet built.

PRD §4 says "sandboxed TypeScript/Python SDK". The TypeScript half is
`web/sdk/` and is complete against the PRD's own worked example.

The Python half would need to reach the same executor, which means it is an
HTTP client against `POST /v1/agents/{id}/execute` rather than an in-process
library — a custom skill's *handler* has to run somewhere, and running
arbitrary Python inside this Node deployment is a sandboxing problem the PRD
does not ask anyone to solve. The honest Python shape is: define the skill in
Python, host it, and register its endpoint. That is a design decision worth
making deliberately rather than guessing at, so it is recorded here rather
than half-built.

---

## B-005 — No edge host for generated sites

**Status:** MITIGATED.

PRD §3 Phase 3 wants "global Cloudflare/Vercel Edge CDNs with automated SSL
provisioning, custom domain DNS". All three need credentials this deployment
does not have.

**What was built instead.** `web/src/server/sites/hosting.ts` is a provider
seam shaped exactly like `lib/payments.ts`. `POST
/v1/builder/sites/{slug}/deploy` answers **200 either way** and reports two
separate facts: where the site is served (always — this deployment's own origin
under `/s/{slug}`) and whether an edge host took it (`edge.ok`). No provider
means `edge.ok: false` with a reason naming the environment variable.

**What is not blocked, and is therefore real.** The site is genuinely served.
`/s/{slug}` renders the generated structure against live twin rows, with the
`generateMetadata` SEO tags, the schema.org JSON-LD and the sitemap the
generator produced, and the embedded assistant if the profile asked for one.
An operator can open it, send somebody the link, and watch the catalogue block
show the stock they actually have. What a provider would add is a CDN, a custom
domain and a certificate — not the site.

**A note on the Vercel adapter.** It is declared and it refuses. Vercel's
deploy API takes a file bundle, and what this generator produces is a structure
rendered by *this* server rather than a static export. Wiring it up properly
needs an export step that does not exist yet, and writing a plausible request
that has never been sent would be precisely the pretence the seam exists to
avoid. The refusal says so.

---

## B-006 — No reviews source

**Status:** OPEN.

PRD §3 Phase 2 lists "Google reviews" among the things that bind to UI
elements. There is no reviews connector and no Google credential.

The binding exists (`{ source: "reviews" }`) and resolves to an empty list with
a stated reason, which the renderer prints. Inventing testimonials for a real
business is not a placeholder — it is a lie about people who did not say
anything — and a test asserts the generated structure contains none.

---

## B-007 — Voice, ASR, VAD and telephony

**Status:** OPEN. This is the largest genuine gap against the PRD.

PRD §1, §6 Use Cases 3 and 4, §8 and §9 describe streaming Whisper ASR under
300ms, Silero VAD turn-taking, prosody and emotion models, PII/PHI NER,
Twilio SIP trunking, voice cloning and sub-400ms turn-taking.

Nothing in this repository touches audio. `services/voice.ts` is *brand* voice
— formality, banned phrases — and always was.

What each piece needs that is not here: an ASR provider (Whisper API or a
self-hosted model with a GPU), a VAD model, a TTS provider with a cloned voice,
a Twilio account with SIP trunking and a phone number, and a WebSocket
transport the current single-process Next deployment does not run.

**None of the §9 voice metrics — WER < 5%, sub-400ms turn-taking — will be
claimed.** They are marked `NOT VERIFIED` in `TRACEABILITY.md` §I and will
stay there.

---

## B-008 — `allowedOrigins` is writable by a `write`-scoped API key

**Status:** OPEN, deliberately deferred. Not externally blocked.

`PATCH /v1/workspaces/current` accepts `allowedOrigins` and resolves through
`resolveWorkspaceId()` with no `sessionOnly` flag, so a leaked API key can add
a browser origin from which keys may be used. The `/v1/api-keys` routes are
session-gated for exactly this class of self-perpetuation; this one is not.

Splitting `allowedOrigins` into a session-only route is a breaking change to a
published endpoint that no PRD requirement asks for. It belongs in a change of
its own with its own note in the API docs. See `SECURITY_REVIEW.md` F-5.

---

## B-009 — Rate limiting and `recordEvent()` in a transaction

**Status:** OPEN, documented. Both pre-existing.

Rate limits live in one process's memory, so a horizontally scaled deployment
enforces them per instance. The interface is already the right one, so a shared
store is a swap rather than a redesign. Model *spend* is unaffected — it is
counted in Postgres.

`recordEvent()` uses the module-level Prisma client, and a few callers invoke
it inside a transaction — so a rollback leaves an event claiming something that
did not happen. None of the code written for this effort does that. Fixing it
touches the audit path and wants its own change and test.

See `SECURITY_REVIEW.md` F-6 and F-7.

---

## B-010 — Slack, phone/VoIP, LinkedIn and Zoom/Teams

**Status:** OPEN. Not built.

PRD §1 and §2 Step 03 name eight channels. Four are real end to end (WhatsApp,
Telegram, Instagram DM, the Web SDK widget), plus three the PRD does not list
(Messenger, X, and Gmail outbound). These four are absent: zero occurrences in
`web/src`, not in the `Channel` enum, no env keys.

**What each needs.** Slack wants a Slack app and a bot token, and fits the
existing `ChannelSpec` shape directly — it is the cheapest of the four and the
only one that needs no new infrastructure. LinkedIn's messaging API is
partner-gated. Zoom and Teams are meeting platforms rather than message
channels, and belong with the voice work (B-007) rather than with the
registry. Phone/VoIP is B-007.

**Why not built here.** The registry makes a channel a spec plus two pure
functions, so the *shape* is done and adding one is a file. What is not done is
the credential, and a channel implemented against a provider nobody has
credentials for is a channel whose tool slugs and payload shapes were never
checked against reality — which is precisely the caveat already recorded
against X (`registry.ts:206`). Shipping four more of those would multiply that
risk rather than reduce it.

The deploy endpoint refuses a channel that is not connected, so an operator
cannot publish an agent to one of these and believe it is answering.

---

## B-011 — The Agent Studio canvas and the Instant Web Customizer

**Status:** OPEN. Not built.

PRD §7.2 and §7.3: a drag-and-drop node graph for triggers, guardrails,
fallbacks and escalation, and a split visual preview with a block library, a
theme-token editor and a prompt-driven layout modifier.

**What exists underneath them.** Everything both would edit. Guardrails,
skills, channels and escalation triggers are rows behind
`POST /v1/agents/builder/deploy`; site structure, blocks, bindings and theme
mode are rows behind `POST /v1/builder/sites/generate`, and
`/s/{slug}` renders them. Both are editable over HTTP today and covered by
tests.

**What is missing is the canvas itself** — a graph editor and a drag-and-drop
block editor, each a substantial piece of interface work with a dependency
(`react-flow` or equivalent) the repository does not have.

They are recorded rather than half-built: a node graph that renders but does
not change agent behaviour, or a block library that reorders a preview and not
the site, would be exactly the fake UI the master prompt forbids. The honest
position is that the *system* is there and the *canvas* is not.
