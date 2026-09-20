import { beforeEach, describe, expect, it } from "vitest";
import { agent, createUser, createWorkspace, resetDatabase, signedIn } from "./helpers";
import { prisma } from "@/server/lib/prisma";
import { _resetRateLimitsForTests } from "@/server/lib/rate-limit";
import { responses } from "@/app/v1/contract";
import { endpoints, openapiDocument } from "@/app/v1/openapi";

/**
 * The public contract, exercised the way an integrator meets it: through an
 * API key, over HTTP, against the schemas the OpenAPI document publishes.
 *
 * `openapi.test.ts` proves the checked-in document is what the schemas
 * generate. This file proves the schemas are what the routes answer with —
 * a specification nobody validates a response against is a wish.
 */
beforeEach(resetDatabase);
beforeEach(_resetRateLimitsForTests);

/**
 * A client that presents a key and no cookie, the way a server-to-server
 * caller does. Write-scoped unless a case asks otherwise: the endpoints here
 * are the ones an integration both reads and writes.
 */
async function keyed(opts: { email?: string; scopes?: string[] } = {}) {
  const owner = await signedIn(opts.email ?? "owner@test.local");
  const res = await owner
    .post("/v1/api-keys")
    .send({ name: "Storefront", scopes: opts.scopes ?? ["read", "write"] })
    .expect(201);

  const secret = res.body.secret as string;
  const client = agent();
  const call = (method: "get" | "post" | "patch" | "delete") => (path: string) =>
    client[method](path).set("authorization", `Bearer ${secret}`);

  return { get: call("get"), post: call("post"), patch: call("patch"), delete: call("delete"), secret };
}

/** One customer, one thread and one order, so every read has something to return. */
async function seed(workspaceId: string) {
  const owner = await signedIn();
  await owner
    .post("/v1/messages")
    .send({ channel: "whatsapp", handle: "+91 90 000 1234", text: "need 3 olive L polos", name: "Asha" })
    .expect(201);

  const customer = await prisma.customer.findFirstOrThrow({ where: { workspaceId } });
  const product = await prisma.product.findFirstOrThrow({ where: { workspaceId } });
  const variant = await prisma.variant.findFirstOrThrow({ where: { productId: product.id } });

  await prisma.customer.update({
    where: { id: customer.id },
    data: {
      utmSource: "google", utmMedium: "cpc", utmCampaign: "diwali",
      adClickId: "gclid-1", landingPage: "https://shop.test/polos",
      firstTouchAt: new Date(Date.UTC(2026, 0, 1)),
    },
  });

  const order = await prisma.order.create({
    data: {
      id: "ord_seed", workspaceId, variant: "L / Olive", qty: 3, value: 449_900,
      stage: "Paid", channel: "whatsapp", createdAt: new Date(Date.UTC(2026, 1, 2)),
      customerId: customer.id, productId: product.id, variantId: variant.id,
    },
  });

  const conversation = await prisma.conversation.findFirstOrThrow({ where: { workspaceId } });
  return { customer, product, order, conversation };
}

/** The live path for a documented one: `/v1/customers/{id}` needs a real id. */
const concrete = (path: string, ids: Record<string, string>) =>
  path.replace(/\{(\w+)\}/g, (_match, name: string) => ids[name]!);

describe("the documented surface", () => {
  let ids: Record<string, string>;

  beforeEach(async () => {
    const { user } = await createUser();
    const workspace = await createWorkspace({ userId: user.id });
    const seeded = await seed(workspace.id);
    ids = { id: seeded.customer.id };
  });

  it("answers every documented GET with the shape the document publishes", async () => {
    const a = await keyed();

    for (const endpoint of endpoints.filter((e) => e.method === "get")) {
      // Each path's `{id}` is of its own kind, so it is resolved per endpoint
      // rather than from one shared map.
      const path = concrete(endpoint.path, await idsFor(endpoint.path));
      const res = await a.get(path);

      expect(res.status, `GET ${path} -> ${res.text.slice(0, 200)}`).toBe(endpoint.status);
      const parsed = endpoint.response.safeParse(res.body);
      expect(parsed.success, `GET ${path} does not match its schema: ${JSON.stringify(parsed.error?.issues)}`)
        .toBe(true);
    }
  });

  async function idsFor(path: string): Promise<Record<string, string>> {
    if (path.startsWith("/v1/customers")) return ids;
    if (path.startsWith("/v1/conversations")) {
      return { id: (await prisma.conversation.findFirstOrThrow()).id };
    }
    if (path.startsWith("/v1/products")) return { id: (await prisma.product.findFirstOrThrow()).id };
    return {};
  }

  it("serves the document itself without a credential", async () => {
    const res = await agent().get("/v1/openapi.json").expect(200);
    expect(res.body.openapi).toBe("3.1.0");
    expect(Object.keys(res.body.paths)).toContain("/v1/conversions");
  });
});

