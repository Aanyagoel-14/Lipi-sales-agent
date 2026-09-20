import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUser, createWorkspace, resetDatabase } from "./helpers";
import { prisma } from "@/server/lib/prisma";
import { buildGrounding } from "@/server/services/briefing";
import { buildRecommendations } from "@/server/services/recommend";

/**
 * What the twin puts in front of a customer, and why it is never the model's
 * choice. Every candidate here is generated from stock and order history the
 * database can be asked about; the model only gets to word it.
 */

let workspaceId: string;

/** The two messages every case here turns on: one ask that is gone, one on the shelf. */
const wantsSoldOut = {
  text: "I need 2 XXL cobalt polos",
  intent: "buy",
  matched: { product: "Polo Classic", variant: "XXL / Cobalt" },
};
const wantsInStock = {
  text: "I need 2 M cobalt polos",
  intent: "buy",
  matched: { product: "Polo Classic", variant: "M / Cobalt" },
};

async function setup() {
  const { user } = await createUser();
  const workspace = await createWorkspace({ userId: user.id, policy: "nothing" });
  workspaceId = workspace.id;
  return workspace;
}

beforeEach(async () => { await resetDatabase(); });

/** A second product in an existing category, so a neighbour has something to be. */
async function addPolo(name: string, opts: { priceInr?: number; stock?: number } = {}) {
  const supplier = await prisma.supplier.findFirstOrThrow({ where: { workspaceId } });
  return prisma.product.create({
    data: {
      id: `prd_${name.toLowerCase().replace(/\W/g, "")}`, workspaceId, name, category: "Polo",
      axes: ["Size", "Colour"], price: (opts.priceInr ?? 1500) * 100, marginPct: 40, leadTimeDays: 5,
      crossSell: [], supplierId: supplier.id,
      variants: { create: [{ optionA: "L", optionB: "Cobalt", stock: opts.stock ?? 7, reserved: 0, sku: `${name}-L-COB` }] },
    },
  });
}

/** An order per product, all from one customer, so they co-occur. */
async function orderedTogether(tenant: string, who: string, productNames: string[]) {
  const customer = await prisma.customer.create({
    data: {
      id: `cus_${who}`, workspaceId: tenant, name: who, handle: `@${who}`, channel: "whatsapp",
      segment: "Retail", lifetimeValue: 0, orderCount: productNames.length, avgOrderValue: 0,
      returnRatePct: 0, priceSensitivity: "Medium", negotiationStyle: "Direct", sizeProfile: [],
      predictedNext: "Unknown", riskScore: 10, lastSeenAt: new Date(),
    },
  });

  for (const [i, name] of productNames.entries()) {
    const product = await prisma.product.findFirstOrThrow({
      where: { workspaceId: tenant, name }, include: { variants: true },
    });
    const variant = product.variants[0]!;
    await prisma.order.create({
      data: {
        id: `ord_${who}_${i}`, workspaceId: tenant, variant: `${variant.optionA} / ${variant.optionB}`,
        qty: 1, value: product.price, stage: "Delivered", channel: "whatsapp", createdAt: new Date(),
        customerId: customer.id, productId: product.id, variantId: variant.id,
      },
    });
  }
}

/** Nothing left of the Polo Classic at all, on any axis. */
async function emptyThePolos() {
  const variants = await prisma.variant.findMany({ where: { product: { workspaceId, name: "Polo Classic" } } });
  for (const v of variants) {
    await prisma.variant.update({ where: { id: v.id }, data: { stock: v.reserved } });
  }
}

