# Runbook — Lipi's Meta app

Every WhatsApp, Instagram and Messenger tenant connects through one Meta app that Lipi
owns. This is not optional: Meta signs each webhook POST with the App Secret of the app
that subscribed, so inbound messages can only be verified by the owner of that app. One
app also means one callback URL, one review, one set of permissions.

## 1. Create the app

1. https://developers.facebook.com → My Apps → Create App → type **Business**.
2. Name it `Lipi` (production) or `Lipi Dev`. Attach Lipi's Business Manager.
3. Settings → Basic: note the **App ID** and **App Secret**. The secret goes in
   `web/.env` as `META_APP_SECRET` and is also the `client_secret` of the two custom
   Composio auth configs. Never paste it anywhere else.

## 2. Add the products

Add **WhatsApp**, **Instagram** and **Messenger** from the product list.

## 3. OAuth redirect

Under Facebook Login for Business → Settings → Valid OAuth Redirect URIs add:

```
https://backend.composio.dev/api/v3/toolkits/auth/callback
```

That is where Composio finishes the OAuth dance for both the WhatsApp and the Instagram
auth configs. Nothing points at Lipi here.

## 4. Webhooks

For each product, set the callback to Lipi's single Meta endpoint:

| Field | Value |
| --- | --- |
| Callback URL | `PUBLIC_URL/webhooks/meta` |
| Verify token | the value of `META_VERIFY_TOKEN` in `web/.env` (any long random string) |

Meta GETs the URL with `hub.verify_token` during registration; Lipi's route answers the
challenge only when the token matches. The route ships in phase C3 — the registration
will fail until it is deployed, so do this step after C3 or against a tunnel running C3.

Subscribe the **`messages`** field on each product:

- WhatsApp → Configuration → Webhook fields → `messages`
- Instagram → Webhooks → `messages`
- Messenger → Webhooks → `messages` (and `messaging_postbacks` if buttons are used later)

Per-tenant subscription happens at connect time through Composio
(`WHATSAPP_SUBSCRIBE_APP`, `INSTAGRAM_ENABLE_WEBHOOK_SUBSCRIPTIONS`, Page
`subscribed_apps`); the app-level callback above is what those subscriptions deliver to.

## 5. Permissions and App Review

Request, then submit for review:

| Permission | Needed for |
| --- | --- |
| `whatsapp_business_messaging` | sending and receiving WhatsApp messages |
| `whatsapp_business_management` | listing the tenant's phone numbers, subscribing the WABA |
| `instagram_business_manage_messages` | Instagram DMs |
| `pages_messaging` | Messenger |
| `pages_manage_metadata` | subscribing a Page to the app's webhooks |

Until review passes, only accounts with a role on the app (admin, developer, tester) can
complete OAuth. Add each pilot tenant's Meta user as a **Tester** in the meantime.

## 6. Composio auth configs

With the App ID and App Secret in hand, create the two custom auth configs described in
`composio-project.md` §3 and put their ids in `web/.env`. Until the Meta app exists, the
development project may use Composio-managed WhatsApp and Instagram configs: connect and
outbound work, inbound signatures cannot be verified, and this must be recorded in the
phase handoff.

## 7. Going live checklist

- [ ] App switched from Development to Live mode
- [ ] Review approved for the five permissions above
- [ ] `META_APP_SECRET` and `META_VERIFY_TOKEN` set in production `web/.env`
- [ ] Callback `PUBLIC_URL/webhooks/meta` verified for all three products
- [ ] `COMPOSIO_AUTH_CONFIG_WHATSAPP` / `_INSTAGRAM` point at the **custom** configs
