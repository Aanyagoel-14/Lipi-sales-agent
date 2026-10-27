import { randomUUID } from "node:crypto";
import type { PaymentMethod } from "@/generated/prisma/client";
import { messageCustomer } from "../channels/outbound";
import { env } from "../env";
import { paymentProviderFor, type CheckoutOutcome, type PaymentProvider } from "../lib/payments";
import { prisma } from "../lib/prisma";
import { toRupees } from "../lib/money";
import { REORDER_POINT } from "./ingest";
import { holdsStock } from "./reservations";
import { planRestock, raiseRestock } from "./twin-rules";

/**
 * Payment, which is where a sale becomes real.
 *
 * A customer who says "I want one" is quoted and sent their invoice with a
 * way to pay; nothing is taken out of stock for them until the money arrives.
 * That is how a shop that sells in chat usually works, and it is the order of
 * events the operator asked for: a reservation on a message is a promise the
 * shop made on the customer's behalf, and most of those customers never pay.
 *
 * So stock is committed here, at the moment of payment, and only if it is
 * still there. Whoever settles the invoice — the demo checkout, Stripe's
 * webhook, the operator recording a bank transfer — comes through this one
 * function, so the order, the stock and the message the customer gets are
 * the same either way.
 */

export type Settlement =
  | {
    ok: true;
    alreadyPaid: boolean;
    orderId: string | null;
    /** The invoice is now paid in full. False for a partial payment, which is recorded and nothing more. */
    covered: boolean;
    /** Paid, but the shelf could not fill it: the order is flagged for a person. */
    short: boolean;
  }
  | { ok: false; reason: "sold_out" | "not_found"; message: string };

export type PaymentReceived = {
  method: PaymentMethod;
  reference: string | null;
  by: string;
  /** What was actually received, in paise. Absent means the whole balance. */
  amount?: number;
  /**
   * True when the money has already moved — a gateway's webhook, a bank
   * transfer the operator is recording. A demo or an in-page checkout that
   * can still decline leaves it false. The difference matters only when the
   * stock has gone in the meantime: money not yet taken is refused, money
   * already taken is recorded and the order is flagged for a person to
   * refund or restock, because refusing it would not give it back.
   */
  charged?: boolean;
};

const id = (prefix: string) => `${prefix}_${randomUUID().slice(0, 8)}`;

/** Stages an order can still be paid from. Anything later has been paid already. */
const PAYABLE = ["Inquiry", "Quoted", "Confirmed"] as const;

export async function settleInvoice(
  workspaceId: string,
  number: string,
  payment: PaymentReceived,
  now = new Date(),
): Promise<Settlement> {
  const outcome = await prisma.$transaction(async (tx): Promise<Settlement> => {
    const invoice = await tx.invoice.findFirst({
      where: { workspaceId, number },
      include: { payments: true, order: { include: { product: true } } },
    });
    if (!invoice) return { ok: false, reason: "not_found", message: "This invoice does not exist." };

    const paid = invoice.payments.reduce((sum, p) => sum + p.amount, 0);
    const owed = invoice.amount - paid;
    // Paying twice is a double click or a provider retry, not a second sale.
    if (owed <= 0) return { ok: true, alreadyPaid: true, orderId: invoice.orderId, covered: true, short: false };

    // Never more than is owed: a gateway that reports the whole link amount
    // on a retry must not turn a paid invoice into an overpaid one.
    const received = Math.min(payment.amount ?? owed, owed);
    if (received <= 0) return { ok: true, alreadyPaid: true, orderId: invoice.orderId, covered: false, short: false };
    const covered = received >= owed;

    const order = invoice.order;
    const events: { type: string; twin: string; payload: string }[] = [];
    let short = false;

    if (covered && order && (PAYABLE as readonly string[]).includes(order.stage)) {
      // Re-read inside the transaction, so two customers paying for the last
      // unit at once cannot both be sold it.
      const variant = await tx.variant.findUniqueOrThrow({ where: { id: order.variantId } });
      const available = variant.stock - variant.reserved;
      // An order that already holds its stock — confirmed by hand, a
      // purchase order's hold, one quoted before payment came first — needs
      // no second unit.
      const holds = holdsStock(order);
      if (!holds && available < order.qty) {
        if (!payment.charged) {
          return {
            ok: false,
            reason: "sold_out",
            message: `Sorry — ${order.product.name} ${order.variant} sold out before payment. You have not been charged.`,
          };
        }
        // The money is in the shop's account and the shelf is empty. That is
        // the shop's to resolve — restock or refund — not the twin's to hide.
        short = true;
      }

      if (!holds && !short) {
        await tx.variant.update({ where: { id: variant.id }, data: { reserved: { increment: order.qty } } });
        const remaining = available - order.qty;
        events.push({
          type: "inventory_twin.reserved", twin: "inventory",
          payload: `sku=${variant.sku} qty=${order.qty} remaining=${remaining} via=payment`,
        });

        // The moment stock is actually used up is the moment to restock.
        // `planRestock` declines while a PO for this variant is still open,
        // so a run of sales raises one, not one each.
        if (remaining <= REORDER_POINT) {
          events.push({ type: "inventory_twin.threshold_breached", twin: "inventory", payload: `sku=${variant.sku} reorder_point=${REORDER_POINT}` });
          const plan = await planRestock(tx, {
            workspaceId, productId: order.productId, variantId: variant.id, supplierId: order.product.supplierId,
            available: remaining, reorderPoint: REORDER_POINT, now,
          });
          if (plan) events.push(await raiseRestock(tx, { workspaceId, productId: order.productId, variantId: variant.id, plan }));
        }
      }
      // Paid holds its stock until it ships: no expiry, no sweep.
      await tx.order.update({
        where: { id: order.id },
        data: {
          stage: "Paid",
          reservedUntil: null,
          blocked: short
            ? `Paid, but ${order.product.name} ${order.variant} sold out before the payment landed — refund or restock`
            : null,
        },
      });
      events.push({ type: "order_twin.updated", twin: "order", payload: `${order.id} stage=paid${short ? " stock=short" : ""}` });
    }

    await tx.payment.create({
      data: {
        id: id("pay"), workspaceId, receivedAt: now, method: payment.method, reference: payment.reference,
        loggedBy: payment.by, amount: received, invoiceNumber: invoice.number, customerId: invoice.customerId,
      },
    });
    events.unshift({
      type: "payment.received", twin: "order",
      payload: `${invoice.number} amount=${toRupees(received)} via=${payment.by}${covered ? "" : " partial"}`,
    });

    // The gateway's link for this invoice has done its job.
    if (covered) {
      await tx.paymentLink.updateMany({
        where: { invoiceNumber: invoice.number, closedAt: null },
        data: { closedAt: now, closedAs: "paid" },
      });
    }

    await tx.twinEvent.createMany({
      data: events.map((event, i) => ({
        id: id("evt"), workspaceId, occurredAt: new Date(now.getTime() + i), ...event,
      })),
    });

    return { ok: true, alreadyPaid: false, orderId: invoice.orderId, covered, short };
  });

  if (outcome.ok && !outcome.alreadyPaid && outcome.covered) await confirmToCustomer(workspaceId, number, outcome.short);
  return outcome;
}

