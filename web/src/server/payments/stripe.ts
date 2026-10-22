import type { PaymentConnection, PaymentLink } from "@/generated/prisma/client";
import { short } from "../channels/connect";
import { env } from "../env";
import { composio, type ProxyQuery } from "../lib/composio";
import { invoiceToken } from "../lib/crypto";
import { recordEvent } from "../lib/events";
import { HttpError } from "../lib/http";
import type { CheckoutOutcome, CheckoutRequest, LinkStatus, PaymentProvider } from "../lib/payments";
import { paymentMethodFrom } from "../lib/payments";
import { prisma } from "../lib/prisma";
import { settleInvoice } from "../services/checkout";

/**
 * Stripe Payment Links, per workspace, through Composio.
 *
 * This is how a shop that sells in chat gets paid: the customer says yes, a
 * `buy.stripe.com` link arrives in the same thread, they pay by card, UPI or
 * wallet on Stripe's page, and the money is in the shop's account before
 * anything is set aside for them.
 *
 * The connection is made the way a channel's is. The secret key goes to
 * Composio in the connect request and is not written down here; a real read
 * has to succeed before the row says `connected`; disconnecting deletes the
 * Composio account. Payments come back the way Gmail's mail does: Composio's
 * Stripe triggers are webhooks it registers on the account itself, delivered
 * to `/webhooks/composio` and routed here by the connected account — so
 * there is no secret for the operator to copy and no endpoint of Lipi's own.
 *
 * The toolkit (`20261014_00`, read 2026-10-22) has tools for prices,
 * customers and invoices but none for a payment link or a checkout session,
 * so those three calls go through Composio's proxy to Stripe's REST API
 * with the account's key — which works for Stripe, whose credential travels
 * in a header. Stripe takes every parameter in the query string, which is
 * how a POST through the proxy avoids the question of how it encodes a
 * body. The price is made with the toolkit's own tool.
 */

export const GATEWAY = "stripe" as const;

/** A secret or restricted key as Stripe issues them: the mode is in the prefix. */
export const SECRET_KEY = /^(sk|rk)_(test|live)_[A-Za-z0-9]{10,}$/;

export const keyMode = (key: string): "test" | "live" => (/^(sk|rk)_live_/.test(key) ? "live" : "test");

export const authConfigId = () => env.COMPOSIO_AUTH_CONFIG_STRIPE || undefined;

const publicUrl = () => env.PUBLIC_URL.replace(/\/$/, "");

/**
 * Where Stripe sends the customer back to after paying: the invoice page's
 * return route, with the Checkout Session Stripe opened for the link, so the
 * page can ask about that session rather than guess.
 */
const returnUrlFor = (number: string) => `${publicUrl()}/i/${invoiceToken(number)}/return?session_id={CHECKOUT_SESSION_ID}`;

/**
 * The triggers a connection subscribes to. `completed` fires for every card
 * payment; a delayed method (a bank debit) completes `unpaid` and succeeds
 * later, which is the second. Both carry the Checkout Session, and both are
 * settled only when it says `paid`.
 */
export const TRIGGERS = ["STRIPE_CHECKOUT_SESSION_COMPLETED", "STRIPE_CHECKOUT_SESSION_ASYNC_PAYMENT_SUCCEEDED"] as const;

export const isStripeTrigger = (slug: string | undefined): boolean => (TRIGGERS as readonly string[]).includes(slug ?? "");

const str = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** Composio hands a tool's response back under `data`, sometimes wrapped once more. */
const entity = (data: unknown): Record<string, unknown> | undefined => {
  const root = record(data);
  if (!root) return undefined;
  if (str(root.id) || str(root.object)) return root;
  return record(root.data) ?? record(root.result) ?? root;
};

// -------------------------------------------------------------- connection --

const where = (workspaceId: string) => ({ workspaceId_provider: { workspaceId, provider: GATEWAY } });

export const stripeConnection = (workspaceId: string) => prisma.paymentConnection.findUnique({ where: where(workspaceId) });

