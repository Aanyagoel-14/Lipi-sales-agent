# The Lipi API

Everything an external site needs: customers, conversations, products, events and
conversions. The machine-readable contract is [`openapi.json`](./openapi.json), generated from
the same Zod schemas the route handlers validate against — point a client generator at it.

It is also served live at `GET /v1/openapi.json`, without a credential.

---

## Authenticating

```
Authorization: Bearer lipi_sk_…
```

Mint a key in the dashboard under **API keys**, or at `POST /v1/api-keys` while signed in. A key
belongs to exactly one workspace and every response is scoped to it; there is no parameter that
changes which tenant you are talking to.

| | |
| --- | --- |
| `read` scope | `GET` and `HEAD` |
| `write` scope | everything else, and implies `read` |

Keys are shown once. Rotate by minting a new one and revoking the old at
`DELETE /v1/api-keys/{id}` — a revoked key stops working immediately and its row stays, so
"what called with that key" still has an answer.

Do not send a session cookie and a key on the same request. That is a `400`, deliberately:
either winner would silently act on a tenant you did not mean.

## Pagination

Every list endpoint takes `limit` (1–200, default 50) and `cursor`, and answers with the rows
under their own name plus `nextCursor`:

```json
{ "customers": [ … ], "nextCursor": "MTc2ODY4ODAwMDAwMC5jdXNfMDE" }
```

`nextCursor` is `null` on the last page — loop until it is. The cursor is opaque: it encodes the
sort key of the last row, not an offset, so a row arriving mid-scroll never makes you skip or
repeat one. It cannot be pointed at another workspace's rows; a cursor from somewhere else
either narrows your own page or is refused as malformed (`422`).

## Errors

One envelope, at every status:

```json
{ "error": "That page cursor is not valid", "details": { "limit": ["Too big"] } }
```

`details` is present when a specific field failed and names it.

| Status | Means |
| --- | --- |
| `400` | A cookie and a key were sent together |
| `401` | Key unknown, malformed, revoked or expired — the four are deliberately indistinguishable |
| `403` | Key not scoped to this method, or names a different workspace |
| `404` | No such row **in this workspace** |
| `422` | Body or page parameters did not validate |
| `429` | Over the key's budget of 600 requests a minute. `Retry-After` says for how long |

## Conventions

- **Timestamps** are ISO-8601 strings and always end in `Iso` (`lastSeenIso`, `occurredIso`).
- **Money** in fields ending `Inr` is whole rupees, rounded for display. Fields ending `Paise`
  are the exact stored integer — reconcile against those.
- **Ids** are opaque strings. Do not parse them.

## Endpoints

| | |
| --- | --- |
| `GET /v1/customers` | Customer twins, most recently active first |
| `GET /v1/customers/{id}` | One twin |
| `GET /v1/conversations` | Threads, newest activity first, one preview line each. `?channel=whatsapp` narrows it, and repeats |
| `POST /v1/conversations` | Deliver a message and get the thread plus the reply |
| `POST /v1/conversations/ingest` | The same, in the PRD's own contract — see below |
| `GET /v1/conversations/{id}` | One thread with its messages |
| `GET /v1/products` | The catalogue, A–Z, with the workspace's suppliers |
| `GET /v1/products/{id}` | One product with its variants and live stock |
| `GET /v1/events` | The append-only twin event log, newest first |
| `POST /v1/events` | Record something that happened on your own site |
| `GET /v1/conversions` | Orders as conversions: exact paise plus first-touch attribution |
| `GET /v1/webhooks` | Endpoints this workspace delivers events to |
| `POST /v1/webhooks` | Subscribe an endpoint. The signing secret is in this response only |
| `GET`/`PATCH`/`DELETE /v1/webhooks/{id}` | One subscription: read, pause, repoint, remove |
| `POST /v1/webhooks/dispatch` | Run one pass of the outbound queue |
| `GET /v1/webhooks/deliveries` | Delivery log, newest first. `?status=dead` for the dead letter |
| `POST /v1/webhooks/deliveries/{id}/redeliver` | Queue a finished delivery again |

### Agents

| | |
| --- | --- |
| `GET /v1/agents/templates` | The agent templates you can start from, with their default guardrails |
| `GET /v1/agents/skills` | Every skill an agent can be assembled from |
| `POST /v1/agents/builder/deploy` | Build or re-publish an agent. An upsert on the name |
| `GET /v1/agents` | Every agent this workspace has built |
| `GET`/`PATCH`/`DELETE /v1/agents/{id}` | One agent: read, pause or resume, remove |
| `POST /v1/agents/{id}/execute` | Run one of the agent's skills |
| `GET /v1/agents/runs` | What the agents have done |

