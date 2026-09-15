import { beforeEach, describe, expect, it } from "vitest";
import { createUser, createWorkspace, resetDatabase, signedIn } from "./helpers";
import { prisma } from "@/server/lib/prisma";

beforeEach(resetDatabase);

describe("workspace isolation", () => {
  it("shows a workspace only its own rows", async () => {
    const { user: mine } = await createUser("mine@test.local");
    const { user: theirs } = await createUser("theirs@test.local");
    await createWorkspace({ userId: mine.id, name: "Mine" });
    await createWorkspace({ userId: theirs.id, name: "Theirs", vertical: "marine" });

    const a = await signedIn("mine@test.local");
    const res = await a.get("/v1/products").expect(200);

    expect(res.body.products).toHaveLength(4);
    expect(res.body.products.every((p: { category: string }) => p.category !== "Vessel")).toBe(true);
  });

  it("shares no row between two workspaces built from the same catalogue", async () => {
    const { user: a } = await createUser("a@test.local");
    const { user: b } = await createUser("b@test.local");
    const one = await createWorkspace({ userId: a.id, name: "One" });
    const two = await createWorkspace({ userId: b.id, name: "Two" });

    const [oneIds, twoIds] = await Promise.all([
      prisma.product.findMany({ where: { workspaceId: one.id }, select: { id: true } }),
      prisma.product.findMany({ where: { workspaceId: two.id }, select: { id: true } }),
    ]);

    const overlap = oneIds.filter((p) => twoIds.some((q) => q.id === p.id));
    expect(overlap).toHaveLength(0);
  });

  it("refuses a workspace the user does not belong to", async () => {
    const { user: mine } = await createUser("mine@test.local");
    const { user: theirs } = await createUser("theirs@test.local");
    await createWorkspace({ userId: mine.id, name: "Mine" });
    const other = await createWorkspace({ userId: theirs.id, name: "Theirs" });

    const a = await signedIn("mine@test.local");
    await a.get("/v1/customers").set("x-workspace-id", other.id).expect(403);
  });

  // A leftover cookie from a deleted workspace used to 403 every page, which
  // is not something a user can recover from on their own.
  it("ignores a stale workspace id rather than locking the user out", async () => {
    const { user } = await createUser();
    await createWorkspace({ userId: user.id });

    const a = await signedIn();
    await a.get("/v1/customers").set("x-workspace-id", "workspace-that-never-existed").expect(200);
  });

  it("refuses another workspace's order", async () => {
    const { user: mine } = await createUser("mine@test.local");
    const { user: theirs } = await createUser("theirs@test.local");
    await createWorkspace({ userId: mine.id, name: "Mine" });
    const other = await createWorkspace({ userId: theirs.id, name: "Theirs" });

    const otherProduct = await prisma.product.findFirstOrThrow({ where: { workspaceId: other.id } });
    const otherVariant = await prisma.variant.findFirstOrThrow({ where: { productId: otherProduct.id } });
    const order = await prisma.order.create({
      data: {
        id: "ord_other", workspaceId: other.id, variant: "M / Navy", qty: 1, value: 1000,
        stage: "Quoted", channel: "whatsapp", createdAt: new Date(),
        customerId: (await prisma.customer.create({
          data: {
            id: "cus_other", workspaceId: other.id, name: "X", handle: "x", channel: "whatsapp",
            segment: "Retail", lifetimeValue: 0, orderCount: 0, avgOrderValue: 0, returnRatePct: 0,
            priceSensitivity: "Low", negotiationStyle: "Direct", sizeProfile: [], predictedNext: "-",
            riskScore: 0, lastSeenAt: new Date(),
          },
        })).id,
        productId: otherProduct.id, variantId: otherVariant.id,
      },
    });

    const a = await signedIn("mine@test.local");
    await a.post(`/v1/orders/${order.id}/stage`).send({ stage: "Paid" }).expect(404);
  });
});
