# Runbook — the Composio project

One Composio project per environment (development, staging, production). Everything
below is done once per project; the values land in that environment's `web/.env` and
nowhere else.

## 1. Project and API key

1. Sign in at https://app.composio.dev and create a project named after the
   environment, e.g. `lipi-dev`, `lipi-prod`.
2. Project Settings → API keys → create one. Put it in `web/.env` as `COMPOSIO_API_KEY`.
3. Project Settings → Webhooks → confirm **Payload version V3**. Organisations created
   before 15 February 2026 default to V1/V2 and Lipi rejects anything that is not V3.

## 2. Webhook subscription

A project has exactly one webhook subscription. From `web/`:

```
npm run composio:subscribe
```

This registers `PUBLIC_URL/webhooks/composio` for `composio.trigger.message`,
`composio.connected_account.expired` and `composio.trigger.disabled`, and prints the
signing secret **once**. Paste it into `web/.env` as `COMPOSIO_WEBHOOK_SECRET`. It cannot
be read back; to get a new one:

```
npm run composio:subscribe -- --rotate
```

`PUBLIC_URL` must be an HTTPS origin Composio can reach. In development that means a
tunnel (ngrok, cloudflared) and re-running the command when the tunnel URL changes.

### The connect callback is not the webhook

Two different URLs are built from `PUBLIC_URL` and only one of them is called by
Composio's servers.

| URL | Who calls it | Needs a public origin |
| --- | --- | --- |
| `PUBLIC_URL/webhooks/composio` | Composio, server to server | Yes |
| `PUBLIC_URL/v1/channels/callback` | The operator's own browser, as a redirect | No |

So a channel can be connected end to end against `http://localhost:3000` with no tunnel
running: the Connect Link opens in the operator's browser and sends it back to localhost,
which their machine can reach. Lifecycle events — an account expiring, a trigger being
switched off — are the part that needs the tunnel, and until one exists those simply do
not arrive. A connection made without one still works; it just will not notice when it
stops working.

## 3. Auth configs

One auth config per channel. Names, not values, go in the handoff notes; the `ac_…` ids
go in `web/.env`.

| Channel | Toolkit | Type | Env key |
| --- | --- | --- | --- |
| Telegram | `telegram` | API_KEY (bot token, field `generic_api_key`) | `COMPOSIO_AUTH_CONFIG_TELEGRAM` |
| WhatsApp | `whatsapp` | OAuth2, **custom** on Lipi's Meta app for anything live | `COMPOSIO_AUTH_CONFIG_WHATSAPP` |
| Instagram | `instagram` | OAuth2, **custom** on Lipi's Meta app for anything live | `COMPOSIO_AUTH_CONFIG_INSTAGRAM` |
| Email | `gmail` | OAuth2, Composio-managed is fine to start | `COMPOSIO_AUTH_CONFIG_GMAIL` |

The fastest path is the setup script, which creates whichever of the four the project does
not have yet and prints the ids to paste into `web/.env`:

```
npm run composio:subscribe -- --auth-configs
```

It is safe to re-run: a toolkit that already has a config is left alone. To create them by
hand instead, use the dashboard (Auth Configs → Create) or:

```ts
// custom OAuth on Lipi's own Meta app
composio.authConfigs.create("whatsapp", {
  type: "use_custom_auth",
  authScheme: "OAUTH2",
  credentials: {
    client_id: META_APP_ID,
    client_secret: META_APP_SECRET,
    oauth_redirect_uri: "https://backend.composio.dev/api/v1/auth-apps/add",
  },
});
// Telegram
composio.authConfigs.create("telegram", { type: "use_custom_auth", authScheme: "API_KEY", credentials: {} });
// note: over REST the field is camelCase `authScheme`, inside `auth_config`
```

The redirect URI above is the one to register in the Meta app (see `meta-app.md`). It is the
default Composio returns in the toolkit's `auth_config_creation` fields, confirmed against
`GET /toolkits/whatsapp` on 2026-09-19 — an older value, `/api/v3/toolkits/auth/callback`,
appears in some tutorials and does not work.

**Composio-managed Meta configs are for development only.** Meta signs inbound webhooks
with the subscribing app's secret, so inbound WhatsApp and Instagram through a managed
config can never be verified by Lipi. The free plan also caps managed-app usage at 20k
calls a month.

## 4. Toolkit versions

Every outbound call carries a pinned toolkit version from
`web/src/server/channels/registry.ts`. To see the live versions next to the pins:

```
npm run composio:subscribe -- --versions
```

Bump a pin deliberately, one toolkit at a time, and re-run the registry tests. The same
command prints Telegram's `auth_config_details`, which says whether the hosted Connect
Link page can collect the bot token itself.

## 5. Smoke-testing a Connect Link

```
npm run composio:subscribe -- --link ac_xxxxxxxx
```

Issues one link for user `smoke-test` and prints the URL. The connected account it
creates sits in `INITIATED` and expires after ten minutes; delete it from the dashboard
when done.

## 6. Rotation and revocation

- **API key:** create a new one, deploy it, delete the old one. Nothing is stored against
  the key.
- **Webhook secret:** `--rotate`, deploy, done. Deliveries signed with the old secret fail
  verification with a 401 and are retried by Composio.
- **A tenant's credentials:** disconnecting the channel in Lipi deletes the connected
  account, which revokes the token at the provider where the provider supports it.

## Limits worth knowing

Free plan: 100k tool calls and 50k trigger events a month, of which only 20k may go
through Composio-managed OAuth apps. Rate limit 2,000 requests a minute per project.
