import { beforeEach, describe, expect, it } from "vitest";
import { createUser, createWorkspace, resetDatabase, signedIn } from "./helpers";
import { prisma } from "@/server/lib/prisma";
import { ingest } from "@/server/services/ingest";
import { HOLD_HOURS, HOLD_MS, releaseExpiredReservations } from "@/server/services/reservations";
import { VIP_LIFETIME_VALUE, vipRouting } from "@/server/services/twin-rules";

/**
 * The Digital Twin rules PRD §5 states, now that something reads them.
 *
 * Three rules and a state machine, each of which was previously either absent
 * or a sentence in a log:
 *
 *   "Locks reserved stock for 4 hours upon checkout link generation"
 *   "flags credit risk if past-due invoices > 0"
 *   "routes VIP inquiries instantly"
 *   "auto-dispatches POs when reserved inventory drops below threshold"
 */

let workspaceId: string;

async function setup(policy: "everything" | "money_only" | "nothing" = "nothing") {
  const { user } = await createUser();
  const workspace = await createWorkspace({ userId: user.id, policy });
  workspaceId = workspace.id;
  return workspace;
}

const buy = (text = "I want 2 olive L polos", handle = "+91 90 000 0001") =>
  ingest({ workspaceId, channel: "whatsapp", handle, text });

const variantOf = (optionA: string, optionB: string) =>
  prisma.variant.findFirstOrThrow({
    where: { optionA, optionB, product: { workspaceId, name: "Polo Classic" } },
  });

beforeEach(async () => { await resetDatabase(); });

describe("the four-hour reservation hold", () => {
  it("stamps a reservation with an expiry when stock is held", async () => {
    await setup();
    const before = Date.now();
    const result = await buy();

    expect(result.reservedUntil).not.toBeNull();
    const until = new Date(result.reservedUntil!).getTime();
    expect(until).toBeGreaterThanOrEqual(before + HOLD_MS - 5_000);
    expect(until).toBeLessThanOrEqual(Date.now() + HOLD_MS + 5_000);

    const order = await prisma.order.findFirstOrThrow({ where: { workspaceId } });
    expect(order.reservedUntil).not.toBeNull();

    const events = await prisma.twinEvent.findMany();
    expect(events.map((e) => e.type)).toContain("inventory_twin.hold_placed");
  });

  // The failure this prevents: an abandoned quote holding stock for ever, so
  // the twin reports the business as having less to sell than it has — and
  // the more quotes it produces, the wronger it gets.
  it("gives the stock back once the hold lapses", async () => {
    await setup();
    const result = await buy();
    const held = await variantOf("L", "Olive");
    expect(held.reserved).toBe(2);

    // Wind the hold back rather than waiting four hours.
    await prisma.order.update({
      where: { id: result.order!.id },
      data: { reservedUntil: new Date(Date.now() - 1000) },
    });

    const swept = await releaseExpiredReservations(workspaceId);
    expect(swept.released).toBe(1);

    const after = await variantOf("L", "Olive");
    expect(after.reserved).toBe(0);

    const order = await prisma.order.findFirstOrThrow({ where: { id: result.order!.id } });
    expect(order.reservedUntil).toBeNull();
    expect(order.blocked).toContain(`${HOLD_HOURS} hours`);

    const events = await prisma.twinEvent.findMany();
    expect(events.map((e) => e.type)).toContain("inventory_twin.hold_expired");
  });

  it("leaves a hold that has not lapsed alone", async () => {
    await setup();
    await buy();
    const swept = await releaseExpiredReservations(workspaceId);

    expect(swept.released).toBe(0);
    expect((await variantOf("L", "Olive")).reserved).toBe(2);
  });

  // Releasing clears the expiry, so a second pass finds nothing. Two sweeps
  // racing must not both decrement the same reservation.
  it("is idempotent: sweeping twice releases once", async () => {
    await setup();
    const result = await buy();
    await prisma.order.update({
      where: { id: result.order!.id },
      data: { reservedUntil: new Date(Date.now() - 1000) },
    });

    expect((await releaseExpiredReservations(workspaceId)).released).toBe(1);
    expect((await releaseExpiredReservations(workspaceId)).released).toBe(0);
    expect((await variantOf("L", "Olive")).reserved).toBe(0);
  });

  it("does not touch another tenant's lapsed holds", async () => {
    await setup();
    const mine = await buy();
    await prisma.order.update({
      where: { id: mine.order!.id },
      data: { reservedUntil: new Date(Date.now() - 1000) },
    });

    const { user: other } = await createUser("other@test.local");
    const theirs = await createWorkspace({ userId: other.id, name: "Other Co" });
    const theirOrder = await ingest({
      workspaceId: theirs.id, channel: "whatsapp", handle: "+91 90 000 0009", text: "I want 2 olive L polos",
    });
    await prisma.order.update({
      where: { id: theirOrder.order!.id },
      data: { reservedUntil: new Date(Date.now() - 1000) },
    });

    const swept = await releaseExpiredReservations(workspaceId);
    expect(swept.orders).toEqual([mine.order!.id]);

    const stillHeld = await prisma.order.findFirstOrThrow({ where: { id: theirOrder.order!.id } });
    expect(stillHeld.reservedUntil).not.toBeNull();
  });

  // Confirming is the customer agreeing, which is when the hold stops being
  // provisional.
  it("stops being provisional once the order is confirmed", async () => {
    await setup();
    const result = await buy();
    const agent = await signedIn();

    await agent.post(`/v1/orders/${result.order!.id}/stage`).send({ stage: "Confirmed" }).expect(200);

    const order = await prisma.order.findFirstOrThrow({ where: { id: result.order!.id } });
    expect(order.stage).toBe("Confirmed");
    expect(order.reservedUntil).toBeNull();

    // And a sweep now leaves the stock alone however long it has been.
    expect((await releaseExpiredReservations(workspaceId)).released).toBe(0);
    expect((await variantOf("L", "Olive")).reserved).toBe(2);

    const events = await prisma.twinEvent.findMany();
    expect(events.map((e) => e.type)).toContain("inventory_twin.hold_confirmed");
  });

  it("is reachable as a tick, and records that it ran even when it found nothing", async () => {
    await setup();
    const agent = await signedIn();

    const res = await agent.post("/v1/inventory/reservations/sweep").expect(200);
    expect(res.body).toMatchObject({ released: 0, holdHours: HOLD_HOURS });

    const events = await prisma.twinEvent.findMany();
    expect(events.map((e) => e.type)).toContain("inventory_twin.sweep");
  });
});