describe("one pagination convention", () => {
  const lists = [
    { path: "/v1/customers", key: "customers" },
    { path: "/v1/conversations", key: "conversations" },
    { path: "/v1/products", key: "products" },
    { path: "/v1/events", key: "events" },
    { path: "/v1/conversions", key: "conversions" },
    { path: "/v1/orders", key: "orders" },
  ];

  beforeEach(async () => {
    const { user } = await createUser();
    const workspace = await createWorkspace({ userId: user.id });
    await seed(workspace.id);
  });

  it.each(lists)("$path caps a page and says whether there is another", async ({ path, key }) => {
    const a = await keyed();
    const res = await a.get(`${path}?limit=1`).expect(200);

    expect(Array.isArray(res.body[key])).toBe(true);
    expect(res.body[key].length).toBeLessThanOrEqual(1);
    // Null or a string, never absent: a caller loops on this field.
    expect(res.body).toHaveProperty("nextCursor");
    expect(["string", "object"]).toContain(typeof res.body.nextCursor);
  });

  it.each(lists)("$path refuses a limit outside the range and a forged cursor", async ({ path }) => {
    const a = await keyed();
    await a.get(`${path}?limit=0`).expect(422);
    await a.get(`${path}?limit=500`).expect(422);
    await a.get(`${path}?cursor=not-base64-at-all!!`).expect(422);
  });

  it("enforces exactly the bounds the document states", async () => {
    const limit = openapiDocument().paths["/v1/customers"]!.get as {
      parameters: { name: string; schema: { minimum: number; maximum: number } }[];
    };
    const { minimum, maximum } = limit.parameters.find((p) => p.name === "limit")!.schema;

    const a = await keyed();
    await a.get(`/v1/customers?limit=${minimum}`).expect(200);
    await a.get(`/v1/customers?limit=${maximum}`).expect(200);
    await a.get(`/v1/customers?limit=${minimum - 1}`).expect(422);
    await a.get(`/v1/customers?limit=${maximum + 1}`).expect(422);
  });

  it("walks every customer exactly once, one at a time", async () => {
    const workspace = await prisma.workspace.findFirstOrThrow();
    const base = Date.UTC(2026, 3, 1);
    await prisma.customer.createMany({
      data: Array.from({ length: 7 }, (_, i) => ({
        id: `cus_page_${i}`, workspaceId: workspace.id, name: `Pager ${i}`,
        handle: `+91 90 000 90${i}`, channel: "whatsapp" as const, segment: "Retail" as const,
        lifetimeValue: 0, orderCount: 0, avgOrderValue: 0, returnRatePct: 0,
        priceSensitivity: "Medium" as const, negotiationStyle: "Unknown", sizeProfile: [],
        predictedNext: "Unknown", riskScore: 20,
        // Every row on the same instant, so the id tiebreak is what carries
        // the page boundary — the case a timestamp-only cursor loses rows on.
        lastSeenAt: new Date(base),
      })),
    });

    const a = await keyed();
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await a.get(`/v1/customers?limit=2${cursor ? `&cursor=${cursor}` : ""}`).expect(200);
      seen.push(...res.body.customers.map((c: { id: string }) => c.id));
      cursor = res.body.nextCursor;
    } while (cursor);

    const total = await prisma.customer.count({ where: { workspaceId: workspace.id } });
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
  });

  it("pages past a product whose name contains a dot", async () => {
    const workspace = await prisma.workspace.findFirstOrThrow();
    const supplier = await prisma.supplier.findFirstOrThrow({ where: { workspaceId: workspace.id } });
    // The cursor is `<sortKey>.<id>`. Split it on the first dot rather than the
    // last and this name takes the id with it, and the page after it is empty.
    await prisma.product.createMany({
      data: ["0.5mm liner", "0.9mm liner"].map((name, i) => ({
        id: `prd_dot_${i}`, workspaceId: workspace.id, name, category: "Test",
        axes: ["Size", "Colour"], price: 100_000, marginPct: 30, leadTimeDays: 3,
        crossSell: [], supplierId: supplier.id,
      })),
    });

    const a = await keyed();
    const first = await a.get("/v1/products?limit=1").expect(200);
    expect(first.body.products[0].name).toBe("0.5mm liner");

    const second = await a.get(`/v1/products?limit=1&cursor=${first.body.nextCursor}`).expect(200);
    expect(second.body.products[0].name).toBe("0.9mm liner");
  });

  it("walks the catalogue alphabetically, exactly once, across a repeated name", async () => {
    const workspace = await prisma.workspace.findFirstOrThrow();
    const supplier = await prisma.supplier.findFirstOrThrow({ where: { workspaceId: workspace.id } });
    // Two products sharing a name: the id tiebreak is the only thing that can
    // keep them from straddling a page.
    await prisma.product.createMany({
      data: ["aaa", "aaa", "zzz"].map((name, i) => ({
        id: `prd_page_${i}`, workspaceId: workspace.id, name, category: "Test",
        axes: ["Size", "Colour"], price: 100_000, marginPct: 30, leadTimeDays: 3,
        crossSell: [], supplierId: supplier.id,
      })),
    });

    const a = await keyed();
    const names: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await a.get(`/v1/products?limit=2${cursor ? `&cursor=${cursor}` : ""}`).expect(200);
      names.push(...res.body.products.map((p: { name: string }) => p.name));
      cursor = res.body.nextCursor;
    } while (cursor);

    const total = await prisma.product.count({ where: { workspaceId: workspace.id } });
    expect(names).toHaveLength(total);
    expect([...names]).toEqual([...names].sort());
    expect(names.filter((n) => n === "aaa")).toHaveLength(2);
  });
});

