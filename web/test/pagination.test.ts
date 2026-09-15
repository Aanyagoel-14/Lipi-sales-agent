import { beforeEach, describe, expect, it } from "vitest";
import { createUser, createWorkspace, resetDatabase, signedIn } from "./helpers";
import { prisma } from "@/server/lib/prisma";

beforeEach(resetDatabase);

/** N events, one second apart, so the ordering is unambiguous. */
async function seedEvents(workspaceId: string, count: number) {
  const base = Date.UTC(2026, 0, 1);
  await prisma.twinEvent.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      id: `evt_${String(i).padStart(4, "0")}`,
      workspaceId,
      occurredAt: new Date(base + i * 1000),
      type: "test.event",
      twin: "conversation",
      payload: `n=${i}`,
    })),
  });
}

describe("cursor pagination", () => {
  it("caps a page and hands back a cursor for the rest", async () => {
    const { user } = await createUser();
    const workspace = await createWorkspace({ userId: user.id, withCatalogue: false });
    await seedEvents(workspace.id, 120);

    const a = await signedIn();

    const first = await a.get("/v1/events?limit=50").expect(200);
    expect(first.body.events).toHaveLength(50);
    expect(first.body.nextCursor).toBeTypeOf("string");

    const second = await a.get(`/v1/events?limit=50&cursor=${first.body.nextCursor}`).expect(200);
    expect(second.body.events).toHaveLength(50);

    const third = await a.get(`/v1/events?limit=50&cursor=${second.body.nextCursor}`).expect(200);
    expect(third.body.events).toHaveLength(20);
    // The last page says so, rather than handing back a cursor to nothing.
    expect(third.body.nextCursor).toBeNull();
  });

  it("walks every row exactly once", async () => {
    const { user } = await createUser();
    const workspace = await createWorkspace({ userId: user.id, withCatalogue: false });
    await seedEvents(workspace.id, 57);

    const a = await signedIn();
    const seen: string[] = [];
    let cursor: string | null = null;

    do {
      const res = await a.get(`/v1/events?limit=10${cursor ? `&cursor=${cursor}` : ""}`).expect(200);
      seen.push(...res.body.events.map((e: { id: string }) => e.id));
      cursor = res.body.nextCursor;
    } while (cursor);

    expect(seen).toHaveLength(57);
    expect(new Set(seen).size).toBe(57);
  });

  it("defaults to a bounded page rather than the whole table", async () => {
    const { user } = await createUser();
    const workspace = await createWorkspace({ userId: user.id, withCatalogue: false });
    await seedEvents(workspace.id, 300);

    const a = await signedIn();
    const res = await a.get("/v1/events").expect(200);

    expect(res.body.events).toHaveLength(50);
    expect(res.body.nextCursor).not.toBeNull();
  });

  it("rejects a limit outside the allowed range", async () => {
    const { user } = await createUser();
    await createWorkspace({ userId: user.id, withCatalogue: false });
    const a = await signedIn();

    await a.get("/v1/events?limit=0").expect(422);
    await a.get("/v1/events?limit=500").expect(422);
    await a.get("/v1/events?limit=abc").expect(422);
  });

  it("cannot be steered into another workspace, and drops no row of its own", async () => {
    const { user: mine } = await createUser("mine@test.local");
    const { user: theirs } = await createUser("theirs@test.local");
    const ours = await createWorkspace({ userId: mine.id, name: "Mine", withCatalogue: false });
    const other = await createWorkspace({ userId: theirs.id, name: "Theirs", withCatalogue: false });

    await seedEvents(ours.id, 5);
    // Dated after everything of ours, which is what made Prisma's own cursor
    // silently swallow one of our rows.
    await prisma.twinEvent.create({
      data: {
        id: "evt_theirs", workspaceId: other.id, occurredAt: new Date(Date.UTC(2027, 0, 1)),
        type: "test.event", twin: "conversation", payload: "not yours",
      },
    });

    const a = await signedIn("mine@test.local");
    const forged = Buffer.from(`${Date.UTC(2027, 0, 1)}.evt_theirs`, "utf8").toString("base64url");
    const res = await a.get(`/v1/events?cursor=${forged}`).expect(200);

    expect(res.body.events).toHaveLength(5);
    expect(res.body.events.every((e: { payload: string }) => e.payload !== "not yours")).toBe(true);
  });

  it("refuses a malformed cursor instead of guessing", async () => {
    const { user } = await createUser();
    await createWorkspace({ userId: user.id, withCatalogue: false });
    const a = await signedIn();

    await a.get("/v1/events?cursor=not-base64-at-all!!").expect(422);
    await a.get(`/v1/events?cursor=${Buffer.from("nodot", "utf8").toString("base64url")}`).expect(422);
    await a.get(`/v1/events?cursor=${Buffer.from("abc.evt_1", "utf8").toString("base64url")}`).expect(422);
  });
});