describe("credit risk", () => {
  async function withOverdue(amount = 5_000_00) {
    await setup();
    // A first message, so the customer twin exists to attach an invoice to.
    const first = await buy("hello");
    await prisma.invoice.create({
      data: {
        number: "INV-2026-9001-test", workspaceId, source: "manual",
        issuedOn: new Date("2026-01-01"), dueOn: new Date("2026-01-15"),
        amount, customerId: first.customer.id,
      },
    });
    return first.customer.id;
  }

  // PRD §5: "flags credit risk if past-due invoices > 0". A flag, not a
  // refusal — a good customer with one late invoice is still a good customer.
  it("flags the order and the trail, and still makes the sale", async () => {
    await withOverdue();
    const result = await buy();

    expect(result.creditHold).toBe(true);
    expect(result.order).not.toBeNull();

    const order = await prisma.order.findFirstOrThrow({ where: { id: result.order!.id } });
    expect(order.creditHold).toBe(true);

    const events = await prisma.twinEvent.findMany();
    const flag = events.find((e) => e.type === "customer_twin.credit_risk");
    expect(flag).toBeDefined();
    expect(flag!.payload).toContain("overdue_invoices=1");
  });

  it("does not flag when the overdue invoice has been paid in full", async () => {
    const customerId = await withOverdue();
    await prisma.payment.create({
      data: {
        id: "pay_full", workspaceId, customerId, amount: 5_000_00,
        method: "bank_transfer", receivedAt: new Date("2026-01-10"), loggedBy: "test",
        invoiceNumber: "INV-2026-9001-test",
      },
    });

    const result = await buy();
    expect(result.creditHold).toBe(false);
  });

  it("does not flag an invoice that is not yet due", async () => {
    await setup();
    const first = await buy("hello");
    await prisma.invoice.create({
      data: {
        number: "INV-2026-9002-test", workspaceId, source: "manual",
        issuedOn: new Date(), dueOn: new Date(Date.now() + 30 * 86_400_000),
        amount: 1_000_00, customerId: first.customer.id,
      },
    });

    expect((await buy()).creditHold).toBe(false);
  });
});

describe("VIP routing", () => {
  // PRD §5: "routes VIP inquiries instantly".
  it("routes a Corporate buyer as VIP", () => {
    expect(vipRouting({ segment: "Corporate", lifetimeValue: 0 })).toBe("segment");
  });

  it("routes a high-lifetime-value buyer as VIP whatever their segment", () => {
    expect(vipRouting({ segment: "Retail", lifetimeValue: VIP_LIFETIME_VALUE })).toBe("lifetime_value");
    expect(vipRouting({ segment: "Retail", lifetimeValue: VIP_LIFETIME_VALUE - 1 })).toBeNull();
  });

  it("records the routing on the trail when a purchase order arrives", async () => {
    await setup();
    // A purchase order promotes the twin to Corporate in the same message,
    // and the rule is read after the twin is settled — so it is routed as the
    // VIP it has just become.
    const result = await buy("PO for 5 olive L polos, net 30");

    expect(result.vip).toBe("segment");
    const events = await prisma.twinEvent.findMany();
    const routed = events.find((e) => e.type === "customer_twin.vip_routed");
    expect(routed).toBeDefined();
    expect(routed!.payload).toContain("reason=segment");
  });

  it("does not route an ordinary retail message", async () => {
    await setup();
    expect((await buy()).vip).toBeNull();
  });
});

