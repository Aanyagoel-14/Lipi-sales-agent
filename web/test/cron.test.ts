import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agent, createUser, createWorkspace, resetDatabase } from "./helpers";
import { env } from "@/server/env";
import { prisma } from "@/server/lib/prisma";

const SECRET = "cron-secret-for-the-suite-0123456789";
const configured = env.CRON_SECRET;

beforeEach(async () => {
  await resetDatabase();
  env.CRON_SECRET = SECRET;
});
afterEach(() => { env.CRON_SECRET = configured; });

const tick = (authorization?: string) => {
  const req = agent().post("/v1/cron/tick");
  return authorization ? req.set("Authorization", authorization) : req;
};

describe("the scheduled tick", () => {
  it("refuses a caller without the deployment's secret", async () => {
    await tick().expect(401);
    await tick("Bearer not-the-secret").expect(401);
  });

  it("refuses to run when no secret is configured", async () => {
    env.CRON_SECRET = undefined;
    await tick(`Bearer ${SECRET}`).expect(503);
  });

  // The hold lapsed hours ago, but nobody opened the Orders page, so the
  // stock stayed reserved and the twin kept saying it was gone.
  it("releases a lapsed hold in a workspace nobody is looking at", async () => {
    const { user } = await createUser();
    const workspace = await createWorkspace({ userId: user.id });
    const variant = await prisma.variant.findFirstOrThrow({ where: { product: { workspaceId: workspace.id } }, include: { product: true } });
    const customer = await prisma.customer.create({
      data: {
        id: "cus_cron", workspaceId: workspace.id, name: "Buyer", handle: "+910000000001", channel: "whatsapp",
        segment: "Corporate", lifetimeValue: 0, orderCount: 0, avgOrderValue: 0, returnRatePct: 0,
        priceSensitivity: "Medium", negotiationStyle: "Unknown", sizeProfile: [], predictedNext: "Unknown",
        riskScore: 20, lastSeenAt: new Date(),
      },
    });
    await prisma.variant.update({ where: { id: variant.id }, data: { reserved: { increment: 3 } } });
    await prisma.order.create({
      data: {
        id: "ord_cron", workspaceId: workspace.id, variant: `${variant.optionA} / ${variant.optionB}`, qty: 3,
        value: variant.product.price * 3, stage: "Quoted", channel: "whatsapp", createdAt: new Date(),
        customerId: customer.id, productId: variant.productId, variantId: variant.id,
        reservedUntil: new Date(Date.now() - 60_000),
      },
    });

    const res = await tick(`Bearer ${SECRET}`).expect(200);

    expect(res.body).toMatchObject({ workspaces: 1, released: 1, failed: [] });
    const after = await prisma.variant.findUniqueOrThrow({ where: { id: variant.id } });
    expect(after.reserved).toBe(variant.reserved);
  });
});