describe("conversation list weight", () => {
  it("carries a preview and a count instead of every message", async () => {
    const { user } = await createUser();
    await createWorkspace({ userId: user.id });
    const a = await signedIn();

    for (const text of ["need 3 olive L polos", "and 2 more", "any update?"]) {
      await a.post("/v1/messages").send({ channel: "whatsapp", handle: "+91 90 000 1234", text }).expect(201);
    }

    const list = await a.get("/v1/conversations").expect(200);
    const [row] = list.body.conversations;

    expect(row.messages).toBeUndefined();
    expect(row.lastMessage).not.toBeNull();
    expect(row.messageCount).toBeGreaterThan(0);

    const thread = await a.get(`/v1/conversations/${row.id}`).expect(200);
    expect(thread.body.conversation.messages.length).toBe(row.messageCount);
    // The preview really is the newest message in the thread.
    expect(thread.body.conversation.messages.at(-1).text).toBe(row.lastMessage.text);
  });

  it("refuses a thread in another workspace", async () => {
    const { user: mine } = await createUser("mine@test.local");
    const { user: theirs } = await createUser("theirs@test.local");
    await createWorkspace({ userId: mine.id, name: "Mine" });
    await createWorkspace({ userId: theirs.id, name: "Theirs" });

    const b = await signedIn("theirs@test.local");
    await b.post("/v1/messages").send({ channel: "whatsapp", handle: "+91 90 000 9999", text: "hello" }).expect(201);
    const theirList = await b.get("/v1/conversations").expect(200);
    const theirThread = theirList.body.conversations[0].id;

    const a = await signedIn("mine@test.local");
    await a.get(`/v1/conversations/${theirThread}`).expect(404);
  });
});

describe("orders pagination", () => {
  it("pages orders newest first without repeating a row", async () => {
    const { user } = await createUser();
    const workspace = await createWorkspace({ userId: user.id });
    const a = await signedIn();

    const customer = await prisma.customer.create({
      data: {
        id: "cus_page", workspaceId: workspace.id, name: "Pager", handle: "+91 90 000 0001",
        channel: "whatsapp", segment: "Retail", lifetimeValue: 0, orderCount: 0, avgOrderValue: 0,
        returnRatePct: 0, priceSensitivity: "Medium", negotiationStyle: "Unknown",
        sizeProfile: [], predictedNext: "Unknown", riskScore: 20, lastSeenAt: new Date(),
      },
    });
    const product = await prisma.product.findFirstOrThrow({ where: { workspaceId: workspace.id } });
    const variant = await prisma.variant.findFirstOrThrow({ where: { productId: product.id } });

    const base = Date.UTC(2026, 0, 1);
    await prisma.order.createMany({
      data: Array.from({ length: 25 }, (_, i) => ({
        id: `ord_${String(i).padStart(3, "0")}`, workspaceId: workspace.id,
        variant: "L / Olive", qty: 1, value: 100_000, stage: "Quoted" as const,
        channel: "whatsapp" as const, createdAt: new Date(base + i * 1000),
        customerId: customer.id, productId: product.id, variantId: variant.id,
      })),
    });

    const first = await a.get("/v1/orders?limit=10").expect(200);
    expect(first.body.orders).toHaveLength(10);
    expect(first.body.orders[0].id).toBe("ord_024");

    const second = await a.get(`/v1/orders?limit=10&cursor=${first.body.nextCursor}`).expect(200);
    const ids = new Set([
      ...first.body.orders.map((o: { id: string }) => o.id),
      ...second.body.orders.map((o: { id: string }) => o.id),
    ]);
    expect(ids.size).toBe(20);
  });
});