describe("alternatives to something sold out", () => {
  it("offers an in-stock variant of the same product", async () => {
    await setup();
    // XXL / Cobalt is seeded at zero; the rest of the Cobalt run is not.
    const recommended = await buildRecommendations(workspaceId, wantsSoldOut);

    expect(recommended.soldOut).toEqual({ product: "Polo Classic", variant: "XXL / Cobalt" });

    const alternatives = recommended.items.filter((i) => i.kind === "alternative");
    expect(alternatives.length).toBeGreaterThan(0);
    expect(alternatives[0]!.product).toBe("Polo Classic");
    expect(alternatives.every((i) => i.available > 0)).toBe(true);
    // The price is the product's own, in rupees, read from its row.
    expect(alternatives[0]!.priceInr).toBe(1196);
  });

  it("offers several sizes of it, deepest stock first", async () => {
    await setup();

    const recommended = await buildRecommendations(workspaceId, wantsSoldOut);

    const variants = recommended.items.filter((i) => i.kind === "alternative").map((i) => i.variant);
    // Seeded Cobalt run: M 26, L 18, S 12, XL 4 — the three deepest, in order.
    expect(variants).toEqual(["M / Cobalt", "L / Cobalt", "S / Cobalt"]);
  });

  it("says there is nothing rather than inventing a substitute", async () => {
    await setup();
    await emptyThePolos();

    const recommended = await buildRecommendations(workspaceId, wantsSoldOut);

    expect(recommended.soldOut).toEqual({ product: "Polo Classic", variant: "XXL / Cobalt" });
    expect(recommended.items).toEqual([]);
  });

  it("never offers a neighbour that is itself out of stock", async () => {
    await setup();
    await emptyThePolos();
    await addPolo("Polo Sport", { stock: 0 });
    await addPolo("Polo Tour", { stock: 4 });

    const recommended = await buildRecommendations(workspaceId, wantsSoldOut);

    expect(recommended.items.map((i) => i.product)).toEqual(["Polo Tour"]);
  });

  it("recommends nothing when what they asked for is on the shelf", async () => {
    await setup();

    const recommended = await buildRecommendations(workspaceId, wantsInStock);

    expect(recommended.soldOut).toBeNull();
    expect(recommended.items.filter((i) => i.kind === "alternative")).toEqual([]);
  });
});

describe("cross-sell from what this workspace has actually sold", () => {
  it("names what its own customers bought alongside the matched product", async () => {
    await setup();
    await orderedTogether(workspaceId, "asha", ["Polo Classic", "Leather Belt"]);
    await orderedTogether(workspaceId, "bala", ["Polo Classic", "Leather Belt"]);
    await orderedTogether(workspaceId, "chandra", ["Polo Classic", "Linen Shirt"]);

    const recommended = await buildRecommendations(workspaceId, wantsInStock);

    const cross = recommended.items.filter((i) => i.kind === "cross_sell");
    // Counted, not guessed: the belt was bought alongside twice, the shirt once.
    expect(cross.map((i) => i.product)).toEqual(["Leather Belt", "Linen Shirt"]);
    expect(cross[0]!.priceInr).toBe(1450);
    expect(cross.every((i) => i.available > 0)).toBe(true);
  });

  it("never counts another workspace's orders (invariant 5)", async () => {
    await setup();
    const { user } = await createUser("other@test.local");
    const other = await createWorkspace({ userId: user.id, name: "Other Co" });
    // The other tenant sells the same catalogue and pairs polos with shirts.
    await orderedTogether(other.id, "dev", ["Polo Classic", "Linen Shirt"]);
    await orderedTogether(other.id, "eshan", ["Polo Classic", "Linen Shirt"]);
    // Ours has only ever paired them with belts.
    await orderedTogether(workspaceId, "asha", ["Polo Classic", "Leather Belt"]);

    const recommended = await buildRecommendations(workspaceId, wantsInStock);

    expect(recommended.items.filter((i) => i.kind === "cross_sell").map((i) => i.product)).toEqual(["Leather Belt"]);
  });

  it("does not cross-sell something it has run out of", async () => {
    await setup();
    await orderedTogether(workspaceId, "asha", ["Polo Classic", "Leather Belt"]);
    await prisma.variant.updateMany({
      where: { product: { workspaceId, name: "Leather Belt" } },
      data: { stock: 0, reserved: 0 },
    });

    const recommended = await buildRecommendations(workspaceId, wantsInStock);

    expect(recommended.items.filter((i) => i.kind === "cross_sell")).toEqual([]);
  });
});