### Sites

| | |
| --- | --- |
| `POST /v1/builder/sites/generate` | Generate a site from a business profile |
| `GET /v1/builder/sites` | The sites this workspace has generated |
| `GET /v1/builder/sites/{slug}` | One site, with the structure it generated |
| `POST /v1/builder/sites/{slug}/deploy` | Ask an edge host to take it |
| `POST /v1/builder/sites/{slug}/quote` | A price from the site's own formula. **Public** |

### Inventory

| | |
| --- | --- |
| `POST /v1/inventory/reservations/sweep` | Give back the stock of every hold that has lapsed |

### The PRD's own paths

Three endpoints answer at `/api/v1/...` as well as `/v1/...`, because that is
how the product specification writes them: `conversations/ingest`,
`agents/builder/deploy` and `builder/sites/generate`. The alias re-exports the
canonical handler — the same function, not a copy — so there is one
implementation and the two prefixes cannot drift.

### Starting a conversation

```bash
curl -X POST https://your-lipi-host/v1/conversations \
  -H "Authorization: Bearer $LIPI_KEY" \
  -H "Content-Type: application/json" \
  -d '{"channel":"webchat","handle":"visitor-42","text":"do you have olive polos in L?","name":"Ravi"}'
```

The reply comes back in the same response. `handle` is your stable identifier for the person —
a phone number, an email, a visitor id. The same handle resolves to the same customer twin
every time, which is where continuity lives.

### Recording an event

```bash
curl -X POST https://your-lipi-host/v1/events \
  -H "Authorization: Bearer $LIPI_KEY" \
  -H "Content-Type: application/json" \
  -d '{"type":"cart.viewed","twin":"customer","payload":"sku=POLO-L-OLIVE qty=3"}'
```

The stored type is prefixed with `external.`, so nothing you post can be mistaken for something
Lipi's own ingest path observed. `occurredIso` is optional and may only date an event into the
past; a future timestamp is clamped to now. Events are append-only — there is no update and no
delete.

### Reading conversions

```bash
curl "https://your-lipi-host/v1/conversions?stage=Paid&stage=Shipped" \
  -H "Authorization: Bearer $LIPI_KEY"
```

`stage` is repeatable and optional. Which stages count as "converted" is your business decision,
so it is a parameter rather than something decided here. Each row carries `valuePaise` and the
customer's first-touch `attribution` — the UTM parameters and click id captured at their very
first visit and never overwritten — so a campaign can be credited without a second call per row.

### Receiving events

Everything above is you calling Lipi. A webhook subscription is Lipi calling you: every twin
event the workspace records — an order created, stock reserved, a lead scored — is POSTed to
your URL as it happens, so nothing has to poll `/v1/events`.

```bash
curl -X POST https://your-lipi-host/v1/webhooks \
  -H "Authorization: Bearer $LIPI_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://your-crm.example.com/hooks/lipi","eventTypes":["order_twin.created"]}'
```

`eventTypes` is a list of exact `type` values, as `GET /v1/events` reports them. Omit it for
every type. The URL must be `https` and resolve on the public internet. The response carries
`secret` once and never again — store it before you close the terminal.

A delivery looks like this:

```http
POST /hooks/lipi HTTP/1.1
Content-Type: application/json
X-Lipi-Workspace: cl…
X-Lipi-Event-Id: evt_m2x9k1a3
X-Lipi-Event-Type: order_twin.created
X-Lipi-Delivery-Id: cl…
X-Lipi-Attempt: 1
X-Lipi-Timestamp: 1758393600
X-Lipi-Signature: sha256=8f2c…

{"workspaceId":"cl…","deliveryId":"cl…","event":{"id":"evt_m2x9k1a3","atIso":"2026-09-20T18:00:00.000Z","type":"order_twin.created","twin":"order","payload":"ord_7 status=quoted value=4980"}}
```

**Verify before you trust it.** Recompute `HMAC-SHA256(secret, "<X-Lipi-Timestamp>.<raw body>")`,
hex-encode it, prefix `sha256=` and compare it constant-time to `X-Lipi-Signature`. Sign the raw
bytes, not a re-serialised object. Reject a timestamp older than your own tolerance — five
minutes is a reasonable one — which is what stops a delivery anyone once saw being replayed for
ever.

**De-duplicate on `event.id`.** Delivery is at-least-once: an attempt that fails ambiguously is
retried, so the same event id can arrive twice and the second one is not a second order.

