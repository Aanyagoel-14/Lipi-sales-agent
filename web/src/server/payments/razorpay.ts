import type { PaymentConnection, PaymentLink } from "@/generated/prisma/client";
import { short } from "../channels/connect";
import { env } from "../env";
import { composio } from "../lib/composio";
import { encrypt, invoiceToken } from "../lib/crypto";
import { recordEvent } from "../lib/events";
import { HttpError } from "../lib/http";
import type { CheckoutOutcome, CheckoutRequest, LinkStatus, PaymentProvider } from "../lib/payments";
import { paymentMethodFrom } from "../lib/payments";
import { prisma } from "../lib/prisma";
import { settleInvoice } from "../services/checkout";

/**
 * Razorpay payment links, per workspace, through Composio.
 *
 * This is how a shop that sells in chat gets paid in India: the customer
 * says yes, a link arrives in the same thread, they pay by UPI or card on
 * Razorpay's page, and the money is in the shop's account before anything
 * is set aside for them. The whole of it here is three calls on the
 * `razorpay` toolkit — create a link, ask about a link, cancel a link — and
 * one webhook Lipi receives itself, because Composio has no trigger for
 * payments (checked against `GET /triggers_types?toolkit_slugs=razorpay` on
 * 2026-10-20: none).
 *
 * The connection is made the way a channel's is. The key id and secret go
 * to Composio in the connect request and are not written down here; a real
 * read call has to succeed before the row says `connected`; disconnecting
 * deletes the Composio account. The one credential Lipi keeps is the
 * webhook secret, because verifying a delivery needs it, and it is
 * encrypted at rest like a channel credential used to be.
 *
 * Tool argument names were read from `GET /tools/RAZORPAY_CREATE_PAYMENT_LINK`
 * (and the fetch and cancel tools) on 2026-10-20, against toolkit version
 * `20260826_00`, which `GATEWAY_PINS` pins.
 */

export const GATEWAY = "razorpay" as const;

/** A key id as Razorpay issues them: the mode is in the prefix. */
export const KEY_ID = /^rzp_(test|live)_[A-Za-z0-9]{8,}$/;

export const keyMode = (keyId: string): "test" | "live" => (keyId.startsWith("rzp_live_") ? "live" : "test");

/** `rzp_test_Ab12…Xy89` — enough to recognise a key, not enough to be one. */
const shortKey = (keyId: string) => `${keyId.slice(0, 13)}…${keyId.slice(-4)}`;

const displayNameFor = (keyId: string) => `Razorpay, ${keyMode(keyId)} mode (${shortKey(keyId)})`;

export const authConfigId = () => env.COMPOSIO_AUTH_CONFIG_RAZORPAY || undefined;

const publicUrl = () => env.PUBLIC_URL.replace(/\/$/, "");

/**
 * Where Razorpay delivers this workspace's events. The workspace id is in the
 * path and is a publishable id — the same model as the widget's URL — and
 * the delivery is proved by the signature, not by the address.
 */
export const webhookUrlFor = (workspaceId: string) => `${publicUrl()}/webhooks/razorpay/${workspaceId}`;

/** Where Razorpay sends the customer back to after paying: the invoice page's return route. */
const returnUrlFor = (number: string) => `${publicUrl()}/i/${invoiceToken(number)}/return`;

/** The events the operator ticks in Razorpay's webhook form. Anything else is acknowledged and dropped. */
export const WEBHOOK_EVENTS = ["payment_link.paid", "payment_link.expired", "payment_link.cancelled"] as const;

const str = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/**
 * Composio hands a tool's response back under `data`, sometimes as the
 * provider's entity itself and sometimes wrapped once more. The payment-link
 * entity is the one with a `plink_` id, wherever it sits.
 */
function linkEntity(data: unknown): Record<string, unknown> | undefined {
  const root = record(data);
  if (!root) return undefined;
  if (str(root.id)?.startsWith("plink_")) return root;
  for (const key of ["data", "payment_link", "result"]) {
    const nested = record(root[key]);
    if (nested && str(nested.id)?.startsWith("plink_")) return nested;
  }
  return undefined;
}

const linkStatus = (status: string | undefined): LinkStatus["status"] =>
  status === "paid" ? "paid" : status === "expired" ? "expired" : status === "cancelled" ? "cancelled" : "open";

