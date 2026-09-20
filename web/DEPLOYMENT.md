# Deployment Guide (Node host — NOT Cloudflare Pages)

This app is a stateful Next.js 16 application (server-rendered pages,
Prisma against PostgreSQL, `after()`-scheduled background work on inbound
webhooks, Node-only crypto). It must run on a real Node.js runtime — it
does **not** deploy to Cloudflare Pages/Workers, Vercel Edge functions, or
any other edge/isolate runtime that lacks Node APIs and a persistent
process model.

Suitable targets: any VM/container host with Node 20+ and outbound network
access to your Postgres instance — e.g. a plain VPS, Railway, Render,
Fly.io, AWS ECS/EC2, or your own Docker host. The instructions below are
host-agnostic and centre on Docker, which works on all of them.

## 1. Prerequisites

- **PostgreSQL 14+** reachable from the host. Managed (RDS, Neon, Supabase,
  Railway Postgres) or self-hosted both work — nothing here is Postgres-
  flavour-specific beyond standard SQL.
- **Node.js 20+** if not using Docker.
- A domain / public URL the app will be served from (`PUBLIC_URL`) —
  channel webhooks are registered against this URL, so it must be a real,
  HTTPS-reachable address before you connect a channel. For local
  development use a tunnel (`cloudflared tunnel --url http://localhost:3000`,
  `ngrok http 3000`) and set `PUBLIC_URL` to the tunnel's HTTPS origin:
  Telegram refuses a plain-HTTP webhook and Meta will not deliver to one.

## 2. Environment variables

Copy `.env.example` to `.env` (or set these as real environment variables /
secrets in your host — never commit `.env`):

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | `postgresql://user:pass@host:5432/dbname` |
| `APP_SECRET` | yes | ≥16 random chars. Encrypts every stored channel/connector secret. **Generate once, store safely, never rotate casually** — rotating it invalidates every stored credential and every connected channel/connector must be reconnected. |
| `PUBLIC_URL` | yes | This deployment's own public HTTPS origin, e.g. `https://app.example.com`. Used to build webhook URLs handed to Telegram/Meta. |
| `OPENROUTER_API_KEY` | no | Enables LLM-based intent extraction and the operator's twin-chat feature. Without it, intent extraction falls back to deterministic rules (still fully functional, just less flexible on ambiguous phrasing) and twin-chat is unavailable. |
| `OPENROUTER_MODEL` | no | Defaults to a fast model; used for per-message intent extraction. |
| `OPENROUTER_CHAT_MODEL` | no | Used only for the operator's own twin-chat, can be a stronger/slower model. |
| `NODE_ENV` | no | Set to `production` in production. |
| `COMPOSIO_API_KEY` | no | Composio holds every channel credential and runs every send. Without it no channel can be connected and only webchat works. |
| `COMPOSIO_AUTH_CONFIG_*` | no | One auth config id per channel (`WHATSAPP`, `INSTAGRAM`, `FACEBOOK`, `TELEGRAM`, `GMAIL`). A channel with no id is listed as unavailable. |
| `COMPOSIO_WEBHOOK_SECRET` | no | Signs Composio's own deliveries to `/webhooks/composio`. Printed once by `npm run composio:subscribe`. |
| `META_APP_SECRET` | **when a Meta channel is offered** | Lipi's Meta app secret. Every inbound WhatsApp / Instagram / Messenger body is verified against it. |
| `META_VERIFY_TOKEN` | **when a Meta channel is offered** | Any long random string. Meta echoes it once, when the callback URL is registered. |

The last two are enforced: if any of `COMPOSIO_AUTH_CONFIG_WHATSAPP`,
`COMPOSIO_AUTH_CONFIG_INSTAGRAM` or `COMPOSIO_AUTH_CONFIG_FACEBOOK` is set
and either Meta key is missing, the app refuses to start. A Meta channel
whose webhooks cannot be verified accepts nothing and reports nothing, and
an empty inbox is a worse way to find that out than a failed boot.

Generate `APP_SECRET`:
```bash
openssl rand -base64 32
```

## 3. Database migrations

Migrations are checked into `prisma/migrations/` and must be applied with
`migrate deploy` (not `migrate dev`, which is interactive and expects a
dev database):

```bash
npx prisma migrate deploy
```

Run this **before** starting the app for the first time, and again after
pulling any update that adds a migration. It is idempotent — safe to run
on every deploy.

## 4. Build and run

### Option A — Docker (recommended)

Add this `Dockerfile` at the project root (not present in the archive by
default — create it before building):

```dockerfile
FROM node:20-slim AS base
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npx prisma generate
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000
CMD ["sh", "-c", "npx prisma migrate deploy && npm start"]
```

```bash
docker build -t lipi-ai .
docker run -p 3000:3000 --env-file .env lipi-ai
```

