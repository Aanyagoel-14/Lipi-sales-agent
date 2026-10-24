import { beforeEach, describe, expect, it } from "vitest";
import { createUser, createWorkspace, resetDatabase } from "./helpers";
import { prisma } from "@/server/lib/prisma";
import { isAffirmation } from "@/server/services/ingest";
import { sell } from "@/server/services/selling";

/**
 * The turn after the twin asks a question.
 *
 * Extraction reads one message on its own, and "Yes, please send." on its
 * own says nothing — live, it was read as `other` and answered with "let me
 * look into that" by a twin that had just offered the invoice. These pin
 * the repair: the offer is recorded when it is made, a yes to it is the
 * sale it offered, and "any update on my order?" is answered from the
 * order rather than triaged.
 */

let workspaceId: string;

beforeEach(async () => {
  await resetDatabase();
  const { user } = await createUser();
  workspaceId = (await createWorkspace({ userId: user.id, policy: "nothing" })).id;
});

const say = (text: string, handle = "555") => sell({ workspaceId, channel: "telegram", handle, text });
const orders = () => prisma.order.findMany({ where: { workspaceId }, orderBy: { createdAt: "asc" } });
const events = (type: string) => prisma.twinEvent.findMany({ where: { workspaceId, type }, orderBy: { occurredAt: "asc" } });
const variant = () =>
  prisma.variant.findFirstOrThrow({ where: { optionA: "L", optionB: "Olive", product: { workspaceId, name: "Polo Classic" } } });

describe("saying yes", () => {
  it("is recognised in the ways people say it, and nothing else", () => {
    for (const yes of ["Yes, please send.", "yes", "ok", "Okay go ahead", "sure, send the link", "Please send it", "sounds good!", "haan ji", "Done", "yes please"]) {
      expect(isAffirmation(yes), yes).toBe(true);
    }
    for (const no of ["No thanks", "yes but not today", "not now", "Do you have it in blue?", "yes, cancel that", "ok wait", "Yes I would like to know more about the fabric and the delivery times please", "later"]) {
      expect(isAffirmation(no), no).toBe(false);
    }
  });
});

describe("a yes to the twin's offer", () => {
  it("is the sale that was offered: the product, the variant and the quantity, invoiced with a link", async () => {
    const before = await variant();
    const asked = await say("Do you have 2 olive L polos?");

    expect(asked.intent).toBe("inventory_request");
    expect(asked.reply).toContain("left in L / Olive");
    expect(asked.reply).toContain("Shall I send you the invoice and a payment link?");
    expect(asked.order).toBeNull();
    expect(await events("offer.made")).toMatchObject([{ payload: expect.stringMatching(/^customer=\S+ product=\S+ variant=\S+ qty=2$/) }]);

    const yes = await say("Yes, please send.");

    expect(yes.intent).toBe("buy");
    expect(yes.order).not.toBeNull();
    expect(await orders()).toMatchObject([{ qty: 2, variant: "L / Olive", stage: "Quoted", channel: "telegram" }]);
    expect(yes.invoice).not.toBeNull();
    expect(yes.reply).toContain(`Your invoice and payment link: ${yes.invoice!.link}`);
    expect(yes.reply).not.toContain("Let me look into that");
    expect(await events("offer.accepted")).toHaveLength(1);
    // Quoted, not reserved: the stock is theirs when they pay.
    expect((await variant()).reserved).toBe(before.reserved);
  });

  it("takes a quantity said with the yes over the one offered", async () => {
    await say("Do you have 2 olive L polos?");
    await say("Yes, make it 3");
    expect(await orders()).toMatchObject([{ qty: 3, variant: "L / Olive" }]);
  });

  it("accepts the smaller quantity the twin offered when there was a shortfall", async () => {
    const v = await variant();
    await prisma.variant.update({ where: { id: v.id }, data: { stock: 1, reserved: 0 } });

    const short = await say("I want 2 olive L polos");
    expect(short.reply).toContain("Would 1 do for now?");
    expect(short.order).toBeNull();

    const ok = await say("ok");
    expect(ok.order).not.toBeNull();
    expect(await orders()).toMatchObject([{ qty: 1, variant: "L / Olive" }]);
  });

  it("is taken once: a second yes raises no second order", async () => {
    await say("Do you have 2 olive L polos?");
    await say("Yes, please send.");
    const again = await say("yes");

    expect(again.order).toBeNull();
    expect(await orders()).toHaveLength(1);
  });

  it("means nothing when nothing was offered", async () => {
    const yes = await say("yes");
    expect(yes.order).toBeNull();
    expect(await orders()).toHaveLength(0);
    expect(yes.reply).toContain("Let me look into that");
  });

  it("is not a no", async () => {
    await say("Do you have 2 olive L polos?");
    const no = await say("No thanks");
    expect(no.order).toBeNull();
    expect(await orders()).toHaveLength(0);
  });

  it("answers only this customer's offer", async () => {
    await say("Do you have 2 olive L polos?", "555");
    const other = await say("Yes, please send.", "556");
    expect(other.order).toBeNull();
    expect(await orders()).toHaveLength(0);
  });

  it("lapses after two days", async () => {
    const v = await variant();
    const customer = await say("hello").then((r) => r.customer);
    await prisma.twinEvent.create({
      data: {
        id: "evt_old_offer", workspaceId, twin: "order", type: "offer.made",
        occurredAt: new Date(Date.now() - 3 * 24 * 60 * 60_000),
        payload: `customer=${customer.id} product=${v.productId} variant=${v.id} qty=2`,
      },
    });

    const yes = await say("yes");
    expect(yes.order).toBeNull();
    expect(await orders()).toHaveLength(0);
  });
});

describe("asking where an order is", () => {
  it("is answered from the order, with the link back when it is still unpaid", async () => {
    await say("Do you have 2 olive L polos?");
    const yes = await say("Yes, please send.");

    const update = await say("Any update on this order?");

    expect(update.order).toBeNull();
    expect(update.reply).toContain(`Your order ${yes.order!.id}`);
    expect(update.reply).toContain("is waiting for payment");
    expect(update.reply).toContain(`Your invoice and payment link: ${yes.invoice!.link}`);
    expect(await orders()).toHaveLength(1);
    expect(await events("order_twin.status_asked")).toHaveLength(1);
  });

  it("says what stage it is at once it is paid, without a link to pay again", async () => {
    await say("I want 2 olive L polos");
    const [order] = await orders();
    await prisma.order.update({ where: { id: order!.id }, data: { stage: "Paid" } });

    const update = await say("where is my order?");

    expect(update.reply).toContain("is paid and being packed");
    expect(update.reply).not.toContain("/i/");
    expect(update.invoice).toBeNull();
  });

  it("says so when a paid order is held up on stock", async () => {
    await say("I want 2 olive L polos");
    const [order] = await orders();
    await prisma.order.update({ where: { id: order!.id }, data: { stage: "Paid", blocked: "Paid, but sold out — refund or restock" } });

    const update = await say("any update?");
    expect(update.reply).toContain("sorting out a stock issue");
  });

  it("has nothing to say about an order that does not exist", async () => {
    const update = await say("Any update on this order?");
    expect(update.order).toBeNull();
    expect(await events("order_twin.status_asked")).toHaveLength(0);
  });
});