describe("auto-dispatched purchase orders", () => {
  /** Drop a variant to just above the reorder point so one sale crosses it. */
  async function nearlyOut(target = 8) {
    await setup();
    const variant = await variantOf("L", "Olive");
    await prisma.variant.update({ where: { id: variant.id }, data: { stock: target, reserved: 0 } });
    return variant;
  }

  // PRD §5: "auto-dispatches POs when reserved inventory drops below
  // threshold" — a row somebody can count and send, not a sentence in a log.
  it("raises a draft purchase order when a sale crosses the reorder point", async () => {
    const variant = await nearlyOut(8);
    await buy("I want 2 olive L polos");

    const po = await prisma.purchaseOrder.findFirstOrThrow({ where: { workspaceId } });
    expect(po.variantId).toBe(variant.id);
    expect(po.status).toBe("draft");
    expect(po.reason).toContain("reorder point");
    expect(po.expectedOn.getTime()).toBeGreaterThan(Date.now());

    const events = await prisma.twinEvent.findMany();
    expect(events.map((e) => e.type)).toContain("supply_twin.po_raised");
  });

  // Ordering below a supplier's minimum is an order they refuse.
  it("orders at least the supplier's MOQ", async () => {
    await nearlyOut(8);
    await buy("I want 2 olive L polos");

    const po = await prisma.purchaseOrder.findFirstOrThrow({ where: { workspaceId } });
    const supplier = await prisma.supplier.findFirstOrThrow({ where: { id: po.supplierId } });
    expect(po.qty).toBeGreaterThanOrEqual(supplier.moq);
  });

  // The reorder point is crossed again by every subsequent message until stock
  // arrives. One decision, one purchase order.
  it("does not raise a second purchase order while one is open", async () => {
    await nearlyOut(8);
    await buy("I want 2 olive L polos");
    await buy("I want 1 olive L polo", "+91 90 000 0002");

    expect(await prisma.purchaseOrder.count({ where: { workspaceId } })).toBe(1);

    const runs = await prisma.agentRun.findMany({ where: { agent: "Procurement" } });
    expect(runs.some((run) => run.action.includes("already open"))).toBe(true);
  });

  it("raises none when stock stays well above the reorder point", async () => {
    await setup();
    await buy("I want 2 olive L polos");
    expect(await prisma.purchaseOrder.count({ where: { workspaceId } })).toBe(0);
  });
});

describe("the completed order state machine", () => {
  async function anOrder() {
    await setup();
    const result = await buy();
    return { id: result.order!.id, agent: await signedIn() };
  }

  // PRD §5: Inquiry -> Quote -> Confirmed -> Paid -> Packed -> Shipped.
  it("walks the PRD's chain one step at a time", async () => {
    const { id, agent } = await anOrder();

    for (const stage of ["Confirmed", "Paid", "Packed", "Shipped", "Delivered"]) {
      await agent.post(`/v1/orders/${id}/stage`).send({ stage }).expect(200);
    }

    const order = await prisma.order.findFirstOrThrow({ where: { id } });
    expect(order.stage).toBe("Delivered");
  });

  it("refuses to skip Confirmed", async () => {
    const { id, agent } = await anOrder();
    const res = await agent.post(`/v1/orders/${id}/stage`).send({ stage: "Paid" }).expect(409);
    expect(res.body.error).toContain("Quoted moves to Confirmed next");
  });

  it("still refuses to go backwards", async () => {
    const { id, agent } = await anOrder();
    await agent.post(`/v1/orders/${id}/stage`).send({ stage: "Confirmed" }).expect(200);
    await agent.post(`/v1/orders/${id}/stage`).send({ stage: "Quoted" }).expect(409);
  });

  it("releases the hold when an order is returned before it ever shipped", async () => {
    const { id, agent } = await anOrder();
    await agent.post(`/v1/orders/${id}/stage`).send({ stage: "Returned" }).expect(200);

    const order = await prisma.order.findFirstOrThrow({ where: { id } });
    expect(order.reservedUntil).toBeNull();
    expect((await variantOf("L", "Olive")).reserved).toBe(0);
  });
});