const fail = (row: PaymentConnection, status: "disconnected" | "error", lastError: string) =>
  prisma.paymentConnection.update({ where: { id: row.id }, data: { status, lastError, connectedAt: null } });

/**
 * The cheapest real call the toolkit offers, and the one that says which
 * mode the key is in: the balance carries `livemode`.
 */
async function probe(workspaceId: string, connectedAccountId: string): Promise<{ live: boolean | null }> {
  const result = await composio().execute("STRIPE_RETRIEVE_BALANCE", { userId: workspaceId, connectedAccountId, arguments: {} });
  if (!result.successful) throw new Error(result.error ?? "Stripe did not answer");
  const balance = entity(result.data);
  return { live: typeof balance?.livemode === "boolean" ? balance.livemode : null };
}

/**
 * Who the account is, for the card. The toolkit has no account tool, so this
 * is a proxied `GET /v1/account`; it is allowed to fail, because a name is a
 * nicety and the probe above has already proved the key.
 */
async function identity(connectedAccountId: string): Promise<{ accountId: string | null; name: string | null }> {
  try {
    const result = await composio().proxy({ connectedAccountId, method: "GET", endpoint: "/v1/account" });
    const account = result.status < 300 ? entity(result.data) : undefined;
    const profile = record(account?.business_profile);
    const dashboard = record(record(account?.settings)?.dashboard);
    return {
      accountId: str(account?.id) ?? null,
      name: str(profile?.name) ?? str(dashboard?.display_name) ?? null,
    };
  } catch {
    return { accountId: null, name: null };
  }
}

const displayNameFor = (name: string | null, mode: "test" | "live") => `${name ?? "Stripe account"}, ${mode} mode`;

/** Best effort: the operator asked for a new connection, not for a report on the old one. */
async function retire(triggerIds: string[], accountId: string | null) {
  const client = composio();
  for (const triggerId of triggerIds) {
    await client.deleteTrigger(triggerId).catch((error: unknown) =>
      console.error(`composio: could not delete trigger ${triggerId}`, error));
  }
  if (accountId) {
    await client.deleteAccount(accountId).catch((error: unknown) =>
      console.error(`composio: could not delete account ${accountId}`, error));
  }
}

/**
 * Connects, or reconnects, a workspace's Stripe account.
 *
 * The key is handed to Composio and dropped; what is kept is the mode its
 * prefix declared (checked against the balance's `livemode`), the account
 * id and name for the card, and the ids of the triggers Composio now runs
 * for it. Nothing here treats having started as having worked: the row only
 * says `connected` once Composio reports the account ACTIVE under this
 * workspace, a real call has come back, and the triggers exist.
 */
