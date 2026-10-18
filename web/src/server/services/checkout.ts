import { randomUUID } from "node:crypto";
import type { PaymentMethod } from "@/generated/prisma/client";
import { sendReply } from "../channels/outbound";
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
 * still there. Whoever settles the invoice — the demo checkout today, a
 * provider's webhook later — comes through this one function, so the order,
 * the stock and the message the customer gets are the same either way.
 */

export type Settlement =
  | { ok: true; alreadyPaid: boolean; orderId: string | null }
  | { ok: false; reason: "sold_out" | "not_found"; message: string };

const id = (prefix: string) => `${prefix}_${randomUUID().slice(0, 8)}`;

/** Stages an order can still be paid from. Anything later has been paid already. */
const PAYABLE = ["Inquiry", "Quoted", "Confirmed"] as const;

export async function settleInvoice(
  workspaceId: string,
  number: string,
  payment: { method: PaymentMethod; reference: string; by: string },
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
    if (owed <= 0) return { ok: true, alreadyPaid: true, orderId: invoice.orderId };

    const order = invoice.order;
    const events: { type: string; twin: string; payload: string }[] = [];

    if (order && (PAYABLE as readonly string[]).includes(order.stage)) {
      // Re-read inside the transaction, so two customers paying for the last
      // unit at once cannot both be sold it.
      const variant = await tx.variant.findUniqueOrThrow({ where: { id: order.variantId } });
      const available = variant.stock - variant.reserved;
      // An order that already holds its stock — confirmed by hand, a
      // purchase order's hold, one quoted before payment came first — needs
      // no second unit.
      const holds = holdsStock(order);
      if (!holds && available < order.qty) {
        return {
          ok: false,
          reason: "sold_out",
          message: `Sorry — ${order.product.name} ${order.variant} sold out before payment. You have not been charged.`,
        };
      }

      if (!holds) {
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
      await tx.order.update({ where: { id: order.id }, data: { stage: "Paid", reservedUntil: null, blocked: null } });
      events.push({ type: "order_twin.updated", twin: "order", payload: `${order.id} stage=paid` });
    }

    await tx.payment.create({
      data: {
        id: id("pay"), workspaceId, receivedAt: now, method: payment.method, reference: payment.reference,
        loggedBy: payment.by, amount: owed, invoiceNumber: invoice.number, customerId: invoice.customerId,
      },
    });
    events.unshift({ type: "payment.received", twin: "order", payload: `${invoice.number} amount=${toRupees(owed)} via=${payment.by}` });

    await tx.twinEvent.createMany({
      data: events.map((event, i) => ({
        id: id("evt"), workspaceId, occurredAt: new Date(now.getTime() + i), ...event,
      })),
    });

    return { ok: true, alreadyPaid: false, orderId: invoice.orderId };
  });

  if (outcome.ok && !outcome.alreadyPaid) await confirmToCustomer(workspaceId, number);
  return outcome;
}

/**
 * Tells the customer, on the channel they bought on, that it worked.
 *
 * Written into their latest conversation on that channel and sent through
 * the one outbound path, so it shows in the inbox like any other reply. A
 * customer who bought on the website widget has no channel to push to; the
 * invoice page they paid on already says it.
 */
async function confirmToCustomer(workspaceId: string, number: string) {
  const invoice = await prisma.invoice.findFirst({
    where: { workspaceId, number },
    include: { order: { include: { product: true } }, customer: true },
  });
  if (!invoice?.order) return;
  const { order } = invoice;

  const conversation = await prisma.conversation.findFirst({
    where: { workspaceId, customerId: invoice.customerId, channel: order.channel },
    orderBy: { lastAt: "desc" },
  });
  if (!conversation || order.channel === "webchat") return;

  const text =
    `Payment received for ${invoice.number} — ₹${toRupees(invoice.amount).toLocaleString("en-IN")}. ` +
    `Your ${order.qty} × ${order.product.name} (${order.variant}) is confirmed and set aside for you. ` +
    "We'll let you know when it ships.";

  const message = await prisma.message.create({
    data: { from: "agent", text, sentAt: new Date(), conversationId: conversation.id },
  });
  await prisma.conversation.update({ where: { id: conversation.id }, data: { lastAt: new Date(), unread: true } });
  await sendReply({ workspaceId, conversationId: conversation.id, messageId: message.id, by: "payment" })
    .catch((error: unknown) => console.error(`[checkout] confirmation not sent: ${(error as Error).message}`));
}
