import { beforeEach, describe, expect, it } from "vitest";
import { agent, createUser, createWorkspace, resetDatabase, signedIn } from "./helpers";
import { prisma } from "@/server/lib/prisma";
import { ingest } from "@/server/services/ingest";

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

/**
 * An API key is the second way a request names a tenant, so invariant 5 has to
 * hold for it on its own terms: the key *is* the workspace, and no header,
 * cookie or id the caller sends may move it somewhere else.
 */
describe("workspace isolation under an API key", () => {
  /** Mints a key for `email`'s workspace and returns the secret. */
  async function keyFor(email: string) {
    const a = await signedIn(email);
    const res = await a.post("/v1/api-keys").send({ name: "Integration", scopes: ["write"] }).expect(201);
    return res.body.secret as string;
  }

  it("reads only the workspace the key was minted in", async () => {
    const { user: mine } = await createUser("mine@test.local");
    const { user: theirs } = await createUser("theirs@test.local");
    await createWorkspace({ userId: mine.id, name: "Mine" });
    await createWorkspace({ userId: theirs.id, name: "Theirs", vertical: "marine" });

    const secret = await keyFor("mine@test.local");
    const res = await agent().get("/v1/products").set("authorization", `Bearer ${secret}`).expect(200);

    expect(res.body.products).toHaveLength(4);
    expect(res.body.products.every((p: { category: string }) => p.category !== "Vessel")).toBe(true);
  });

  // The header may restate the key's workspace and nothing else. Letting it
  // choose would be the client-supplied tenant the whole choke point refuses.
  it("refuses a header naming another workspace", async () => {
    const { user: mine } = await createUser("mine@test.local");
    const { user: theirs } = await createUser("theirs@test.local");
    const ours = await createWorkspace({ userId: mine.id, name: "Mine" });
    const other = await createWorkspace({ userId: theirs.id, name: "Theirs" });

    const secret = await keyFor("mine@test.local");

    await agent()
      .get("/v1/customers")
      .set("authorization", `Bearer ${secret}`)
      .set("x-workspace-id", other.id)
      .expect(403);

    await agent()
      .get("/v1/customers")
      .set("authorization", `Bearer ${secret}`)
      .set("x-workspace-id", ours.id)
      .expect(200);
  });

  it("writes only into the workspace the key was minted in", async () => {
    const { user: mine } = await createUser("mine@test.local");
    const { user: theirs } = await createUser("theirs@test.local");
    const ours = await createWorkspace({ userId: mine.id, name: "Mine" });
    const other = await createWorkspace({ userId: theirs.id, name: "Theirs" });

    const secret = await keyFor("mine@test.local");
    await agent()
      .post("/v1/twin/knowledge")
      .set("authorization", `Bearer ${secret}`)
      .send({ kind: "faq", title: "Returns", body: "Thirty days, unworn." })
      .expect(201);

    const landed = await prisma.knowledgeEntry.findMany({ where: { title: "Returns" } });
    expect(landed.map((e) => e.workspaceId)).toEqual([ours.id]);
    expect(landed.some((e) => e.workspaceId === other.id)).toBe(false);
  });

  // A row id is not a capability. Knowing another tenant's conversation id
  // gets a key the same answer as knowing nothing.
  it("cannot reach another workspace's conversation", async () => {
    const { user: mine } = await createUser("mine@test.local");
    const { user: theirs } = await createUser("theirs@test.local");
    await createWorkspace({ userId: mine.id, name: "Mine" });
    const other = await createWorkspace({ userId: theirs.id, name: "Theirs" });

    await ingest({ workspaceId: other.id, channel: "whatsapp", handle: "+919812340000", text: "hello" });
    const conversation = await prisma.conversation.findFirstOrThrow({ where: { workspaceId: other.id } });

    const secret = await keyFor("mine@test.local");
    await agent()
      .get(`/v1/conversations/${conversation.id}`)
      .set("authorization", `Bearer ${secret}`)
      .expect(404);
  });

  // Two tenants, two keys, one process: the bucket, the row and the scope all
  // have to be per key or one workspace's integration can spend another's.
  it("keeps two workspaces' keys apart", async () => {
    const { user: mine } = await createUser("mine@test.local");
    const { user: theirs } = await createUser("theirs@test.local");
    const ours = await createWorkspace({ userId: mine.id, name: "Mine" });
    const other = await createWorkspace({ userId: theirs.id, name: "Theirs" });

    const oursSecret = await keyFor("mine@test.local");
    const theirsSecret = await keyFor("theirs@test.local");

    const a = await signedIn("mine@test.local");
    const listed = await a.get("/v1/api-keys").expect(200);
    expect(listed.body.keys).toHaveLength(1);

    const stored = await prisma.apiKey.findMany({ orderBy: { createdAt: "asc" } });
    expect(stored.map((k) => k.workspaceId).sort()).toEqual([ours.id, other.id].sort());
    expect(oursSecret).not.toBe(theirsSecret);
  });

  it("refuses to revoke another workspace's key", async () => {
    const { user: mine } = await createUser("mine@test.local");
    const { user: theirs } = await createUser("theirs@test.local");
    await createWorkspace({ userId: mine.id, name: "Mine" });
    await createWorkspace({ userId: theirs.id, name: "Theirs" });

    await keyFor("theirs@test.local");
    const victim = await prisma.apiKey.findFirstOrThrow();

    const a = await signedIn("mine@test.local");
    await a.delete(`/v1/api-keys/${victim.id}`).expect(404);

    expect((await prisma.apiKey.findUniqueOrThrow({ where: { id: victim.id } })).revokedAt).toBeNull();
  });
});
