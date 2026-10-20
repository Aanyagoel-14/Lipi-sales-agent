import { z } from "zod";
import { messageCustomer } from "@/server/channels/outbound";
import { body, HttpError, json, route } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { requireUser } from "@/server/lib/session";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { settleInvoice } from "@/server/services/checkout";
import { invoiceForOrder } from "@/server/services/invoicing";
import { confirmOrder, holdsStock } from "@/server/services/reservations";
import { recordEvent } from "../../../events";

/**
 * Moving an order on, the way a shop does.
 *
 * The PRD's chain (Inquiry -> Quote -> Confirmed -> Paid -> Packed -> Shipped
 * -> Delivered) is the usual path, but a shop does not walk it one rung at a
 * time: a quote paid by bank transfer is simply paid, a confirmed order on
 * credit terms ships before the money arrives, and an order nobody paid for
 * is cancelled, not returned. `NEXT` says where each stage may go; nothing
 * goes backwards. (This replaces the one-step rule of D-018.)
 *
 * Two stages do more than change the label. `Confirmed` takes the stock if
 * the order held none. `Paid` is a payment: it is recorded against the
 * invoice — issued now if it was not — and the stock is taken exactly as the
 * payment link takes it, through `settleInvoice`, which also tells the
 * customer. Marking an order paid without any of that would leave the stock
 * table saying the unit is still for sale.
 */
const STAGES = ["Inquiry", "Quoted", "Confirmed", "Paid", "Packed", "Shipped", "Delivered", "Returned", "Cancelled"] as const;
type Stage = (typeof STAGES)[number];

const NEXT: Record<Stage, readonly Stage[]> = {
  Inquiry: ["Quoted", "Confirmed", "Paid", "Cancelled"],
  Quoted: ["Confirmed", "Paid", "Cancelled"],
  Confirmed: ["Paid", "Packed", "Cancelled"],
  Paid: ["Packed", "Returned"],
  Packed: ["Shipped", "Returned"],
  Shipped: ["Delivered", "Returned"],
  Delivered: ["Returned"],
  Returned: [],
  Cancelled: [],
};

const stageSchema = z.object({
  stage: z.enum(STAGES),
  /** Read only when the stage is Paid: how the money came, and any reference the operator has for it. */
  method: z.enum(["bank_transfer", "card", "upi", "cash"]).optional(),
  reference: z.string().trim().max(80).optional(),
});

export const POST = route<{ id: string }>(async (req, { id: orderId }) => {
  const user = await requireUser();
  const workspaceId = await resolveWorkspaceId();
  const data = await body(req, stageSchema, "Unknown stage");

  const order = await prisma.order.findFirst({
    where: { id: orderId, workspaceId },
    include: { product: { select: { name: true } } },
  });
  if (!order) throw new HttpError(404, "Order not found");

  const from = order.stage as Stage;
  if (!NEXT[from].includes(data.stage)) {
    throw new HttpError(409, NEXT[from].length
      ? `${from} can move to ${NEXT[from].join(", ")}, not ${data.stage}`
      : `An order that is ${from} cannot move again`);
  }

  if (data.stage === "Paid") {
    const { invoice } = await invoiceForOrder(workspaceId, orderId);
    const settled = await settleInvoice(workspaceId, invoice.number, {
      method: data.method ?? "bank_transfer", reference: data.reference ?? null, by: user.email,
    });
    if (!settled.ok) throw new HttpError(409, settled.message);
    await recordEvent(workspaceId, "order_twin.updated", "order", `${orderId} ${from}->Paid by ${user.email}`);
    return json({ ok: true, stage: "Paid" });
  }

  // Fulfilment must settle the inventory twin, or stock and reservations
  // drift from reality on every completed or returned order.
  //
  //  - Delivered: the units have physically left the building. Stock is
  //    decremented and the reservation against it is released.
  //  - Returned or Cancelled: whatever the order held is released. After
  //    Delivered the units physically came back, so stock is restored too;
  //    before it, stock was never decremented, so only the reservation moves.
  //    An order that held nothing — a quote never paid for — releases nothing,
  //    or it would hand back somebody else's reservation.
  //
  // Guarded against double-settling a retried request: Delivered is only ever
  // *entered* here, and the stock restore reads the stage captured before the
  // update, inside the same transaction.
  const wasDelivered = order.stage === "Delivered";
  const held = holdsStock(order);

  await prisma.$transaction(async (tx) => {
    if (data.stage === "Confirmed") {
      // A live hold stops being provisional; an order that held nothing takes
      // its stock now, if it is still there (`services/reservations.ts`).
      const confirmed = await confirmOrder(tx, workspaceId, orderId);
      if (!confirmed.ok) throw new HttpError(409, confirmed.reason);
    } else {
      await tx.order.update({
        where: { id: orderId },
        data: {
          stage: data.stage,
          blocked: data.stage === "Cancelled" ? `Cancelled by ${user.email}` : null,
          ...(data.stage === "Returned" || data.stage === "Cancelled" ? { reservedUntil: null } : {}),
        },
      });
    }

    if (data.stage === "Delivered") {
      await tx.variant.update({
        where: { id: order.variantId },
        data: { stock: { decrement: order.qty }, reserved: { decrement: order.qty } },
      });
      await recordEvent(workspaceId, "inventory_twin.settled", "inventory",
        `order=${orderId} sku_variant=${order.variantId} qty=${order.qty} stock-=${order.qty} reserved-=${order.qty} (delivered)`);
    } else if ((data.stage === "Returned" || data.stage === "Cancelled") && held) {
      await tx.variant.update({
        where: { id: order.variantId },
        data: {
          reserved: { decrement: order.qty },
          ...(wasDelivered ? { stock: { increment: order.qty } } : {}),
        },
      });
      await recordEvent(workspaceId, "inventory_twin.settled", "inventory",
        `order=${orderId} sku_variant=${order.variantId} qty=${order.qty} reserved-=${order.qty}` +
          (wasDelivered ? ` stock+=${order.qty} (returned after delivery)` : ` (${data.stage.toLowerCase()} before delivery, stock unaffected)`));
    }

    await recordEvent(workspaceId, "order_twin.updated", "order",
      `${orderId} ${order.stage}->${data.stage} by ${user.email}`);
  });

  // The customer was told "we'll let you know when it ships". Sent on the
  // channel they bought on; a failure to send is the message's state, not
  // the order's, so it does not undo the stage.
  if (data.stage === "Shipped" || data.stage === "Delivered") {
    const what = `${order.qty} × ${order.product.name} (${order.variant})`;
    await messageCustomer({
      workspaceId, orderId, by: user.email,
      text: data.stage === "Shipped"
        ? `Your order ${orderId} — ${what} — has shipped.`
        : `Your order ${orderId} — ${what} — has been delivered. Thank you!`,
    }).catch((error: unknown) => console.error(`[orders] shipping note not sent: ${(error as Error).message}`));
  }

  return json({ ok: true, stage: data.stage });
});
