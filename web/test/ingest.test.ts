import { beforeEach, describe, expect, it } from "vitest";
import { createUser, createWorkspace, resetDatabase } from "./helpers";
import { prisma } from "@/server/lib/prisma";
import { ingest } from "@/server/services/ingest";

let workspaceId: string;

async function setup(policy: "everything" | "money_only" | "nothing" = "money_only", vertical: "apparel" | "auto_parts" = "apparel") {
  const { user } = await createUser();
  const workspace = await createWorkspace({ userId: user.id, policy, vertical });
  workspaceId = workspace.id;
  return workspace;
}

const say = (text: string, handle = "+91 90 000 0001") =>
  ingest({ workspaceId, channel: "whatsapp", handle, text });

const stockOf = async (optionA: string, optionB: string) =>
  prisma.variant.findFirstOrThrow({
    where: { optionA, optionB, product: { workspaceId, name: "Polo Classic" } },
  });

beforeEach(async () => { await resetDatabase(); });

describe("the customer twin", () => {
  it("is created on a first message and reused after", async () => {
    await setup();
    const first = await say("hello");
    const second = await say("hello again");

    expect(first.customer.isNew).toBe(true);
    expect(second.customer.isNew).toBe(false);
    expect(second.customer.id).toBe(first.customer.id);
  });

  it("learns a stated option onto the size profile", async () => {
    await setup();
    await say("do you have XL polos");

    const customer = await prisma.customer.findFirstOrThrow({ where: { workspaceId } });
    expect(customer.sizeProfile).toContain("size: XL");
  });

  it("promotes a bulk buyer to wholesale", async () => {
    await setup();
    await say("I need 200 polos");

    const customer = await prisma.customer.findFirstOrThrow({ where: { workspaceId } });
    expect(customer.segment).toBe("Wholesale");
  });
});

describe("reserving stock", () => {
  it("reserves what it promises", async () => {
    await setup();
    const before = await stockOf("L", "Olive");
    const result = await say("I want 3 olive L polos");
    const after = await stockOf("L", "Olive");

    expect(result.order).not.toBeNull();
    expect(after.reserved).toBe(before.reserved + 3);
  });

  it("prices the order from the catalogue", async () => {
    await setup();
    const result = await say("I want 2 olive L polos");
    expect(result.order?.valueInr).toBe(1196 * 2);
  });

  // The whole thesis: never promise stock that is not there.
  it("refuses to promise stock it does not have", async () => {
    await setup();
    // XL cobalt has 4 units in the catalogue.
    const result = await say("I need 40 cobalt XL polos");

    expect(result.order).toBeNull();
    expect(result.reply).toMatch(/not|out of stock|lead time/i);
    const variant = await stockOf("XL", "Cobalt");
    expect(variant.reserved).toBe(0);
  });

  // Reserving a guessed variant would promise the wrong thing.
  it("asks which variant rather than guessing", async () => {
    await setup();
    const result = await say("I want 3 polos");

    expect(result.order).toBeNull();
    expect(result.reply).toMatch(/which/i);
  });
});

// C-1 regression: a purchase order previously fell through every branch and
// was silently discarded. It must now create an order, reserve stock exactly
// like a precise buy, and force mandatory approval regardless of the
// workspace's approval policy.
describe("purchase orders (C-1)", () => {
  it("creates an order and reserves stock from a PO message, exactly as the audit reproduced it", async () => {
    await setup("nothing"); // even the most permissive policy must still hold a PO
    const before = await stockOf("L", "Olive");
    const result = await say("PO for 5 olive L polos, net 30");
    const after = await stockOf("L", "Olive");

    expect(result.extracted.intent).toBe("purchase_order");
    expect(result.order).not.toBeNull();
    expect(after.reserved).toBe(before.reserved + 5);
  });

  it("always holds a purchase order for approval, even under policy 'nothing'", async () => {
    await setup("nothing");
    const result = await say("PO for 2 olive L polos, net 30");

    expect(result.order).not.toBeNull();
    expect(result.agentRuns.find((r) => r.agent === "Sales")?.status).toBe("needs_approval");
  });

  it("refuses to promise PO stock it does not have", async () => {
    await setup();
    const result = await say("PO for 40 cobalt XL polos, net 30");

    expect(result.order).toBeNull();
    const variant = await stockOf("XL", "Cobalt");
    expect(variant.reserved).toBe(0);
  });

  it("asks which variant for an imprecise PO rather than guessing", async () => {
    await setup();
    const result = await say("raising a purchase order for 3 polos");

    expect(result.order).toBeNull();
    expect(result.reply).toMatch(/which/i);
  });

  it("routes a PO with no product at all to a human instead of a generic reply", async () => {
    await setup();
    const result = await say("attaching PO #4471, net 30");

    expect(result.order).toBeNull();
    expect(result.agentRuns.some((r) => r.status === "needs_approval")).toBe(true);
    expect(result.reply).not.toMatch(/got it\. let me look into that/i);
  });

  it("answers a product-level question with what it has", async () => {
    await setup();
    const result = await say("is the linen shirt in stock");
    expect(result.reply).toMatch(/in stock across|out of stock/i);
  });
});

