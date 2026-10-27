# Runbook — Stripe payment links

How a workspace gets paid through its own Stripe account, what the deployment has to have
in place first, and what to do when a payment does not show up.

## What happens, in order

1. A customer says yes in chat. The twin raises the invoice and asks Stripe — through
   Composio, with the workspace's own key — for a **Payment Link** for the amount owed
   (one price, one product, limited to one completed checkout). The reply carries that
   link ("Pay securely here: https://buy.stripe.com/…") with the invoice page beneath it.
   Nothing is reserved yet.
2. The customer pays on Stripe's page: card, UPI, wallets, whatever the account has on.
3. Stripe tells Lipi twice. The customer's browser comes back to the invoice page
   (`/i/<token>/return?session_id=cs_…`), where Lipi asks Stripe about that Checkout
   Session and settles if it says paid; and Composio's `STRIPE_CHECKOUT_SESSION_COMPLETED`
   trigger — a webhook Composio registers on the account itself — delivers the same
   session to `/webhooks/composio`, which settles the same way. Whichever arrives first
   wins; the second finds the invoice paid. A customer who pays in a wallet app and never
   returns to the browser is covered by the trigger alone, which is why connecting
   requires the triggers to exist.
4. Settling (`services/checkout.ts`) takes the stock, moves the order to **Paid**, records
   the payment with Stripe's PaymentIntent id as the reference, closes the link, and tells
   the customer on the channel they bought on.

If the shelf emptied between the quote and the payment, the money has still moved, so
the payment is recorded and the order is marked Paid with a note — *"sold out before the
payment landed — refund or restock"* — for a person to resolve. The customer is told that
a restock date or a full refund follows within a working day. Lipi never refunds on its
own (`STRIPE_CREATE_REFUND` exists, but that is not a sales agent's call).

Test-mode keys (`sk_test_…`) run the whole flow with Stripe's test cards (4242 4242 4242
4242); the invoice page says TEST MODE and the Channels card says so too.

## Deployment setup (once)

- `COMPOSIO_API_KEY` set, and the project webhook subscribed (`npm run composio:subscribe`),
  as for every channel — payment events arrive on that same webhook.
- `COMPOSIO_AUTH_CONFIG_STRIPE`: an API_KEY auth config on the `stripe` toolkit.
  `npm run composio:subscribe -- --auth-configs` creates it (named `lipi-stripe`) and
  prints the id. The one in use (`ac_YjcdbF9KIJWf`) was created on 2026-10-22.
- `PUBLIC_URL` reachable from the internet: the link's return URL is built from it, and
  Stripe will not redirect to a private address.

The toolkit (pinned `20261014_00`) has no tool to create a payment link or read a
Checkout Session, so those go through Composio's proxy to Stripe's REST API with the
account's key, every parameter in the query string — Stripe accepts them there for a POST
as readily as in a form body, and it rejects JSON bodies. The price is made with the
toolkit's `STRIPE_CREATE_PRICE`; the probe is `STRIPE_RETRIEVE_BALANCE`.

## Connecting a workspace (the operator's steps)

On **Channels → Get paid → Stripe → Connect**:

1. In Stripe → **Developers → API keys**, copy the **secret key**. Test mode to try it
   out, live mode when ready. A restricted key (`rk_…`) works too if it can read the
   balance and write prices and payment links.
2. Paste it and press **Check and connect**. The key goes to Composio and is not stored by
   Lipi; the balance read has to succeed, and the two Checkout Session triggers have to be
   created, before the card says Live. The card then names the account ("Acme Apparel,
   test mode").

**Test** repeats the read. **Disconnect** deletes the triggers and the Composio account.
Switching from test to live is a Reconnect with the live key.

## What is stored

| Table | What | Why |
| --- | --- | --- |
| `payment_connections` | status, mode (`test`/`live`), Stripe account id and name, Composio account id, trigger ids | the card, and what disconnect takes down |
| `payment_links` | Stripe's `plink_…` id, the reference sent, the URL, test flag, when and how it closed | one per invoice; the Pay button and the chat reuse it; the trigger names it |
| `payments` | method (`card`, `upi`, `bank_transfer`, `wallet`, `other`), PaymentIntent id as `reference`, `loggedBy = stripe` | the ledger |

A link is re-issued only once the old one is closed (paid, or cancelled with the order),
under the reference `<invoice>~2`, `~3`, …; the old one is deactivated on Stripe. Links do
not expire; the invoice's due date is advisory.

Cancelling an order on the Orders page deactivates its open link on Stripe, so the
customer cannot pay for something the shop has let go.

## When a payment does not show

- **Card says Live, customer paid, order still Quoted.** The trigger did not deliver.
  Check Composio → Triggers for the account (both Checkout Session triggers should be
  active) and Stripe → Developers → Webhooks for the endpoint Composio registered. The
  customer opening their invoice page again settles it through the return route, and the
  operator can **Record payment** on the Orders page with the PaymentIntent id as the
  reference.
- **"Stripe is down" in the event trail** (`checkout.link_unavailable`). The quote went
  out with the invoice page only; its Pay button tries Stripe again.
- **Card says "Needs reconnecting".** Composio reported the key revoked or a trigger
  switched off. Reconnect with a key.
- **Order Paid with a "sold out" note.** Refund in the Stripe dashboard or restock, then
  move the order on.

## Limits worth knowing

- A payment link's `restrictions.completed_sessions.limit` is what makes it single-use;
  a customer who opens it again after paying sees Stripe's "no longer available" page.
- Stripe redirect URLs must be reachable; `{CHECKOUT_SESSION_ID}` in the return URL is
  what lets the return route ask about the right session.
- Composio retries a delivery that does not get a 2xx; the webhook route answers 200 for
  anything verified, including triggers the gateway does not listen on.