describe("one error envelope", () => {
  beforeEach(async () => {
    const { user } = await createUser();
    const workspace = await createWorkspace({ userId: user.id });
    await seed(workspace.id);
  });

  it("answers every status with { error } and nothing else shaped differently", async () => {
    const a = await keyed();
    const anonymous = agent();

    const cases = [
      { res: await anonymous.get("/v1/customers").set("authorization", "Bearer lipi_sk_nope"), status: 401 },
      { res: await a.get("/v1/customers/cus_missing"), status: 404 },
      { res: await a.get("/v1/customers?limit=0"), status: 422 },
      { res: await a.post("/v1/events").send({ type: "", twin: "customer", payload: "" }), status: 422 },
    ];

    for (const { res, status } of cases) {
      expect(res.status).toBe(status);
      expect(typeof res.body.error).toBe("string");
      expect(Object.keys(res.body).every((k) => k === "error" || k === "details")).toBe(true);
    }
  });

  it("names the fields that failed, so a caller can fix the call", async () => {
    const a = await keyed();
    const res = await a.post("/v1/events").send({ twin: "nonsense", payload: "x" }).expect(422);
    expect(Object.keys(res.body.details)).toEqual(expect.arrayContaining(["type", "twin"]));
  });

  it("refuses a read-only key on a write, with the same envelope", async () => {
    const a = await keyed({ scopes: ["read"] });
    const res = await a.post("/v1/events").send({ type: "signup", twin: "customer", payload: "x" }).expect(403);
    expect(typeof res.body.error).toBe("string");
  });
});

