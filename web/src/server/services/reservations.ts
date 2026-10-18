import { prisma, type Tx } from "../lib/prisma";
import { recordEvent } from "../lib/events";
import type { TwinEffect } from "../lib/events";

/**
 * Reservations that lapse (PRD §5, Product & Fitment Twin).
 *
 * "Locks reserved stock for 4 hours upon checkout link generation."
 *
 * Before this, `Variant.reserved` only ever went up until an order settled, so
 * a customer who asked for four polos and never came back held four polos for
 * ever. The twin then reported the business as having less to sell than it
 * had, and the more quotes it produced the wronger it got — which is the worst
 * shape a bug can have, because the system punishes its own success.
 *
 * A hold is provisional until the customer agrees. `Confirmed` and everything
 * past it holds stock until the order settles, which is what `reservedUntil:
 * null` means.
 */

/** PRD §5's figure. */
export const HOLD_HOURS = 4;
export const HOLD_MS = HOLD_HOURS * 60 * 60 * 1000;

/** Stages whose hold is still provisional and may therefore lapse. */
const PROVISIONAL = ["Inquiry", "Quoted"] as const;

export const holdUntil = (now: Date) => new Date(now.getTime() + HOLD_MS);

/**
 * Releases every hold that has lapsed, and says what it released.
 *
 * Idempotent: releasing clears `reservedUntil`, so a second pass over the same
 * window finds nothing. Scoped to one workspace per call, because it is
 * reachable as an HTTP tick and a tick that swept every tenant would be a
 * tick any tenant could make expensive.
 *
 * The decrement is guarded against going negative. It should not be able to —
 * the reservation was made by the same code that is releasing it — but stock
 * arithmetic that can go below zero produces a twin that reports negative
 * availability, and a guard is cheaper than the evening spent explaining it.
 */
export async function releaseExpiredReservations(workspaceId: string, now = new Date()) {
  const lapsed = await prisma.order.findMany({
    where: {
      workspaceId,
      reservedUntil: { not: null, lte: now },
      stage: { in: [...PROVISIONAL] },
    },
    select: { id: true, qty: true, variantId: true, customerId: true },
    orderBy: { reservedUntil: "asc" },
    // A bounded sweep: a tenant with ten thousand lapsed quotes should not
    // make one request hold a transaction open over all of them.
    take: 500,
  });
  if (!lapsed.length) return { released: 0, orders: [] as string[] };

  const released: string[] = [];

  for (const order of lapsed) {
    await prisma.$transaction(async (tx) => {
      // Re-read inside the transaction: two sweeps racing must not both
      // release the same hold and decrement `reserved` twice.
      const current = await tx.order.findFirst({
        where: { id: order.id, reservedUntil: { not: null, lte: now }, stage: { in: [...PROVISIONAL] } },
        select: { id: true },
      });
      if (!current) return;

      const variant = await tx.variant.findUnique({
        where: { id: order.variantId },
        select: { reserved: true },
      });
      const give = Math.min(order.qty, variant?.reserved ?? 0);

      if (give > 0) {
        await tx.variant.update({
          where: { id: order.variantId },
          data: { reserved: { decrement: give } },
        });
      }

      await tx.order.update({
        where: { id: order.id },
        data: { reservedUntil: null, blocked: `Reservation lapsed after ${HOLD_HOURS} hours` },
      });

      await tx.twinEvent.create({
        data: {
          id: `evt_${Math.random().toString(36).slice(2, 10)}`,
          workspaceId,
          occurredAt: now,
          type: "inventory_twin.hold_expired",
          twin: "inventory",
          payload: `order=${order.id} variant=${order.variantId} released=${give} after=${HOLD_HOURS}h`,
        },
      });

      released.push(order.id);
    });
  }

  return { released: released.length, orders: released };
}

/**
 * Makes a hold permanent, because the customer agreed.
 *
 * Called when an order reaches `Confirmed`. Nothing about the stock changes —
 * it was already reserved — only the expiry goes away.
 */
export async function firmUpReservation(tx: Tx, orderId: string) {
  await tx.order.update({ where: { id: orderId }, data: { reservedUntil: null } });
}

/** The effects a caller should append when it reserves with a hold. */
export const holdEffect = (orderId: string, qty: number, until: Date): TwinEffect => ({
  type: "inventory_twin.hold_placed",
  twin: "inventory",
  payload: `order=${orderId} qty=${qty} until=${until.toISOString()} hours=${HOLD_HOURS}`,
});

/** Records the sweep itself, so an empty one is still evidence it ran. */
export const recordSweep = (workspaceId: string, released: number) =>
  recordEvent(workspaceId, "inventory_twin.sweep", "inventory", `released=${released}`);
