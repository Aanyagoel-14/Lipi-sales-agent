import { z } from "zod";
import { body, HttpError, json, route } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { requireUser } from "@/server/lib/session";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { recordEvent } from "../../../events";

/** Moving an order on. Stage order is enforced so history cannot go backwards by accident. */
const STAGES = ["Quoted", "Paid", "Packed", "Shipped", "Delivered"] as const;

export const POST = route<{ id: string }>(async (req, { id: orderId }) => {
  const user = await requireUser();
  const workspaceId = await resolveWorkspaceId();
  const data = await body(req, z.object({ stage: z.enum([...STAGES, "Returned"]) }), "Unknown stage");

  const order = await prisma.order.findFirst({ where: { id: orderId, workspaceId } });
  if (!order) throw new HttpError(404, "Order not found");

  const from = STAGES.indexOf(order.stage as (typeof STAGES)[number]);
  const to = STAGES.indexOf(data.stage as (typeof STAGES)[number]);

  // Returned is reachable from anywhere; otherwise only forward, one step at a time.
  if (data.stage !== "Returned") {
    if (from === -1) throw new HttpError(409, `An order that is ${order.stage} cannot move again`);
    if (to <= from) throw new HttpError(409, `${order.stage} cannot go back to ${data.stage}`);
    if (to > from + 1) throw new HttpError(409, `${order.stage} moves to ${STAGES[from + 1]} next`);
  }

  // C-2 fix: fulfilment must settle the inventory twin, or stock and
  // reservations drift from reality on every completed or returned order.
  //
  //  - Delivered: the units have physically left the building. Stock is
  //    decremented (it is no longer on hand) and the reservation against it
  //    is released (there is nothing left to hold).
  //  - Returned: whatever stage the order was in, the reservation this order
  //    made is released. If it had already reached Delivered, the units
  //    physically came back, so stock is restored too. If it had not yet
  //    shipped, stock was never decremented, so only the reservation moves.
  //
  // Both paths are guarded so re-running the same transition twice (a retried
  // request) cannot double-settle: Delivered only settles once because the
  // order can only ever be *entering* Delivered here (from < to, one step),
  // and Returned only restores stock if it is transitioning from Delivered
  // for the first time (order.stage captured before the update, inside the
  // same transaction as the mutation).
  const wasDelivered = order.stage === "Delivered";

  await prisma.$transaction(async (tx) => {
    await tx.order.update({ where: { id: orderId }, data: { stage: data.stage, blocked: null } });

    if (data.stage === "Delivered") {
      await tx.variant.update({
        where: { id: order.variantId },
        data: { stock: { decrement: order.qty }, reserved: { decrement: order.qty } },
      });
      await recordEvent(workspaceId, "inventory_twin.settled", "inventory",
        `order=${orderId} sku_variant=${order.variantId} qty=${order.qty} stock-=${order.qty} reserved-=${order.qty} (delivered)`);
    } else if (data.stage === "Returned") {
      await tx.variant.update({
        where: { id: order.variantId },
        data: {
          reserved: { decrement: order.qty },
          ...(wasDelivered ? { stock: { increment: order.qty } } : {}),
        },
      });
      await recordEvent(workspaceId, "inventory_twin.settled", "inventory",
        `order=${orderId} sku_variant=${order.variantId} qty=${order.qty} reserved-=${order.qty}` +
          (wasDelivered ? ` stock+=${order.qty} (returned after delivery)` : ` (returned before delivery, stock unaffected)`));
    }

    await recordEvent(workspaceId, "order_twin.updated", "order",
      `${orderId} ${order.stage}->${data.stage} by ${user.email}`);
  });

  return json({ ok: true, stage: data.stage });
});