describe("starting a conversation from an integrator's own site", () => {
  beforeEach(async () => {
    const { user } = await createUser();
    await createWorkspace({ userId: user.id });
  });

  it("creates the thread, the customer twin and the reply in one call", async () => {
    const a = await keyed();
    const res = await a
      .post("/v1/conversations")
      .send({ channel: "webchat", handle: "visitor-7", text: "do you have olive polos in L?", name: "Ravi" })
      .expect(201);

    expect(responses.conversationCreated.safeParse(res.body).success).toBe(true);
    expect(res.body.conversation.customer.name).toBe("Ravi");
    expect(res.body.reply.length).toBeGreaterThan(0);
    expect(res.body.conversation.messageCount).toBeGreaterThan(0);
  });

  it("resolves a returning handle to the same customer twin", async () => {
    const a = await keyed();
    const first = await a
      .post("/v1/conversations")
      .send({ channel: "webchat", handle: "visitor-7", text: "hello" })
      .expect(201);
    const second = await a
      .post("/v1/conversations")
      .send({ channel: "webchat", handle: "visitor-7", text: "still there?" })
      .expect(201);

    // Continuity is the twin, not the thread: `ingest()` opens a thread per
    // message and this endpoint does not overrule it.
    expect(second.body.conversation.customerId).toBe(first.body.conversation.customerId);
    expect(await prisma.customer.count()).toBe(1);
  });

  it("validates before it ingests, so a bad call writes nothing", async () => {
    const a = await keyed();
    await a.post("/v1/conversations").send({ channel: "carrier-pigeon", handle: "x", text: "y" }).expect(422);
    await a.post("/v1/conversations").send({ channel: "webchat", handle: "x", text: "" }).expect(422);

    expect(await prisma.conversation.count()).toBe(0);
    expect(await prisma.customer.count()).toBe(0);
  });
});