export async function connectStripe(workspaceId: string, input: { secretKey: string }): Promise<PaymentConnection> {
  const configId = authConfigId();
  if (!configId) {
    throw new HttpError(400, "Stripe is not set up in this deployment (COMPOSIO_AUTH_CONFIG_STRIPE is empty)");
  }
  const client = composio();

  // Reconnect: Composio refuses a second account on an auth config that
  // already holds an active one for this user, so the old one goes first —
  // and its triggers with it, or they would keep delivering for a dead key.
  const existing = await stripeConnection(workspaceId);
  if (existing?.composioAccountId) await retire(existing.composioTriggerIds, existing.composioAccountId);

  let connectedAccountId: string;
  try {
    ({ connectedAccountId } = await client.initiateApiKey(workspaceId, configId, input.secretKey, "generic_api_key"));
  } catch (error) {
    throw new HttpError(502, short(error));
  }

  const mode = keyMode(input.secretKey);
  const fields = {
    status: "pending" as const,
    composioAccountId: connectedAccountId,
    composioAuthConfigId: configId,
    composioTriggerIds: [] as string[],
    mode,
    accountId: null,
    displayName: null,
    connectedAt: null,
    lastError: null,
  };
  const pending = await prisma.paymentConnection.upsert({
    where: where(workspaceId),
    create: { workspaceId, provider: GATEWAY, ...fields },
    update: fields,
  });

  let account;
  try {
    account = await client.getAccount(connectedAccountId);
  } catch (error) {
    return fail(pending, "disconnected", short(error));
  }
  // Composio's own record of who the account was created for, checked
  // before anything is written, the same as a channel's callback.
  if (account.userId !== workspaceId) throw new HttpError(404, "That connection belongs to another workspace");
  if (account.status !== "ACTIVE") {
    return fail(pending, "disconnected", account.statusReason ?? "Stripe did not accept that key");
  }

  let live: boolean | null;
  try {
    ({ live } = await probe(workspaceId, connectedAccountId));
  } catch (error) {
    return fail(pending, "error", short(error));
  }
  // The prefix said one thing and Stripe says another: believe Stripe.
  const settledMode = live === null ? mode : live ? "live" : "test";

  const triggerIds: string[] = [];
  try {
    for (const slug of TRIGGERS) {
      triggerIds.push(await client.upsertTrigger(slug, { userId: workspaceId, connectedAccountId, config: {} }));
    }
  } catch (error) {
    // A gateway that cannot tell us about a payment is not a connected
    // gateway: the order would sit unpaid while the money sat in the account.
    await retire(triggerIds, null);
    return fail(pending, "error", `Stripe accepted the key, but payment notifications could not be set up: ${short(error)}`);
  }

  const who = await identity(connectedAccountId);
  const connected = await prisma.paymentConnection.update({
    where: { id: pending.id },
    data: {
      status: "connected", mode: settledMode, accountId: who.accountId, displayName: displayNameFor(who.name, settledMode),
      composioTriggerIds: triggerIds, connectedAt: new Date(), lastError: null,
    },
  });
  await recordEvent(workspaceId, "payments.connected", "order", `stripe ${settledMode} mode${who.accountId ? ` ${who.accountId}` : ""}`);
  return connected;
}

/** Proves the connection still works, by the same read the connect step used. */
export async function testStripe(workspaceId: string): Promise<{ ok: true; displayName: string } | { ok: false; error: string }> {
  const row = await stripeConnection(workspaceId);
  if (!row?.composioAccountId) throw new HttpError(404, "Stripe is not connected");
  try {
    const { live } = await probe(workspaceId, row.composioAccountId);
    const mode = live === null ? (row.mode === "live" ? "live" : "test") : live ? "live" : "test";
    const who = await identity(row.composioAccountId);
    const displayName = displayNameFor(who.name, mode);
    await prisma.paymentConnection.update({
      where: { id: row.id },
      data: { ...(row.status === "pending" ? {} : { status: "connected" }), mode, displayName, lastError: null },
    });
    return { ok: true, displayName };
  } catch (error) {
    const message = short(error);
    await prisma.paymentConnection.update({ where: { id: row.id }, data: { status: "error", lastError: message } });
    return { ok: false, error: message };
  }
}

/**
 * Disconnects, and takes the Composio side down with it: the triggers, then
 * the account. The row stays, as `disconnected`. Links already issued stay
 * payable on Stripe — the shop's money is the shop's — but nothing will
 * hear about them, so the operator records those by hand.
 */
export async function disconnectStripe(workspaceId: string): Promise<void> {
  const row = await stripeConnection(workspaceId);
  if (!row) throw new HttpError(404, "Stripe is not connected");
  await retire(row.composioTriggerIds, row.composioAccountId);
  await prisma.paymentConnection.update({
    where: { id: row.id },
    data: {
      status: "disconnected", mode: null, accountId: null, displayName: null,
      composioAccountId: null, composioAuthConfigId: null, composioTriggerIds: [], connectedAt: null, lastError: null,
    },
  });
  await recordEvent(workspaceId, "payments.disconnected", "order", "stripe");
}

/**
 * Composio reported the account expired or a trigger switched off. The same
 * meaning to the operator as for a channel: reconnect.
 */
export async function stripeNeedsReconnect(row: PaymentConnection, reason: string): Promise<void> {
  if (row.status === "needs_reconnect") return;
  await prisma.paymentConnection.update({
    where: { id: row.id },
    data: { status: "needs_reconnect", lastError: reason.slice(0, 300) },
  });
  await recordEvent(row.workspaceId, "payments.expired", "order", `stripe: ${reason.slice(0, 200)}`);
}

