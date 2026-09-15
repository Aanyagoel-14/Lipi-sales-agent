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
  channel webhooks (Telegram, WhatsApp) are registered against this URL,
  so it must be a real, HTTPS-reachable address before you connect a
  channel.

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

## 5. Post-deploy checklist

1. **Health check**: `curl https://<PUBLIC_URL>/v1/health` should return
   `200`.
2. **Sign up and onboard**: create the first account, pick a vertical, and
   confirm the sample catalogue seeds correctly on the dashboard.
3. **Connect a channel**: Telegram is the easiest to verify end-to-end —
   connect it from the dashboard, send the bot a message, and confirm a
   conversation appears in the inbox. This exercises the full webhook
   signature-verification and idempotency path (H-3 fix) in production.
4. **Connect an inventory connector** (optional): create one from
   Inventory → Connectors, copy the one-time secret, and push a test batch
   with `curl` to `POST /v1/inventory/{connectorId}/sync` to confirm sync
   health.
5. **Rotate `APP_SECRET` only with a plan**: if you ever need to rotate it,
   every connected channel and inventory connector must be reconnected
   afterward (their stored secrets become undecryptable by design — see
   `src/server/lib/crypto.ts`).

## 6. Scaling notes

- The app is stateless at the process level (no in-memory session or job
  state); Postgres is the only shared state. Multiple instances behind a
  load balancer are safe **except** for the migration-on-start caveat in
  §4 — run migrations as a separate step in a multi-instance deploy.
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

## 7. What is NOT production-hardened yet

Per the README's "Not yet implemented" section: there is no rate limiting
on public endpoints (the webhook routes and the inventory sync endpoint
are the two unauthenticated-by-session surfaces — they're authenticated by
their own secrets, but not rate-limited), and no additional API hardening
pass beyond what the security audit already covered. Treat this as a
functional but not yet fully hardened production deployment.
