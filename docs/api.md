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
| `GET /v1/conversations` | Threads, newest activity first, one preview line each |
| `POST /v1/conversations` | Deliver a message and get the thread plus the reply |
| `GET /v1/conversations/{id}` | One thread with its messages |
| `GET /v1/products` | The catalogue, A–Z, with the workspace's suppliers |
| `GET /v1/products/{id}` | One product with its variants and live stock |
| `GET /v1/events` | The append-only twin event log, newest first |
| `POST /v1/events` | Record something that happened on your own site |
| `GET /v1/conversions` | Orders as conversions: exact paise plus first-touch attribution |

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