export type GatewayView = {
  provider: typeof GATEWAY;
  label: string;
  status: PaymentConnection["status"];
  mode: "test" | "live" | null;
  accountId: string | null;
  displayName: string | null;
  connectedAt: string | null;
  lastEventIso: string | null;
  lastError: string | null;
  available: boolean;
  unavailableReason: string | null;
  accountRef: string | null;
};

/** How the gateway reaches the browser: never the key, never the Composio account id. */
export function gatewayView(row: PaymentConnection | null): GatewayView {
  const available = Boolean(env.COMPOSIO_API_KEY) && Boolean(authConfigId());
  return {
    provider: GATEWAY,
    label: "Stripe",
    status: row?.status ?? "disconnected",
    mode: row?.mode === "live" ? "live" : row?.mode === "test" ? "test" : null,
    accountId: row?.accountId ?? null,
    displayName: row?.displayName ?? null,
    connectedAt: row?.connectedAt?.toISOString() ?? null,
    lastEventIso: row?.lastEventAt?.toISOString() ?? null,
    lastError: row?.lastError ?? null,
    available,
    unavailableReason: available ? null
      : env.COMPOSIO_API_KEY
        ? "Stripe is not set up in this environment (COMPOSIO_AUTH_CONFIG_STRIPE is empty)"
        : "Composio is not configured in this environment (COMPOSIO_API_KEY is empty)",
    accountRef: row?.composioAccountId ? `…${row.composioAccountId.slice(-4)}` : null,
  };
}

// ---------------------------------------------------------------- provider --

/** A link still worth sending the customer to: ours, open, and made under the same mode. */
const stillOpen = (link: PaymentLink | null, test: boolean) =>
  Boolean(link && link.provider === GATEWAY && !link.closedAt && link.test === test);

/**
 * A Stripe call through the proxy. Every parameter goes in the query string
 * — Stripe reads them from there for a POST as readily as from a form body —
 * and a non-2xx is turned into the message Stripe gave, which is the one
 * worth showing.
 */
async function stripeCall(connectedAccountId: string, method: "GET" | "POST", endpoint: string, query: ProxyQuery = {}) {
  const result = await composio().proxy({ connectedAccountId, method, endpoint, query });
  const body = entity(result.data);
  if (result.status >= 300) {
    const error = record(body?.error);
    throw new Error(str(error?.message) ?? `Stripe answered ${result.status}`);
  }
  return body ?? {};
}

/** Stripe's view of a Checkout Session, reduced to what settlement needs. */
function sessionStatus(session: Record<string, unknown> | undefined): LinkStatus["payments"] {
  if (!session || str(session.payment_status) !== "paid") return [];
  const id = str(session.payment_intent) ?? str(session.id);
  const amount = num(session.amount_total);
  if (!id || amount === undefined) return [];
  const types = Array.isArray(session.payment_method_types) ? session.payment_method_types : [];
  return [{ id, amount, method: str(types[0]) ?? "card" }];
}

/**
 * The provider for one connected workspace.
 *
 * `createCheckoutLink` is idempotent per invoice through the `payment_links`
 * table: the Pay button pressed twice, or the chat reply and the Pay button,
 * get the same Stripe page. A link is made again only once the old one is
 * closed. The link is limited to one completed checkout, so a customer who
 * pays and then opens it again is told it is no longer available rather
 * than charged twice.
 */