const linkPayments = (entity: Record<string, unknown>): LinkStatus["payments"] =>
  (Array.isArray(entity.payments) ? entity.payments : [])
    .map((payment) => record(payment))
    .flatMap((payment) => {
      const id = str(payment?.payment_id) ?? str(payment?.id);
      const amount = num(payment?.amount);
      return id && amount !== undefined ? [{ id, amount, method: str(payment?.method) ?? "" }] : [];
    });

// -------------------------------------------------------------- connection --

const where = (workspaceId: string) => ({ workspaceId_provider: { workspaceId, provider: GATEWAY } });

export const razorpayConnection = (workspaceId: string) => prisma.paymentConnection.findUnique({ where: where(workspaceId) });

const fail = (row: PaymentConnection, status: "disconnected" | "error", lastError: string) =>
  prisma.paymentConnection.update({ where: { id: row.id }, data: { status, lastError, connectedAt: null } });

/**
 * The cheapest real call the toolkit offers: one page of one payment link.
 * It proves the key pair works and is scoped to payment links, which is all
 * Lipi will ever ask of it.
 */
async function probe(workspaceId: string, connectedAccountId: string) {
  const result = await composio().execute("RAZORPAY_FETCH_ALL_PAYMENT_LINKS", {
    userId: workspaceId, connectedAccountId, arguments: { count: 1 },
  });
  if (!result.successful) throw new Error(result.error ?? "Razorpay did not answer");
}

/**
 * Connects, or reconnects, a workspace's Razorpay account.
 *
 * The secret is handed to Composio and dropped. The key id is kept, because
 * it is the publishable half and is what says test or live. The webhook
 * secret is kept encrypted, because it is what every delivery is checked
 * against. Nothing here treats having started as having worked: the row
 * only says `connected` once Composio reports the account ACTIVE under this
 * workspace and a real call has come back.
 */
export async function connectRazorpay(
  workspaceId: string,
  input: { keyId: string; keySecret: string; webhookSecret: string },
): Promise<PaymentConnection> {
  const configId = authConfigId();
  if (!configId) {
    throw new HttpError(400, "Razorpay is not set up in this deployment (COMPOSIO_AUTH_CONFIG_RAZORPAY is empty)");
  }
  const client = composio();

  // Reconnect: Composio refuses a second account on an auth config that
  // already holds an active one for this user, so the old one goes first.
  const existing = await razorpayConnection(workspaceId);
  if (existing?.composioAccountId) {
    await client.deleteAccount(existing.composioAccountId).catch((error: unknown) =>
      console.error(`composio: could not delete account ${existing.composioAccountId}`, error));
  }

  let connectedAccountId: string;
  try {
    ({ connectedAccountId } = await client.initiateApiKey(
      workspaceId, configId, input.keySecret, "generic_api_key", { generic_id: input.keyId },
    ));
  } catch (error) {
    throw new HttpError(502, short(error));
  }

  const fields = {
    status: "pending" as const,
    composioAccountId: connectedAccountId,
    composioAuthConfigId: configId,
    keyId: input.keyId,
    webhookSecret: encrypt(input.webhookSecret),
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
    return fail(pending, "disconnected", account.statusReason ?? "Razorpay did not accept that key");
  }

  try {
    await probe(workspaceId, connectedAccountId);
  } catch (error) {
    return fail(pending, "error", short(error));
  }

  const connected = await prisma.paymentConnection.update({
    where: { id: pending.id },
    data: { status: "connected", displayName: displayNameFor(input.keyId), connectedAt: new Date(), lastError: null },
  });
  await recordEvent(workspaceId, "payments.connected", "order", `razorpay ${keyMode(input.keyId)} mode`);
  return connected;
}

/** Proves the connection still works, by the same read the connect step used. */
export async function testRazorpay(workspaceId: string): Promise<{ ok: true; displayName: string } | { ok: false; error: string }> {
  const row = await razorpayConnection(workspaceId);
  if (!row?.composioAccountId || !row.keyId) throw new HttpError(404, "Razorpay is not connected");
  try {
    await probe(workspaceId, row.composioAccountId);
    const displayName = displayNameFor(row.keyId);
    await prisma.paymentConnection.update({
      where: { id: row.id },
      data: { ...(row.status === "pending" ? {} : { status: "connected" }), displayName, lastError: null },
    });
    return { ok: true, displayName };
  } catch (error) {
    const message = short(error);
    await prisma.paymentConnection.update({ where: { id: row.id }, data: { status: "error", lastError: message } });
    return { ok: false, error: message };
  }
}