Running `prisma migrate deploy` in the container's start command (rather
than only at image-build time) means a fresh deploy always catches up the
database before the app starts serving — safe for a single-instance
deploy. If you run multiple instances behind a load balancer, run
migrations once as a separate release step instead of on every container
start, to avoid concurrent migration races.

### Option B — Bare Node process

```bash
npm ci
npx prisma generate
npm run build
npx prisma migrate deploy
npm start
```

`npm start` runs `next start`, which binds to port 3000 by default (set
`PORT` to change it). Put this behind a process manager (`pm2`, `systemd`,
or your host's own supervisor) so it restarts on crash, and behind a
reverse proxy (Nginx, Caddy, or your host's own HTTPS termination) for TLS.

## 5. Channel webhooks

Inbound is two URLs for the whole deployment, and the operator sets up
neither of them.

**Meta (WhatsApp, Instagram, Messenger)** — one callback for every tenant,
configured once in Lipi's own Meta app, not per workspace:

- Callback URL: `https://<PUBLIC_URL>/webhooks/meta`
- Verify token: the value of `META_VERIFY_TOKEN`
- Subscribe the `messages` field on each product the deployment offers.

Meta signs each body with the **subscribing app's** secret, which is Lipi's,
so `META_APP_SECRET` is the only key that can verify one. This is also why
a Composio-managed WhatsApp or Instagram auth config cannot serve real
tenants: connections made through it subscribe Composio's app, not Lipi's,
and their deliveries will never verify here. Use custom auth configs on
Lipi's Meta app before going live (`docs/runbooks/meta-app.md`).

Each tenant's own node — the WABA, the Instagram professional account, each
Page — is subscribed automatically when the channel is connected, and a
failure there leaves the channel **Not working** rather than silently
one-directional.

**Telegram** — nothing to configure. Connecting a bot registers
`https://<PUBLIC_URL>/webhooks/telegram/<connection id>` with a per-
connection secret, in the same request that hands the token to Composio.

One caveat on disconnect: Composio does not hand the bot token back, so
Lipi cannot call `deleteWebhook` on the way out. Disconnecting destroys the
secret instead, which makes every later delivery a 401 and writes nothing.
To clear the webhook on Telegram's side as well, the operator runs
`curl "https://api.telegram.org/bot<token>/deleteWebhook"` once, or simply
reconnects the bot — `setWebhook` overwrites the stale one.

## 6. Post-deploy checklist

1. **Health check**: `curl https://<PUBLIC_URL>/v1/health` should return
   `200`.
2. **Sign up and onboard**: create the first account, pick a vertical, and
   confirm the sample catalogue seeds correctly on the dashboard.
3. **Connect a channel**: Telegram is the easiest to verify end-to-end —
   paste a bot token on the Channels page, send the bot a message, and
   confirm a conversation appears in the inbox. This exercises the whole
   inbound path in production: webhook registration, the secret header,
   idempotency, ingest, and the reply going back out through Composio.
4. **Connect an inventory connector** (optional): create one from
   Inventory → Connectors, copy the one-time secret, and push a test batch
   with `curl` to `POST /v1/inventory/{connectorId}/sync` to confirm sync
   health.
5. **Rotate `APP_SECRET` only with a plan**: if you ever need to rotate it,
   every connected channel and inventory connector must be reconnected
   afterward (their stored secrets become undecryptable by design — see
   `src/server/lib/crypto.ts`).

## 7. Scaling notes

- The app is stateless at the process level (no in-memory session or job
  state); Postgres is the only shared state. Multiple instances behind a
  load balancer are safe **except** for the migration-on-start caveat in
  §4 — run migrations as a separate step in a multi-instance deploy. The
  inbound rate limit is the one exception: it is an in-process map (see
  `src/server/lib/rate-limit.ts`), so N instances enforce N times the
  budget in aggregate.
- Webhook `POST` handlers use Next's `after()` to keep work alive past the
  response; on a host that force-kills a process shortly after a response
  is sent (some serverless-style Node runtimes), this can be cut short. A
  plain long-running Node process (Docker/VM, as above) does not have this
  risk — `after()` runs to completion in the same process.
- Known scaling caveat carried over from the audit: `matchVariant()`
  (`src/server/services/ingest.ts`) loads every product and variant for a
  workspace on every inbound message. This is fine at the seeded/demo
  scale; a catalogue in the tens of thousands of variants will need the
  narrower pre-filter described in the code comment there before this
  becomes a real deployment (documented, not yet fixed — see README's
  L-1(c) entry).

## 8. What is NOT production-hardened yet

The public surfaces are the webhook routes and the inventory sync
endpoint. Both authenticate by their own secrets, and the webhook routes
are additionally rate-limited per connection *after* that check — 120
deliveries a minute, in process, with the multi-instance caveat in §7. The
inventory sync endpoint is not yet rate-limited, and there has been no
additional API hardening pass beyond what the security audit covered.
Treat this as a functional but not yet fully hardened production
deployment.