describe("the approval policy", () => {
  it("holds every reply under 'everything'", async () => {
    await setup("everything");
    const result = await say("I want 2 olive L polos");

    expect(result.replySent).toBe(false);
    expect(result.agentRuns.every((r) => r.status === "needs_approval")).toBe(true);
  });

  it("holds only money under 'money_only'", async () => {
    await setup("money_only");
    const result = await say("I want 2 olive L polos");

    expect(result.replySent).toBe(true);
    expect(result.agentRuns.find((r) => r.agent === "Sales")?.status).toBe("needs_approval");
    expect(result.agentRuns.find((r) => r.agent === "Inventory")?.status).toBe("done");
  });

  it("lets everything through under 'nothing'", async () => {
    await setup("nothing");
    const result = await say("I want 2 olive L polos");

    expect(result.replySent).toBe(true);
    expect(result.agentRuns.every((r) => r.status === "done")).toBe(true);
  });
});

describe("grounding", () => {
  it("answers from taught knowledge and says which entry", async () => {
    await setup();
    const result = await say("what is your returns policy for unworn items");

    expect(result.knowledgeUsed?.title).toBe("Returns window");
    expect(result.reply).toContain("14 days");
  });

  it("speaks in the workspace voice", async () => {
    const workspace = await setup();
    await prisma.twinVoice.update({
      where: { workspaceId: workspace.id },
      data: { formality: "formal", length: "terse", signOff: "— Acme" },
    });

    const result = await say("I want 2 olive L polos");
    expect(result.reply).not.toContain("Hi!");
    expect(result.reply.endsWith("— Acme")).toBe(true);
  });

  it("uses the trade's own vocabulary", async () => {
    await setup("money_only", "auto_parts");
    const result = await say("do you have genuine brake pads for a swift");

    expect(result.matched?.variant).toBe("Swift 2018-24 / OEM");
  });
});

describe("the event trail", () => {
  it("records every mutation the message caused", async () => {
    await setup();
    await say("I want 2 olive L polos");

    const types = (await prisma.twinEvent.findMany({ where: { workspaceId } })).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining([
      "message.received", "intent.extracted", "product_twin.matched",
      "inventory_twin.reserved", "order_twin.created",
    ]));
  });

  // One message must not half-apply: no order without its reservation.
  it("leaves nothing behind when the message changes nothing", async () => {
    await setup();
    await say("hello there");

    const orders = await prisma.order.count({ where: { workspaceId } });
    expect(orders).toBe(0);
  });
});

describe("training evaluation", () => {
  it("runs the production path without changing operational data", async () => {
    await setup();
    const before = await stockOf("L", "Olive");

    const result = await ingest(
      { workspaceId, channel: "webchat", handle: "training@test.local", text: "I want 2 olive L polos" },
      { dryRun: true },
    );

    expect(result.order).not.toBeNull();
    expect((await stockOf("L", "Olive")).reserved).toBe(before.reserved);
    expect(await prisma.customer.count({ where: { workspaceId, handle: "training@test.local" } })).toBe(0);
    expect(await prisma.order.count({ where: { workspaceId } })).toBe(0);
    expect(await prisma.agentRun.count({ where: { workspaceId } })).toBe(0);
  });
});