/**
 * Disconnects, and takes the Composio account down with it. The row stays,
 * as `disconnected`, with its secret destroyed: a delivery from a webhook
 * the operator forgot to remove on Razorpay's side now fails the signature
 * check and writes nothing. Links already issued stay payable on Razorpay —
 * the shop's money is the shop's — but with no secret their webhooks are
 * refused, so the operator records those by hand.
 */
export async function disconnectRazorpay(workspaceId: string): Promise<void> {
  const row = await razorpayConnection(workspaceId);
  if (!row) throw new HttpError(404, "Razorpay is not connected");
  if (row.composioAccountId) {
    await composio().deleteAccount(row.composioAccountId).catch((error: unknown) =>
      console.error(`composio: could not delete account ${row.composioAccountId}`, error));
  }
  await prisma.paymentConnection.update({
    where: { id: row.id },
    data: {
      status: "disconnected", keyId: null, displayName: null, webhookSecret: null,
      composioAccountId: null, composioAuthConfigId: null, connectedAt: null, lastError: null,
    },
  });
  await recordEvent(workspaceId, "payments.disconnected", "order", "razorpay");
}

export type GatewayView = {
  provider: typeof GATEWAY;
  label: string;
  status: PaymentConnection["status"];
  mode: "test" | "live" | null;
  keyId: string | null;
  displayName: string | null;
  connectedAt: string | null;
  lastEventIso: string | null;
  lastError: string | null;
  webhookUrl: string;
  webhookEvents: readonly string[];
  available: boolean;
  unavailableReason: string | null;
  accountRef: string | null;
};

/** How the gateway reaches the browser: never the secret, never the whole key id, never the account id. */
export function gatewayView(row: PaymentConnection | null, workspaceId: string): GatewayView {
  const available = Boolean(env.COMPOSIO_API_KEY) && Boolean(authConfigId());
  return {
    provider: GATEWAY,
    label: "Razorpay",
    status: row?.status ?? "disconnected",
    mode: row?.keyId ? keyMode(row.keyId) : null,
    keyId: row?.keyId ? shortKey(row.keyId) : null,
    displayName: row?.displayName ?? null,
    connectedAt: row?.connectedAt?.toISOString() ?? null,
    lastEventIso: row?.lastEventAt?.toISOString() ?? null,
    lastError: row?.lastError ?? null,
    webhookUrl: webhookUrlFor(workspaceId),
    webhookEvents: WEBHOOK_EVENTS,
    available,
    unavailableReason: available ? null
      : env.COMPOSIO_API_KEY
        ? "Razorpay is not set up in this environment (COMPOSIO_AUTH_CONFIG_RAZORPAY is empty)"
        : "Composio is not configured in this environment (COMPOSIO_API_KEY is empty)",
    accountRef: row?.composioAccountId ? `…${row.composioAccountId.slice(-4)}` : null,
  };
}

// ---------------------------------------------------------------- provider --

/** Razorpay wants at least fifteen minutes and at most six months of life on a link. */
const MIN_LIFE_MS = 16 * 60_000;
const MAX_LIFE_MS = 180 * 86_400_000;

const expiryFor = (wanted: Date | null | undefined, now: Date): number | undefined => {
  if (!wanted) return undefined;
  const at = Math.min(Math.max(wanted.getTime(), now.getTime() + MIN_LIFE_MS), now.getTime() + MAX_LIFE_MS);
  return Math.floor(at / 1000);
};

/** A link still worth sending the customer to: ours, open, and not past its own expiry. */
const stillOpen = (link: PaymentLink | null, now: Date, test: boolean) =>
  Boolean(link && link.provider === GATEWAY && !link.closedAt && link.test === test
    && (!link.expiresAt || link.expiresAt.getTime() > now.getTime()));

/**
 * The provider for one connected workspace.
 *
 * `createCheckoutLink` is idempotent per invoice through the `payment_links`
 * table: the Pay button pressed twice, or the chat reply and the Pay button,
 * get the same Razorpay page. A link is only made again once the old one is
 * closed, and then under a suffixed reference, because Razorpay refuses a
 * second link with a reference it has seen.
 */
