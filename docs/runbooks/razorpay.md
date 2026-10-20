# Runbook — Razorpay payment links

How a workspace gets paid through its own Razorpay account, what the deployment has to
have in place first, and what to do when a payment does not show up.

## What happens, in order

1. A customer says yes in chat. The twin raises the invoice and asks Razorpay — through
   Composio, with the workspace's own key — for a **standard payment link** for the amount
   owed. The reply carries that link ("Pay securely here: https://rzp.io/…") with the
   invoice page beneath it. Nothing is reserved yet.
2. The customer pays on Razorpay's page: UPI, card, netbanking, wallet. Razorpay has
   auto-capture on for payment links, so a successful payment is money in the shop's
   account.
3. Razorpay tells Lipi twice. The customer's browser comes back to the invoice page
   (`/i/<token>/return`), where Lipi asks Razorpay about the link and settles if it says
   paid; and Razorpay POSTs `payment_link.paid` to the workspace's webhook URL, which
   settles the same way. Whichever arrives first wins; the second finds the invoice paid.
   A customer who pays in a UPI app and never returns to the browser is covered by the
   webhook alone, which is why the webhook is required at connect time.
4. Settling (`services/checkout.ts`) takes the stock, moves the order to **Paid**, records
   the payment with Razorpay's payment id as the reference, closes the link, and tells
   the customer on the channel they bought on.

If the shelf emptied between the quote and the payment, the money has still moved, so
the payment is recorded and the order is marked Paid with a note — *"sold out before the
payment landed — refund or restock"* — for a person to resolve. The customer is told that
a restock date or a full refund follows within a working day. Lipi never refunds on its
own; there is no refund tool in the toolkit, and it is not a decision for a sales agent.

Test-mode keys (`rzp_test_…`) run the whole flow with Razorpay's test cards and test
UPI; the invoice page says TEST MODE and the Channels card says so too.

## Deployment setup (once)

- `COMPOSIO_API_KEY` set, as for every channel.
- `COMPOSIO_AUTH_CONFIG_RAZORPAY`: an API_KEY auth config on the `razorpay` toolkit.
  `npm run composio:subscribe -- --auth-configs` creates it (named `lipi-razorpay`) and
  prints the id. The one in use was created on 2026-10-20.
- `PUBLIC_URL` reachable from the internet, because the webhook URL is built from it.

Composio has no trigger for Razorpay events (checked 2026-10-20), so Lipi receives the
webhook itself at `PUBLIC_URL/webhooks/razorpay/<workspaceId>` and verifies the
`X-Razorpay-Signature` header against the secret the operator set — the same shape as
Telegram's per-connection secret.

## Connecting a workspace (the operator's steps)

On **Channels → Get paid → Razorpay → Connect**:

1. In Razorpay Dashboard → **Account & Settings → Webhooks → Add New Webhook**: paste the
   URL the card shows, choose a secret, tick `payment_link.paid`, `payment_link.expired`
   and `payment_link.cancelled`, save.
2. In **Account & Settings → API Keys**, generate a key pair. Test mode to try it out,
   live mode when ready.
3. Type the Key ID, the Key Secret and the webhook secret into the card and press
   **Check and connect**. The key goes to Composio and is not stored by Lipi; a real read
   call (`RAZORPAY_FETCH_ALL_PAYMENT_LINKS`, count 1) has to succeed before the card says
   Live. Only the webhook secret is kept, encrypted with `APP_SECRET`.

**Test** repeats that read. **Disconnect** deletes the Composio account and destroys the
webhook secret, so a webhook left behind in Razorpay's dashboard is refused (401) from
then on. Switching from test to live is a Reconnect with the live key pair; the webhook
and its secret can stay the same.

## What is stored

| Table | What | Why |
| --- | --- | --- |
| `payment_connections` | status, key id (`rzp_test_…`/`rzp_live_…`), Composio account id, encrypted webhook secret | the key id is the publishable half and says test or live; the secret verifies deliveries |
| `payment_links` | Razorpay's `plink_…` id, the reference sent, the short URL, test flag, expiry, when and how it closed | one per invoice; the Pay button and the chat reuse it; the webhook names it |
| `payments` | method (`upi`, `card`, `bank_transfer`, `wallet`, `other`), Razorpay payment id as `reference`, `loggedBy = razorpay` | the ledger |

A link is re-issued only once Razorpay has closed the old one (expired or cancelled),
under the reference `<invoice>~2`, `~3`, …, because Razorpay refuses a reference it has
already seen. Links expire a week after the invoice's due date.

Cancelling an order on the Orders page cancels its open link on Razorpay, so the customer
cannot pay for something the shop has let go.

## When a payment does not show

- **Card says Live, customer paid, order still Quoted.** The webhook did not arrive or was
  refused. Check Razorpay Dashboard → Webhooks → the webhook's recent deliveries: a 401
  means the secret typed into Lipi differs from the one on the webhook (Reconnect with the
  right one); a 404 means the URL's workspace id is wrong or the workspace disconnected;
  no delivery at all means the event is not ticked. Meanwhile, the customer opening their
  invoice page again settles it through the return route, and the operator can **Record
  payment** on the Orders page with the Razorpay payment id as the reference.
- **"Razorpay is down" in the event trail** (`checkout.link_unavailable`). The quote went
  out with the invoice page only; its Pay button tries Razorpay again.
- **Order Paid with a "sold out" note.** Refund in the Razorpay dashboard or restock, then
  clear the note by moving the order on.

## Limits worth knowing

- Payment-link `reference_id` is 40 characters and must be unique for the account.
- `expire_by` must be at least 15 minutes ahead and at most six months.
- Razorpay retries a webhook that does not get a 2xx within a day, with back-off; the
  route answers 200 for anything verified, including events it does not handle.
- The toolkit is pinned at `20260826_00` (`GATEWAY_PINS` in the channel registry).