export function stripeProvider(connection: PaymentConnection): PaymentProvider {
  const { workspaceId } = connection;
  const connectedAccountId = connection.composioAccountId!;
  const test = connection.mode !== "live";

  return {
    name: GATEWAY,
    test,
    shareable: true,
    configured: () => connection.status === "connected",

    async createCheckoutLink(request: CheckoutRequest): Promise<CheckoutOutcome> {
      const existing = await prisma.paymentLink.findUnique({ where: { invoiceNumber: request.reference } });
      if (existing && stillOpen(existing, test)) {
        return { ok: true, provider: GATEWAY, link: { url: existing.url, providerRef: existing.id, expiresAt: null } };
      }
      const attempt = existing ? Number(existing.reference.split("~")[1] ?? 1) + 1 : 1;
      const reference = attempt === 1 ? request.reference : `${request.reference}~${attempt}`;

      try {
        // A payment link needs a price, and a price needs a product; one of
        // each, for this invoice, with the amount already in minor units.
        const priced = await composio().execute("STRIPE_CREATE_PRICE", {
          userId: workspaceId, connectedAccountId,
          arguments: {
            currency: request.currency.toLowerCase(),
            unit_amount: request.amount,
            product_data: { name: request.description.slice(0, 250), metadata: { invoice: request.reference } },
            metadata: { invoice: request.reference, workspace: workspaceId },
          },
        });
        const priceId = str(entity(priced.data)?.id);
        if (!priced.successful || !priceId) throw new Error(priced.error ?? "Stripe returned no price");

        const link = await stripeCall(connectedAccountId, "POST", "/v1/payment_links", {
          "line_items[0][price]": priceId,
          "line_items[0][quantity]": 1,
          "after_completion[type]": "redirect",
          "after_completion[redirect][url]": returnUrlFor(request.reference),
          // One sale per link: a second visit after paying is refused by
          // Stripe, not charged.
          "restrictions[completed_sessions][limit]": 1,
          // What the trigger carries back, so a delivery can be settled even
          // when the link row it names was replaced in between.
          "metadata[invoice]": request.reference,
          "metadata[workspace]": workspaceId,
          "metadata[reference]": reference,
          "payment_intent_data[metadata][invoice]": request.reference,
          ...(request.customer?.email ? { "customer_creation": "if_required" } : {}),
        });
        const id = str(link.id);
        const url = str(link.url);
        if (!id || !url) throw new Error("Stripe returned no payment link");

        // One row per invoice: the replaced link is deactivated below, and
        // `metadata.invoice` still settles it if somebody pays it first.
        await prisma.$transaction([
          prisma.paymentLink.deleteMany({ where: { invoiceNumber: request.reference } }),
          prisma.paymentLink.create({
            data: { id, provider: GATEWAY, reference, url, test, expiresAt: null, invoiceNumber: request.reference, workspaceId },
          }),
        ]);
        if (existing && !existing.closedAt) await deactivate(connectedAccountId, existing.id);

        await recordEvent(workspaceId, "checkout.link_created", "order",
          `invoice=${request.reference} provider=stripe ref=${id}${test ? " mode=test" : ""}`);
        return { ok: true, provider: GATEWAY, link: { url, providerRef: id, expiresAt: null } };
      } catch (error) {
        return { ok: false, provider: GATEWAY, reason: short(error) };
      }
    },

    /**
     * Asks Stripe about the Checkout Session the customer came back with,
     * when there is one, or about the sessions opened from the link when
     * there is not. Only a session that belongs to this link counts.
     */
    async lookupLink(providerRef: string, hint?: { session?: string }): Promise<LinkStatus | null> {
      const belongs = (session: Record<string, unknown> | undefined) =>
        session && (str(session.payment_link) === providerRef || !str(session.payment_link));
      if (hint?.session && /^cs_[A-Za-z0-9_]+$/.test(hint.session)) {
        const session = await stripeCall(connectedAccountId, "GET", `/v1/checkout/sessions/${hint.session}`);
        if (!belongs(session)) return null;
        const payments = sessionStatus(session);
        return { status: payments.length ? "paid" : "open", payments };
      }
      const list = await stripeCall(connectedAccountId, "GET", "/v1/checkout/sessions", { payment_link: providerRef, limit: 10 });
      const sessions = (Array.isArray(list.data) ? list.data : []).map((s) => record(s));
      const paid = sessions.map((s) => sessionStatus(s)).find((p) => p.length);
      return { status: paid ? "paid" : "open", payments: paid ?? [] };
    },
  };
}