export function razorpayProvider(connection: PaymentConnection): PaymentProvider {
  const { workspaceId } = connection;
  const connectedAccountId = connection.composioAccountId!;
  const test = keyMode(connection.keyId ?? "rzp_test_") === "test";

  return {
    name: GATEWAY,
    test,
    shareable: true,
    configured: () => connection.status === "connected",

    async createCheckoutLink(request: CheckoutRequest): Promise<CheckoutOutcome> {
      const now = new Date();
      const existing = await prisma.paymentLink.findUnique({ where: { invoiceNumber: request.reference } });
      if (existing && stillOpen(existing, now, test)) {
        return { ok: true, provider: GATEWAY, link: { url: existing.url, providerRef: existing.id, expiresAt: existing.expiresAt } };
      }

      // Razorpay's `reference_id` must be unique across the account, forever;
      // a re-issue after an expiry carries the attempt on the end.
      const attempt = existing ? Number(existing.reference.split("~")[1] ?? 1) + 1 : 1;
      const reference = attempt === 1 ? request.reference : `${request.reference}~${attempt}`;
      const customer = Object.fromEntries(Object.entries({
        name: request.customer?.name, email: request.customer?.email, contact: request.customer?.phone,
      }).filter(([, value]) => value));

      const result = await composio().execute("RAZORPAY_CREATE_PAYMENT_LINK", {
        userId: workspaceId,
        connectedAccountId,
        arguments: {
          amount: request.amount,
          currency: request.currency,
          description: request.description.slice(0, 2048),
          reference_id: reference.slice(0, 40),
          ...(Object.keys(customer).length ? { customer } : {}),
          // The link travels in Lipi's own reply; Razorpay's SMS or email
          // beside it would be a second, unexpected message from a stranger.
          notify: { sms: false, email: false },
          reminder_enable: false,
          callback_url: returnUrlFor(request.reference),
          callback_method: "get",
          ...(expiryFor(request.expiresAt, now) ? { expire_by: expiryFor(request.expiresAt, now) } : {}),
          // What the webhook carries back, so a delivery can be settled even
          // when the link row it names was replaced in between.
          notes: { invoice: request.reference, workspace: workspaceId },
        },
      });

      const entity = result.successful ? linkEntity(result.data) : undefined;
      const id = str(entity?.id);
      const url = str(entity?.short_url);
      if (!result.successful || !id || !url) {
        return { ok: false, provider: GATEWAY, reason: result.error ?? "Razorpay returned no payment link" };
      }

      const expiresAt = num(entity?.expire_by) ? new Date(num(entity!.expire_by)! * 1000) : request.expiresAt ?? null;
      // One row per invoice: the replaced link stays open on Razorpay's side
      // (`notes.invoice` still settles it if somebody pays it), but the Pay
      // button and the chat point at the new one.
      await prisma.$transaction([
        prisma.paymentLink.deleteMany({ where: { invoiceNumber: request.reference } }),
        prisma.paymentLink.create({
          data: { id, provider: GATEWAY, reference, url, test, expiresAt, invoiceNumber: request.reference, workspaceId },
        }),
      ]);
      await recordEvent(workspaceId, "checkout.link_created", "order",
        `invoice=${request.reference} provider=razorpay ref=${id}${test ? " mode=test" : ""}`);

      return { ok: true, provider: GATEWAY, link: { url, providerRef: id, expiresAt } };
    },

    async lookupLink(providerRef: string): Promise<LinkStatus | null> {
      const result = await composio().execute("RAZORPAY_FETCH_A_PAYMENT_LINK", {
        userId: workspaceId, connectedAccountId, arguments: { plink_id: providerRef },
      });
      const entity = result.successful ? linkEntity(result.data) : undefined;
      if (!entity) return null;
      return { status: linkStatus(str(entity.status)), payments: linkPayments(entity) };
    },
  };
}

/** The workspace's Razorpay provider, or null when it has none connected. */
export async function razorpayProviderFor(workspaceId: string): Promise<PaymentProvider | null> {
  const connection = await razorpayConnection(workspaceId);
  return connection?.status === "connected" && connection.composioAccountId ? razorpayProvider(connection) : null;
}

// -------------------------------------------------------------- settlement --

