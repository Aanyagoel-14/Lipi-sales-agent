import { beforeEach, describe, expect, it } from "vitest";
import { agent, resetDatabase } from "./helpers";
import { prisma } from "@/server/lib/prisma";

beforeEach(resetDatabase);

describe("workspace onboarding", () => {
  it("keeps a no-data signup genuinely empty", async () => {
    const a = agent();
    await a.post("/v1/auth/signup").send({ name: "New Owner", email: "new@test.local", password: "longenough123" }).expect(201);
    const res = await a.post("/v1/workspaces").send({
      name: "New Business", vertical: "apparel", channels: ["whatsapp"],
      approvalPolicy: "everything", seedCatalogue: false,
    }).expect(201);

    expect(res.body.provisioned).toEqual({ products: 0, variants: 0, customers: 0, orders: 0, knowledge: 0, examples: 0 });
    expect(await prisma.conversation.count({ where: { workspaceId: res.body.workspace.id } })).toBe(0);
    expect(await prisma.invoice.count({ where: { workspaceId: res.body.workspace.id } })).toBe(0);
  });

  it("sample catalogue never fabricates business activity", async () => {
    const a = agent();
    await a.post("/v1/auth/signup").send({ name: "New Owner", email: "sample@test.local", password: "longenough123" }).expect(201);
    const res = await a.post("/v1/workspaces").send({
      name: "Sample Business", vertical: "apparel", channels: ["whatsapp"],
      approvalPolicy: "everything", seedCatalogue: true,
    }).expect(201);

    expect(res.body.provisioned.products).toBeGreaterThan(0);
    expect(res.body.provisioned.customers).toBe(0);
    expect(res.body.provisioned.orders).toBe(0);
    expect(await prisma.conversation.count({ where: { workspaceId: res.body.workspace.id } })).toBe(0);
  });
});