/**
 * Tells the customer, on the channel they bought on, that it worked — or,
 * when the shelf emptied between the quote and the payment, what happens
 * next. A customer who bought on the website widget has no channel to push
 * to; the invoice page they paid on already says it.
 */
async function confirmToCustomer(workspaceId: string, number: string, short: boolean) {
  const invoice = await prisma.invoice.findFirst({
    where: { workspaceId, number },
    include: { order: { include: { product: true } } },
  });
  if (!invoice?.order || invoice.order.channel === "webchat") return;
  const { order } = invoice;
  const item = `${order.qty} × ${order.product.name} (${order.variant})`;
  const amount = `₹${toRupees(invoice.amount).toLocaleString("en-IN")}`;

  await messageCustomer({
    workspaceId,
    orderId: order.id,
    by: "payment",
    text: short
      ? `Payment received for ${invoice.number} — ${amount}. We're sorry: ${item} sold out just before your payment ` +
        "landed. We'll confirm a restock date or refund you in full within one working day."
      : `Payment received for ${invoice.number} — ${amount}. Your ${item} is confirmed and set aside for you. ` +
        "We'll let you know when it ships.",
  }).catch((error: unknown) => console.error(`[checkout] confirmation not sent: ${(error as Error).message}`));
}

const DAY = 86_400_000;

/**
 * How long a gateway link stays payable: a week past the due date. The
 * invoice says "payable by"; the link does not die at midnight on that day,
 * because a customer who pays the next morning is still a customer.
 */
export const linkExpiry = (dueOn: Date) => new Date(dueOn.getTime() + 8 * DAY - 1);

/**
 * A number a gateway will accept as the payer's: E.164-ish, with the
 * country code. A WhatsApp id is one already (digits, country code first);
 * a typed phone is taken only when it says its country.
 */
function payerPhone(customer: { phone: string | null; handle: string; channel: string }): string | undefined {
  const typed = customer.phone?.replace(/[\s()-]/g, "");
  if (typed && /^\+\d{8,14}$/.test(typed)) return typed;
  if (customer.channel === "whatsapp" && /^\d{8,14}$/.test(customer.handle)) return `+${customer.handle}`;
  return undefined;
}

/**
 * The link that pays an invoice, from whichever provider the workspace has.
 *
 * Built from the invoice rather than from what a caller says it owes, so a
 * link can never ask for a different number than the document does. The Pay
 * button and the chat reply both come through here.
 */
export async function checkoutFor(
  workspaceId: string,
  number: string,
  provider?: PaymentProvider,
): Promise<{ provider: PaymentProvider; checkout: CheckoutOutcome }> {
  provider ??= await paymentProviderFor(workspaceId);
  const unavailable = (reason: string): CheckoutOutcome => ({ ok: false, provider: provider!.name, reason });

  const invoice = await prisma.invoice.findFirst({
    where: { workspaceId, number },
    include: {
      payments: true,
      customer: { select: { name: true, handle: true, channel: true, email: true, phone: true } },
      order: { include: { product: { select: { name: true } } } },
    },
  });
  if (!invoice) return { provider, checkout: unavailable("This invoice does not exist") };
  const owed = invoice.amount - invoice.payments.reduce((sum, p) => sum + p.amount, 0);
  if (owed <= 0) return { provider, checkout: unavailable("This invoice is already paid") };
  if (!provider.configured()) return { provider, checkout: unavailable("No payment provider is configured") };

  const { customer, order } = invoice;
  const checkout = await provider.createCheckoutLink({
    workspaceId,
    amount: owed,
    currency: env.STRIPE_CURRENCY,
    description: order ? `${order.qty} × ${order.product.name} (${order.variant}) — ${number}` : `Invoice ${number}`,
    reference: number,
    customer: {
      // Until they say who they are, the name on file is their account id.
      name: customer.name !== customer.handle ? customer.name : undefined,
      email: customer.email ?? undefined,
      phone: payerPhone(customer),
    },
    expiresAt: linkExpiry(invoice.dueOn),
  });
  return { provider, checkout };
}