/**
 * A payment Razorpay reports against a link, settled through the one path
 * every payment takes. `charged` because the money has already moved: a
 * shortfall on the shelf is recorded against the order for a person to
 * resolve rather than refused, since refusing would not give it back.
 */
export async function settleRazorpayPayment(
  workspaceId: string,
  invoiceNumber: string,
  payment: { id: string; amount: number; method: string },
  by = "razorpay",
) {
  return settleInvoice(workspaceId, invoiceNumber, {
    method: paymentMethodFrom(payment.method), reference: payment.id, by, amount: payment.amount, charged: true,
  });
}

type WebhookEvent = {
  event?: string;
  payload?: {
    payment_link?: { entity?: Record<string, unknown> };
    payment?: { entity?: Record<string, unknown> };
  };
};

/**
 * One verified delivery from Razorpay, for one workspace.
 *
 * The invoice is found by the link row first and by `notes.invoice` second,
 * both inside the workspace the URL named and the signature proved; a link
 * that resolves to neither is logged and acknowledged, because Razorpay
 * retries a non-2xx and retrying will not make an unknown link known. The
 * same event delivered twice settles once — `settleInvoice` treats a paid
 * invoice as already paid.
 */
export async function handleRazorpayEvent(workspaceId: string, body: unknown): Promise<void> {
  const event = (record(body) ?? {}) as WebhookEvent;
  const link = record(event.payload?.payment_link?.entity);
  const plinkId = str(link?.id);
  if (!event.event?.startsWith("payment_link.") || !plinkId) {
    console.log(`razorpay webhook: nothing handles ${event.event ?? "?"}`);
    return;
  }

  const row = await prisma.paymentLink.findFirst({ where: { id: plinkId, workspaceId } });
  const noted = str(record(link?.notes)?.invoice);
  const invoiceNumber = row?.invoiceNumber
    ?? (noted ? (await prisma.invoice.findFirst({ where: { workspaceId, number: noted }, select: { number: true } }))?.number : undefined);
  if (!invoiceNumber) {
    console.log(`razorpay webhook: no invoice for ${plinkId}`);
    return;
  }

  if (event.event === "payment_link.paid") {
    const payment = record(event.payload?.payment?.entity);
    const id = str(payment?.id) ?? `plink:${plinkId}`;
    const amount = num(payment?.amount) ?? num(link?.amount_paid) ?? num(link?.amount);
    if (amount === undefined) {
      console.log(`razorpay webhook: ${plinkId} paid with no amount`);
      return;
    }
    const settled = await settleRazorpayPayment(workspaceId, invoiceNumber, { id, amount, method: str(payment?.method) ?? "" });
    if (!settled.ok) console.log(`razorpay webhook: ${invoiceNumber} not settled: ${settled.reason}`);
    return;
  }

  // expired or cancelled: the link is finished and the next Pay makes a new one.
  const closedAs = event.event.slice("payment_link.".length);
  await prisma.paymentLink.updateMany({
    where: { id: plinkId, workspaceId, closedAt: null },
    data: { closedAt: new Date(), closedAs },
  });
}

/**
 * Cancels the open links for an order that will not be paid — it was
 * cancelled on the Orders page — so the customer cannot pay for something
 * the shop has already let go. Best effort: the order is cancelled whether
 * or not Razorpay answers, and the webhook closes the row if this did not.
 */
export async function closePaymentLinksFor(workspaceId: string, orderId: string): Promise<void> {
  const links = await prisma.paymentLink.findMany({
    where: { workspaceId, provider: GATEWAY, closedAt: null, invoice: { orderId } },
  });
  if (!links.length) return;
  const connection = await razorpayConnection(workspaceId);
  if (connection?.status !== "connected" || !connection.composioAccountId) return;

  for (const link of links) {
    const result = await composio().execute("RAZORPAY_CANCEL_PAYMENT_LINK", {
      userId: workspaceId, connectedAccountId: connection.composioAccountId, arguments: { plink_id: link.id },
    }).catch((error: unknown) => ({ successful: false, error: short(error), data: {} }));
    if (!result.successful) {
      console.error(`razorpay: could not cancel ${link.id}: ${result.error ?? "no reason given"}`);
      continue;
    }
    await prisma.paymentLink.update({ where: { id: link.id }, data: { closedAt: new Date(), closedAs: "cancelled" } });
  }
}