describe("the step up", () => {
  it("offers the next tier up in the same category, at its real price", async () => {
    await setup();
    await addPolo("Polo Sport", { priceInr: 1500 });
    await addPolo("Polo Lux", { priceInr: 2500 });

    const recommended = await buildRecommendations(workspaceId, wantsInStock);

    const upsell = recommended.items.filter((i) => i.kind === "upsell");
    expect(upsell).toHaveLength(1);
    expect(upsell[0]!.product).toBe("Polo Sport");
    expect(upsell[0]!.priceInr).toBe(1500);
    expect(upsell[0]!.available).toBe(7);
  });

  it("skips a tier it cannot sell and offers the one above it", async () => {
    await setup();
    await addPolo("Polo Sport", { priceInr: 1500, stock: 0 });
    await addPolo("Polo Lux", { priceInr: 2500 });

    const recommended = await buildRecommendations(workspaceId, wantsInStock);

    expect(recommended.items.filter((i) => i.kind === "upsell").map((i) => i.product)).toEqual(["Polo Lux"]);
  });

  it("does not call something cheaper a step up", async () => {
    await setup();
    await addPolo("Polo Basic", { priceInr: 900 });

    const recommended = await buildRecommendations(workspaceId, wantsInStock);

    expect(recommended.items.filter((i) => i.kind === "upsell")).toEqual([]);
  });
});

describe("what it costs to recommend", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("reads the order log with a cap and a tenant filter, never the whole table", async () => {
    await setup();
    await orderedTogether(workspaceId, "asha", ["Polo Classic", "Leather Belt"]);

    const reads: { take?: number; workspaceId?: string }[] = [];
    const findMany = prisma.order.findMany.bind(prisma.order);
    vi.spyOn(prisma.order, "findMany").mockImplementation((args) => {
      const where = (args?.where ?? {}) as { workspaceId?: string };
      reads.push({ take: args?.take, workspaceId: where.workspaceId });
      return findMany(args) as ReturnType<typeof findMany>;
    });

    await buildRecommendations(workspaceId, wantsInStock);

    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) {
      expect(read.take, "an unbounded read of the order log").toBeTypeOf("number");
      expect(read.take!).toBeLessThanOrEqual(500);
      expect(read.workspaceId).toBe(workspaceId);
    }
  });

  it("builds the same recommendations twice from the same message", async () => {
    await setup();
    await addPolo("Polo Sport", { priceInr: 1500 });
    await orderedTogether(workspaceId, "asha", ["Polo Classic", "Leather Belt"]);

    const first = await buildRecommendations(workspaceId, wantsSoldOut);
    const second = await buildRecommendations(workspaceId, wantsSoldOut);

    expect(first).toEqual(second);
  });

  it("recommends nothing when nothing was matched", async () => {
    await setup();
    expect(await buildRecommendations(workspaceId, { text: "hello there" })).toEqual({ soldOut: null, items: [] });
  });
});

describe("the recommendations in the grounding block", () => {
  it("states each candidate with its own price and count", async () => {
    await setup();
    await addPolo("Polo Sport", { priceInr: 1500 });
    await orderedTogether(workspaceId, "asha", ["Polo Classic", "Leather Belt"]);

    const grounding = await buildGrounding(workspaceId, wantsSoldOut);

    expect(grounding.text).toContain("WHAT TO PUT IN FRONT OF THEM");
    expect(grounding.text).toContain("which is sold out: Polo Classic in M / Cobalt — ₹1,196 each, 26 available");
    expect(grounding.text).toContain("Leather Belt — ₹1,450 each");
    expect(grounding.text).toContain("A step up from the Polo Classic: Polo Sport");
    expect(grounding.recommendations.map((r) => r.kind)).toContain("upsell");
  });

  it("tells the model to say there is nothing rather than reach for something", async () => {
    await setup();
    await emptyThePolos();

    const grounding = await buildGrounding(workspaceId, wantsSoldOut);

    expect(grounding.text).toContain("Polo Classic XXL / Cobalt is sold out");
    expect(grounding.text).toContain("Say so plainly");
    expect(grounding.recommendations).toEqual([]);
  });

  it("carries no recommendation section when there is nothing to recommend", async () => {
    await setup();

    const { text } = await buildGrounding(workspaceId, { text: "what do you have?" });

    expect(text).not.toContain("WHAT TO PUT IN FRONT OF THEM");
  });
});