/** The workspace's Stripe provider, or null when it has none connected. */
export async function stripeProviderFor(workspaceId: string): Promise<PaymentProvider | null> {
  const connection = await stripeConnection(workspaceId);
  return connection?.status === "connected" && connection.composioAccountId ? stripeProvider(connection) : null;
}

/** A payment link that must stop taking money. Stripe keeps it, inactive. */
async function deactivate(connectedAccountId: string, linkId: string) {
  await stripeCall(connectedAccountId, "POST", `/v1/payment_links/${linkId}`, { active: "false" });
}

// -------------------------------------------------------------- settlement --

/**
 * A payment Stripe reports against a link, settled through the one path
 * every payment takes. `charged` because the money has already moved: a
 * shortfall on the shelf is recorded against the order for a person to
 * resolve rather than refused, since refusing would not give it back.
 */
export async function settleStripePayment(
  workspaceId: string,
  invoiceNumber: string,
  payment: { id: string; amount: number; method: string },
  by = "stripe",
) {
  return settleInvoice(workspaceId, invoiceNumber, {
    method: paymentMethodFrom(payment.method), reference: payment.id, by, amount: payment.amount, charged: true,
  });
}

/**
 * One trigger delivery from Composio, for one connection: a Checkout
 * Session, on `data.object`, that may or may not be paid yet.
 *
 * The invoice is found by the link row first and by `metadata.invoice`
 * second, both inside the workspace the connected account proves; a session
 * that resolves to neither is logged and dropped. The same session delivered
 * twice settles once — `settleInvoice` treats a paid invoice as already
 * paid.
 */
export async function handleStripeTrigger(connection: PaymentConnection, payload: unknown): Promise<void> {
  const { workspaceId } = connection;
  const session = record(record(record(payload)?.data)?.object);
  if (!session || str(session.object) !== "checkout.session") {
    console.log("stripe trigger: no checkout session in the delivery");
    return;
  }
  await prisma.paymentConnection.update({ where: { id: connection.id }, data: { lastEventAt: new Date() } });

  const payments = sessionStatus(session);
  if (!payments.length) {
    // Completed but not yet paid: a delayed method. The second trigger says when.
    console.log(`stripe trigger: ${str(session.id) ?? "?"} is ${str(session.payment_status) ?? "unpaid"}`);
    return;
  }

  const linkId = str(session.payment_link);
  const row = linkId ? await prisma.paymentLink.findFirst({ where: { id: linkId, workspaceId } }) : null;
  const noted = str(record(session.metadata)?.invoice);
  const invoiceNumber = row?.invoiceNumber
    ?? (noted ? (await prisma.invoice.findFirst({ where: { workspaceId, number: noted }, select: { number: true } }))?.number : undefined);
  if (!invoiceNumber) {
    console.log(`stripe trigger: no invoice for ${linkId ?? str(session.id) ?? "?"}`);
    return;
  }

  const settled = await settleStripePayment(workspaceId, invoiceNumber, payments[0]!);
  if (!settled.ok) console.log(`stripe trigger: ${invoiceNumber} not settled: ${settled.reason}`);
}

/**
 * Deactivates the open links for an order that will not be paid — it was
 * cancelled on the Orders page — so the customer cannot pay for something
 * the shop has already let go. Best effort: the order is cancelled whether
 * or not Stripe answers.
 */
export async function closePaymentLinksFor(workspaceId: string, orderId: string): Promise<void> {
  const links = await prisma.paymentLink.findMany({
    where: { workspaceId, provider: GATEWAY, closedAt: null, invoice: { orderId } },
  });
  if (!links.length) return;
  const connection = await stripeConnection(workspaceId);
  if (connection?.status !== "connected" || !connection.composioAccountId) return;

  for (const link of links) {
    try {
      await deactivate(connection.composioAccountId, link.id);
    } catch (error) {
      console.error(`stripe: could not deactivate ${link.id}: ${short(error)}`);
      continue;
    }
    await prisma.paymentLink.update({ where: { id: link.id }, data: { closedAt: new Date(), closedAs: "cancelled" } });
  }
}