Answer `2xx` as soon as you have durably accepted it, and do your own work afterwards. Anything
else and Lipi retries — after 30s, 2m, 10m, 30m and 2h, six attempts in all, and then the
delivery is **dead** and waits for a human. A `4xx` that is not `408` or `429` is not retried at
all: a wrong path does not become right in three hours. `GET /v1/webhooks/deliveries?status=dead`
is the dead letter, and `POST /v1/webhooks/deliveries/{id}/redeliver` puts one back in the queue.

Lipi has no scheduler of its own, so something has to run the queue: `POST /v1/webhooks/dispatch`
is the tick, and an API key is what lets a cron call it.

## Calling from a browser

Direct browser calls are off by default. Add the origins you want to allow:

```bash
curl -X PATCH https://your-lipi-host/v1/workspaces/current \
  -H "Authorization: Bearer $LIPI_KEY" \
  -H "Content-Type: application/json" \
  -d '{"allowedOrigins":["https://shop.example.com","http://localhost:5173"]}'
```

Scheme, host and optional port only — no path, no trailing slash, no `*`. Sending `[]` closes it
again. A response is readable cross-origin only from an origin **your** workspace listed; another
workspace's list can never open yours.

**A secret key in browser JavaScript is a published secret.** Anyone who views source has it,
and an allow-list does not change that — it only limits which pages a browser will hand the
response back to. Prefer one of these instead:

- **Anonymous visitors**: use the webchat widget endpoints (`/v1/webchat/{workspaceId}/…`),
  which need no key at all and are designed to be embedded in public page source.
- **Your own server**: keep the key there and proxy. See the React note.
- **A trusted browser context** — an internal tool behind your own login, where the key is
  injected per session rather than baked into a bundle — is what the allow-list is for.

---

## Deploying an agent

`POST /v1/agents/builder/deploy` takes the product specification's own body:

```json
{
  "agent_name": "Wholesale Sales Assistant",
  "skills": ["Inventory_Lookup", "Discount_Calculator", "Stripe_Invoice"],
  "knowledge_base_ids": [],
  "channels": ["WHATSAPP", "TELEGRAM", "WEB_SDK"],
  "guardrails": {
    "max_autonomous_discount_pct": 0.12,
    "human_escalation_triggers": ["DISPUTE", "REFUND_OVER_500"]
  }
}
```

It is an **upsert on `agent_name`**: publishing twice edits the agent rather
than growing a second one with the same name and half the traffic. A skill
removed from the list is actually removed; the configuration of a skill that
survives is kept.

Everything is validated before anything is written — the skills must exist, the
channels must be known **and connected**, the knowledge entries must be this
workspace's, and the guardrails must parse. Publishing to a channel that is not
connected is a `409`: an agent that is "live" and silent is worse than one that
failed to deploy.

`WEB_SDK` is the embedded widget and needs no connection; it is its own
transport.

## Executing a skill

`POST /v1/agents/{id}/execute` is the endpoint an external orchestrator — or a
model — calls to make an agent do something.

```json
{ "skill": "Inventory_Lookup", "arguments": { "product": "Polo Classic", "optionA": "L" } }
```

| | |
| --- | --- |
| `200` | it ran |
| `202` | it ran and a guardrail is holding the result for a person. `escalationReason` says which |
| `422` | it did not run: unknown skill, a skill this agent does not hold, or arguments that do not match the skill's schema. `details` names the field |

A `422` here is not a server error — you sent something that was understood and
not permitted, and the reason is written for a caller to act on.

## Conversation ingest, the specification's contract

`POST /v1/conversations/ingest` (also at `/api/v1/conversations/ingest`) takes
a different shape from `POST /v1/conversations`, because the product
specification prints it:

```json
{
  "source_channel": "WHATSAPP",
  "external_sender_id": "+254711998877",
  "payload": { "type": "text", "content": "Need 400 blue XL polos before Friday." },
  "metadata": { "business_account_id": "waba_991823" }
}
```

`metadata.business_account_id` is optional and **checked**, not ignored: it has
to name a channel connection in your workspace, on the channel you named. An id
that belongs to somebody else is a `404`, the same answer as one that does not
exist.

Only `payload.type: "text"` is ingested. Anything else is a `422` rather than a
`201` for a message that never reached anybody.

## Quoting from a generated site

`POST /v1/builder/sites/{slug}/quote` is public and CORS-enabled — a generated
site is served to strangers and the calculator on it has to work for them.

```json
{ "variables": { "BASE_VEHICLE_SIZE": 3, "COATING_GRADE": 120, "PAINT_CORRECTION": true } }
```

It answers `{ "amountMinorUnits": 61000 }`. The formula never leaves the
server.

A variable the formula needs and the request did not supply is a `422`, never a
zero: quoting a price from a value nobody gave is how a customer is promised
something the business did not agree to.
