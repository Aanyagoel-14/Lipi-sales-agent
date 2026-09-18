# ADR 0001 — Connectors are rebuilt on Composio, with Lipi keeping inbound for Meta and Telegram

- **Status:** accepted, 2026-09-19
- **Deciders:** product owner, Lipi engineering
- **Supersedes:** the bespoke `ChannelAdapter` connectors for WhatsApp and Telegram

## Context

Lipi's first connectors were written by hand: one adapter per channel that parsed the
provider's webhook, called the provider's API with a token the operator pasted in, and
kept that token encrypted in `channel_connections`. Two of them shipped (WhatsApp Cloud API
and Telegram) and a manual test on 2026-09-18 found six defects in the connect and inbound
flows. The product roadmap also asks for Instagram, Messenger, email, X and LinkedIn, each
of which would have meant another OAuth dance, another token at rest and another webhook
to secure.

Composio offers hosted OAuth (Connect Link), credential custody with automatic refresh,
a uniform `tools.execute` for outbound calls, and webhooks for credential lifecycle
events. The brief that started this work assumed the same would hold for inbound:
provider → Composio trigger → one Lipi webhook.

That assumption was checked against every toolkit page on 2026-09-19 and it does not
hold for a single customer-DM channel:

| Toolkit | Inbound trigger | Notes |
| --- | --- | --- |
| WHATSAPP | none | its only trigger, `WHATSAPP_MESSAGE_STATUS_UPDATED_TRIGGER`, describes itself as returning empty results; no read tool for messages |
| TELEGRAM | none | only `TELEGRAM_GET_UPDATES`, which conflicts with a webhook and cannot be shared across tenants |
| INSTAGRAM | none | "Triggers: 0"; messages readable only by polling `INSTAGRAM_LIST_ALL_MESSAGES` |
| FACEBOOK (Messenger) | none | |
| TWITTER | none | managed OAuth removed Feb 2026; X API bills per DM |
| LINKEDIN | none, and no messaging tool at all | the Messages API is partner-only |
| GMAIL | `GMAIL_NEW_GMAIL_MESSAGE` | polling, about a minute on a custom Google app |
| SLACK, DISCORD | real triggers | not conversation channels for Lipi's customers |

Meta also signs every webhook POST with the secret of the app that subscribed, so
inbound WhatsApp and Instagram can only be verified by whoever owns the subscribing app.

## Decision

Composio becomes the credential and outbound substrate for every channel; Lipi keeps a
thin inbound layer where Composio has nothing to offer.

- **Composio owns:** the connect flow (Connect Link for OAuth toolkits, API-key
  initiation for Telegram), credential custody and refresh, every outbound send through
  `tools.execute` with a pinned toolkit version, credential lifecycle events
  (`connected_account.expired`, `trigger.disabled`), and inbound for trigger-capable
  toolkits — Gmail first, as the `email` channel.
- **Lipi owns inbound for Meta and Telegram.** One `/webhooks/meta` endpoint for every
  tenant, verified with Lipi's own Meta App Secret and routed to a workspace by
  `(channel, externalId)` — the phone number id, Instagram account id or Page id. One
  `/webhooks/telegram/:connectionId` endpoint per bot, registered through Composio's
  proxy-execute so the bot token never rests in Lipi after the connect step.
- **Lipi's own Meta app is mandatory** for WhatsApp, Instagram and Messenger to go live.
  Composio-managed Meta auth configs are for development only.
- **One client wrapper** (`web/src/server/lib/composio.ts`) is the only importer of the
  SDK. It exposes the nine calls the connector track makes and nothing more: no OAuth
  `initiate` (retired by Composio for managed OAuth on 3 July 2026) and no
  `dangerouslySkipVersionCheck`. Tests replace it with a fake.
- **One channel registry** (`web/src/server/channels/registry.ts`) declares each channel:
  toolkit and pinned version, connect kind, inbound kind, a parser, a send builder and an
  identity tool. Nothing else in the app enumerates channels.

The rebuild runs as five phases (C0–C4) tracked in `~/Desktop/Lipi-plan/COMPOSIO_PLAN.md`
and GitHub issue #1 on the fork.

## Alternatives considered

- **Pure Composio, polling for inbound.** Rejected: WhatsApp has no read tool at all,
  Telegram's `getUpdates` is exclusive with webhooks and one bot cannot be polled by two
  processes, and Instagram polling per tenant per minute does not scale and still needs
  Meta's messaging permissions. It would also turn a sub-second chat channel into a
  minute-latency one.
- **Repair the bespoke adapters and extend them per channel.** Rejected: each new channel
  repeats the OAuth, token-at-rest and webhook-security work that Composio already does,
  and the six defects found in the manual test were all in exactly that code.
- **A third-party WhatsApp inbox provider (Twilio, 360dialog) alongside Composio.**
  Rejected for now: another vendor, another billing relationship, and it does nothing for
  Instagram or Telegram. It stays the fallback if Meta review of Lipi's own app fails.

## Consequences

- LinkedIn is not a conversation channel for Lipi; at most a send-only or profile
  integration later.
- X DMs are deferred (phase C5, gated) until per-DM cost and a poller on the job runner
  are acceptable.
- The `email` channel has email latency (Composio polls Gmail); the UI must say so and
  never present it as chat.
- Lipi must obtain Meta app review for `whatsapp_business_messaging`,
  `whatsapp_business_management`, `instagram_business_manage_messages`,
  `pages_messaging` and `pages_manage_metadata` before any Meta channel goes live.
- Credential columns (`secretCipher`, `metaAppSecretCipher`) leave the schema in C2 and
  C3 respectively; after that Lipi stores no provider credential.
- Later connector work (Google Calendar, CRM, ERP) starts from `composio().execute` and a
  connected account per workspace, not from a new OAuth framework.