describe("recording an event from an integrator's own site", () => {
  beforeEach(async () => {
    const { user } = await createUser();
    await createWorkspace({ userId: user.id });
  });

  it("namespaces the type so nothing posted can pose as an observed event", async () => {
    const a = await keyed();
    const res = await a
      .post("/v1/events")
      .send({ type: "order.created", twin: "order", payload: "shopify #1001" })
      .expect(201);

    expect(res.body.event.type).toBe("external.order.created");
    const stored = await prisma.twinEvent.findUniqueOrThrow({ where: { id: res.body.event.id } });
    expect(stored.type).toBe("external.order.created");
  });

  it("clamps a timestamp from the future to now", async () => {
    const a = await keyed();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const res = await a
      .post("/v1/events")
      .send({ type: "cart.viewed", twin: "customer", payload: "x", occurredIso: future })
      .expect(201);

    expect(new Date(res.body.event.atIso).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("keeps a past timestamp, which is what a backfill needs", async () => {
    const a = await keyed();
    const past = new Date(Date.UTC(2026, 0, 5)).toISOString();
    const res = await a
      .post("/v1/events")
      .send({ type: "cart.viewed", twin: "customer", payload: "x", occurredIso: past })
      .expect(201);

    expect(res.body.event.atIso).toBe(past);
  });

  it("appears in the list it was appended to", async () => {
    const a = await keyed();
    await a.post("/v1/events").send({ type: "signup", twin: "customer", payload: "ravi@test" }).expect(201);

    const list = await a.get("/v1/events?limit=5").expect(200);
    expect(list.body.events.some((e: { type: string }) => e.type === "external.signup")).toBe(true);
  });
});

describe("conversions", () => {
  beforeEach(async () => {
    const { user } = await createUser();
    const workspace = await createWorkspace({ userId: user.id });
    await seed(workspace.id);
  });

  it("carries the exact paise, not the rounded rupees", async () => {
    const a = await keyed();
    const res = await a.get("/v1/conversions").expect(200);
    // The seeded order, not whichever one `ingest()` happened to write first.
    const row = res.body.conversions.find((c: { id: string }) => c.id === "ord_seed");

    expect(row.valuePaise).toBe(449_900);
    expect(row.valueInr).toBe(4_499);
    expect(Number.isInteger(row.valuePaise)).toBe(true);
  });

  it("carries the customer's first touch, so a campaign can be credited", async () => {
    const a = await keyed();
    const res = await a.get("/v1/conversions").expect(200);

    expect(res.body.conversions[0].attribution).toMatchObject({
      utmSource: "google", utmCampaign: "diwali", adClickId: "gclid-1",
    });
  });

  it("filters to the stages the caller counts as converted", async () => {
    const a = await keyed();

    const paid = await a.get("/v1/conversions?stage=Paid").expect(200);
    expect(paid.body.conversions).toHaveLength(1);

    const returned = await a.get("/v1/conversions?stage=Returned").expect(200);
    expect(returned.body.conversions).toHaveLength(0);

    await a.get("/v1/conversions?stage=Imaginary").expect(422);
  });

  it("is a view of the orders, not a second record of them", async () => {
    const a = await keyed();
    const conversions = await a.get("/v1/conversions").expect(200);
    const orders = await a.get("/v1/orders").expect(200);

    expect(conversions.body.conversions.map((c: { id: string }) => c.id))
      .toEqual(orders.body.orders.map((o: { id: string }) => o.id));
  });
});

describe("tenancy on every new endpoint", () => {
  let mine: { id: string };
  let theirs: { customerId: string; productId: string; conversationId: string; orderId: string };

  beforeEach(async () => {
    const { user: a } = await createUser("mine@test.local");
    const { user: b } = await createUser("theirs@test.local");
    mine = await createWorkspace({ userId: a.id, name: "Mine" });
    const other = await createWorkspace({ userId: b.id, name: "Theirs" });

    const seeded = await (async () => {
      const owner = await signedIn("theirs@test.local");
      await owner
        .post("/v1/messages")
        .send({ channel: "whatsapp", handle: "+91 90 000 9999", text: "hello" })
        .expect(201);
      const customer = await prisma.customer.findFirstOrThrow({ where: { workspaceId: other.id } });
      const product = await prisma.product.findFirstOrThrow({ where: { workspaceId: other.id } });
      const variant = await prisma.variant.findFirstOrThrow({ where: { productId: product.id } });
      const conversation = await prisma.conversation.findFirstOrThrow({ where: { workspaceId: other.id } });
      const order = await prisma.order.create({
        data: {
          id: "ord_theirs", workspaceId: other.id, variant: "L / Olive", qty: 1, value: 100_000,
          stage: "Paid", channel: "whatsapp", createdAt: new Date(),
          customerId: customer.id, productId: product.id, variantId: variant.id,
        },
      });
      return {
        customerId: customer.id, productId: product.id,
        conversationId: conversation.id, orderId: order.id,
      };
    })();

    theirs = seeded;
  });

  it("answers 404 for another workspace's row, on every by-id endpoint", async () => {
    const a = await keyed({ email: "mine@test.local" });

    await a.get(`/v1/customers/${theirs.customerId}`).expect(404);
    await a.get(`/v1/products/${theirs.productId}`).expect(404);
    await a.get(`/v1/conversations/${theirs.conversationId}`).expect(404);
  });

  it("lists none of another workspace's rows, on every list endpoint", async () => {
    const a = await keyed({ email: "mine@test.local" });

    const customers = await a.get("/v1/customers").expect(200);
    expect(customers.body.customers).toHaveLength(0);

    const conversations = await a.get("/v1/conversations").expect(200);
    expect(conversations.body.conversations).toHaveLength(0);

    const conversions = await a.get("/v1/conversions").expect(200);
    expect(conversions.body.conversions).toHaveLength(0);

    const products = await a.get("/v1/products").expect(200);
    const ourIds = new Set((await prisma.product.findMany({ where: { workspaceId: mine.id } })).map((p) => p.id));
    expect(products.body.products.every((p: { id: string }) => ourIds.has(p.id))).toBe(true);
    expect(products.body.products.some((p: { id: string }) => p.id === theirs.productId)).toBe(false);
  });

  it("writes only into the workspace the key was minted in", async () => {
    const a = await keyed({ email: "mine@test.local" });
    await a.post("/v1/events").send({ type: "signup", twin: "customer", payload: "x" }).expect(201);

    const written = await prisma.twinEvent.findMany({ where: { type: "external.signup" } });
    expect(written).toHaveLength(1);
    expect(written[0]!.workspaceId).toBe(mine.id);
  });

  it("cannot be steered into another tenant by a forged cursor", async () => {
    const a = await keyed({ email: "mine@test.local" });
    const forged = Buffer.from(`${Date.now() + 86_400_000}.${theirs.customerId}`, "utf8").toString("base64url");

    const res = await a.get(`/v1/customers?cursor=${forged}`).expect(200);
    expect(res.body.customers).toHaveLength(0);
  });
});
