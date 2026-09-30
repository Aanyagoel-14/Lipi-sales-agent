# ADR 0002 — X direct messages ship as a channel, with inbound built directly against X

- **Status:** accepted, 2026-09-20
- **Deciders:** Lipi engineering
- **Amends:** ADR 0001, which deferred X DMs to a gated later phase

## Context

ADR 0001 surveyed every toolkit on 2026-09-19 and recorded `TWITTER | none` for inbound
triggers, then listed "X DMs are deferred (phase C5, gated) until per-DM cost and a poller
on the job runner are acceptable" as a consequence. Issue #26 (P8) asks for the channel
now, and it anticipates the finding: *if Composio has no usable X trigger, say so and
implement the inbound half directly against X's API.*

Rechecked on 2026-09-20 against the toolkit's own page: the `twitter` toolkit is
`"triggerCount": 0`, version `20260812_00`, 79 tools, OAuth2 only. So ADR 0001's table
still holds, and the "poller on the job runner" the deferral waited for turns out not to
be needed — X has a webhook product (Account Activity), which is what makes the channel
possible without polling at all. Per-DM cost remains, and remains the business's gate on
volume rather than an engineering one; nothing here sends a DM that `sell()` did not
already decide to send.

## Decision

X is a channel: `x` in the `Channel` enum, one registry spec, Composio for credentials and
outbound, Lipi for inbound — the same split ADR 0001 chose for Meta and Telegram.

**Inbound is shaped like Meta's, not like Telegram's.** X registers a webhook against an
*app*, not an account: `POST /2/webhooks` takes one URL for the whole deployment, validates
it with a challenge signed by the app's consumer secret, and signs every later delivery
with that same secret. The subscribed account is named in the payload's `for_user_id`. So
there is one route, `POST /webhooks/x`, verified against `X_API_SECRET` and routed by
`(channel, externalId)` — exactly the Meta arrangement. A URL per connection, as Telegram
has, would prove nothing extra, because the secret behind every one of them would be
identical.

**Rate and length limits are properties of the spec.** `ChannelSpec.inboundLimit` is new
and optional; absent means the shared default in `inbound.ts`. X declares 30 deliveries per
15 minutes: `POST /2/dm_conversations/with/:participant_id/messages` allows 15 per 15
minutes per user, and X delivers our own replies back on the same webhook, so twice the
send ceiling is the most a conversation being kept up with can produce — and past it there
is no reply left to send. `textLimit` is 10,000, X's DM limit, which means a reply is never
split; splitting would bill twice.

**The echo is dropped in the parser.** X delivers both directions of a conversation, so the
reply just sent returns as an event whose sender is the shop's own account. Answering it
would be the twin talking to itself, and it is dropped the way an Instagram echo is.

**The subscription is the per-tenant part of connect, and is not withdrawn on disconnect.**
`afterConnect` executes `TWITTER_CREATE_ACTIVITY_SUBSCRIPTION` against the deployment's
`X_WEBHOOK_ID` and throws if X refuses, so a channel that cannot receive never reads
"Live". Removing the subscription needs the app's *bearer* token, which Composio does not
hold, so disconnect clears the id inbound routes on instead and a later delivery is dropped
at the door. That is the same answer Telegram gives to the same problem, and DEPLOYMENT.md
documents the one curl that removes it for good.

## Alternatives considered

- **Wait for a Composio trigger.** Rejected: the toolkit has had zero triggers across both
  checks, and nothing suggests one is coming. The issue asks for the channel, not a wait.
- **A URL per connection, as Telegram has.** Rejected: X's webhooks are app-scoped and its
  challenge and signature both key on the app's consumer secret, so per-connection URLs
  would multiply registration against X's per-app webhook limit and buy no isolation.
- **Polling `TWITTER_GET_RECENT_DM_EVENTS`.** Rejected for the reasons ADR 0001 rejected
  polling generally, plus one specific: DM lookup allows 15 requests per 15 minutes per
  user, so a poller could not even run once a minute for one tenant.
- **Subscribing through Composio's proxy rather than the toolkit's tool.** Rejected: a tool
  covers this endpoint, and `proxy` is reserved for endpoints no tool covers.

## Consequences

- A deployment offering X needs its own X app on a tier with Account Activity access, the
  webhook registered once against `PUBLIC_URL/webhooks/x`, and `X_API_SECRET` +
  `X_WEBHOOK_ID` set. Boot fails if `COMPOSIO_AUTH_CONFIG_X` is set without them.
- X marks a webhook invalid if it stops answering the hourly challenge, so rotating
  `X_API_SECRET` without re-validating silently stops inbound.
- The `twitter` pin (`20260812_00`) and its two tool slugs come from the toolkit's public
  page, not from an authenticated `GET /toolkits/twitter`: this environment has no Composio
  key. The argument names (`participant_id`, `text`, `webhook_id`) are X's own. Both want
  confirming against a live project before the channel is offered to a tenant.
- X's own documentation marks the Account Activity API as being deprecated in favour of the
  X Activity API. The envelope this parses is the one X documents today; a migration is a
  later change to one parser and one route.
