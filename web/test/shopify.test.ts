import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agent, createUser, createWorkspace, resetDatabase, signedIn } from "./helpers";
import { fakeShopify, orderFixture, productFixture, variantFixture } from "./fakes/shopify";
import { decrypt } from "@/server/lib/crypto";
import { prisma } from "@/server/lib/prisma";
import { pullAll } from "@/server/services/shopify";

beforeEach(resetDatabase);

const SHOP = "acme.myshopify.com";

/** A workspace with no catalogue of its own, so every product here is imported. */
async function workspace(opts: { email?: string } = {}) {
  const email = opts.email ?? "owner@test.local";
  const { user } = await createUser(email);
  const ws = await createWorkspace({ userId: user.id, withCatalogue: false });
  return { workspace: ws, a: await signedIn(email) };
}

/** The query Shopify redirects back with, signed the way Shopify signs it. */
function callback(params: Record<string, string>) {
  const search = Object.entries(params)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .sort()
    .join("&");
  const hmac = createHmac("sha256", fakeShopify.apiSecret).update(search).digest("hex");
  return `${search}&hmac=${hmac}`;
}

/** Install a store and come back from consent, the whole round trip. */
async function connected(opts: { email?: string; shop?: string } = {}) {
  const { workspace: ws, a } = await workspace({ email: opts.email });
  const shop = opts.shop ?? SHOP;

  const started = await a.post("/v1/inventory/shopify/install").send({ shop }).expect(201);
  const state = new URL(started.body.redirectUrl).searchParams.get("state")!;

  await a
    .get(`/v1/inventory/shopify/callback?${callback({ shop, code: "one-time-code", state })}`)
    .expect(303);

  const connector = await prisma.inventoryConnector.findFirstOrThrow({ where: { workspaceId: ws.id } });
  return { workspace: ws, a, shop, connector };
}

const sync = (a: ReturnType<typeof agent>) => a.post("/v1/inventory/shopify/sync");

/** A delivery signed with the deployment's Shopify app secret. */
const deliver = (topic: string, payload: unknown, opts: { shop?: string; hmac?: string } = {}) => {
  const raw = JSON.stringify(payload);
  return agent()
    .post("/webhooks/shopify")
    .set("x-shopify-topic", topic)
    .set("x-shopify-shop-domain", opts.shop ?? SHOP)
    .set("x-shopify-hmac-sha256", opts.hmac ?? fakeShopify.sign(raw))
    .send(raw);
};

const variantsOf = (workspaceId: string) =>
  prisma.variant.findMany({ where: { product: { workspaceId } }, orderBy: { sku: "asc" } });

/* ================================== install ================================= */

describe("shopify install", () => {
  it("sends the operator to Shopify and leaves the connector pending", async () => {
    const { a } = await workspace();

    const res = await a.post("/v1/inventory/shopify/install").send({ shop: SHOP }).expect(201);

    const url = new URL(res.body.redirectUrl);
    expect(url.host).toBe(SHOP);
    expect(url.pathname).toBe("/admin/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("test-shopify-api-key");
    expect(url.searchParams.get("scope")).toContain("read_products");
    expect(url.searchParams.get("redirect_uri")).toContain("/v1/inventory/shopify/callback");
    expect(url.searchParams.get("state")).toBeTruthy();

    expect(res.body.connector.status).toBe("pending");
    expect(res.body.connector.shop).toBe(SHOP);
    // Starting is not connecting: nothing was exchanged yet.
    expect(fakeShopify.calls.exchangeToken).toHaveLength(0);
  });

  it("takes a bare store name and refuses anything that is not a myshopify host", async () => {
    const { a } = await workspace();

    const res = await a.post("/v1/inventory/shopify/install").send({ shop: "acme" }).expect(201);
    expect(new URL(res.body.redirectUrl).host).toBe(SHOP);

    // The shop name is used to build the URL we then call, so anything else
    // would make this app a request forwarder for whoever typed it.
    for (const shop of ["evil.example.com", "acme.myshopify.com.evil.test", "https://127.0.0.1/"]) {
      await a.post("/v1/inventory/shopify/install").send({ shop }).expect(422);
    }
  });

  it("will not let a second workspace claim a store the first has", async () => {
    await connected();
    const { a } = await workspace({ email: "other@test.local" });

    await a.post("/v1/inventory/shopify/install").send({ shop: SHOP }).expect(409);
  });

  it("stores the token encrypted and subscribes to both topics", async () => {
    const { connector } = await connected();

    expect(connector.status).toBe("connected");
    expect(connector.installState).toBeNull();
    expect(connector.accessToken).not.toBe(fakeShopify.token);
    expect(decrypt(connector.accessToken!)).toBe(fakeShopify.token);
    expect(connector.scopes).toContain("read_products");

    expect(fakeShopify.webhooks.map((w) => w.topic).sort()).toEqual([
      "inventory_levels/update",
      "products/update",
    ]);
    expect(fakeShopify.calls.createWebhook.every((c) => c.address.endsWith("/webhooks/shopify"))).toBe(true);
  });

  it("never returns the token, from the install or from the connector list", async () => {
    const { a } = await connected();

    const list = await a.get("/v1/inventory/connectors").expect(200);
    const serialised = JSON.stringify(list.body);

    expect(serialised).not.toContain(fakeShopify.token);
    expect(serialised).not.toContain("accessToken");
    expect(serialised).not.toContain("installState");
  });

  it("never writes the token to a log line", async () => {
    const lines: string[] = [];
    const levels = ["log", "info", "warn", "error"] as const;
    const spies = levels.map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      }),
    );

    try {
      const { a, connector } = await connected();
      fakeShopify.storeProducts.push(productFixture({ variants: [variantFixture({ id: 42 })] }));
      fakeShopify.storeOrders.push(orderFixture({ id: 5900, line_items: [{ id: 1, variant_id: 42, sku: "s", quantity: 1, price: "1.00" }] }));
      await sync(a).expect(200);
      // Including the paths that log on purpose: an unroutable delivery, and
      // a disconnect whose provider calls are best-effort.
      await deliver("inventory_levels/update", { inventory_item_id: 1, available: 1 }, { shop: "beta.myshopify.com" });
      await a.delete(`/v1/inventory/connectors/${connector.id}`).expect(204);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }

    expect(lines.join("\n")).not.toContain(fakeShopify.token);
  });

  it("subscribing twice does not double the subscriptions", async () => {
    const { a, shop } = await connected();

    // Re-consent, as an operator re-granting scopes would.
    const again = await a.post("/v1/inventory/shopify/install").send({ shop }).expect(201);
    const state = new URL(again.body.redirectUrl).searchParams.get("state")!;
    await a.get(`/v1/inventory/shopify/callback?${callback({ shop, code: "second", state })}`).expect(303);

    expect(fakeShopify.webhooks).toHaveLength(2);
  });
});

describe("shopify callback", () => {
  it("refuses a callback that Shopify did not sign", async () => {
    const { a } = await workspace();
    const started = await a.post("/v1/inventory/shopify/install").send({ shop: SHOP }).expect(201);
    const state = new URL(started.body.redirectUrl).searchParams.get("state")!;

    const signed = callback({ shop: SHOP, code: "c", state });

    await a.get(`/v1/inventory/shopify/callback?${signed}`.replace(/hmac=.*/, "hmac=deadbeef")).expect(401);
    await a.get(`/v1/inventory/shopify/callback?shop=${SHOP}&code=c&state=${state}`).expect(401);
    // Signed, but a parameter was edited after signing.
    await a.get(`/v1/inventory/shopify/callback?${signed.replace("code=c", "code=other")}`).expect(401);
    expect(fakeShopify.calls.exchangeToken).toHaveLength(0);
  });

  it("refuses a state that is not the one this workspace started with", async () => {
    const { a } = await workspace();
    await a.post("/v1/inventory/shopify/install").send({ shop: SHOP }).expect(201);

    await a.get(`/v1/inventory/shopify/callback?${callback({ shop: SHOP, code: "c", state: "guessed" })}`)
      .expect(403);
    expect(fakeShopify.calls.exchangeToken).toHaveLength(0);
  });

  it("spends the nonce, so a replayed callback finds nothing to match", async () => {
    const { a } = await workspace();
    const started = await a.post("/v1/inventory/shopify/install").send({ shop: SHOP }).expect(201);
    const state = new URL(started.body.redirectUrl).searchParams.get("state")!;
    const query = callback({ shop: SHOP, code: "c", state });

    await a.get(`/v1/inventory/shopify/callback?${query}`).expect(303);
    await a.get(`/v1/inventory/shopify/callback?${query}`).expect(404);
    expect(fakeShopify.calls.exchangeToken).toHaveLength(1);
  });
});

describe("shopify disconnect", () => {
  it("withdraws the webhooks and leaves no credential behind", async () => {
    const { a, connector } = await connected();

    await a.delete(`/v1/inventory/connectors/${connector.id}`).expect(204);

    expect(fakeShopify.webhooks).toHaveLength(0);
    expect(fakeShopify.calls.deleteWebhook).toHaveLength(2);
    expect(await prisma.inventoryConnector.findUnique({ where: { id: connector.id } })).toBeNull();
  });

  it("a delivery for a store that is gone is acknowledged and written nowhere", async () => {
    const { a, connector, workspace: ws } = await connected();
    fakeShopify.storeProducts.push(productFixture());
    await sync(a).expect(200);

    await a.delete(`/v1/inventory/connectors/${connector.id}`).expect(204);

    await deliver("inventory_levels/update", { inventory_item_id: 1, available: 5 }).expect(200);
    expect(await prisma.inventoryException.count()).toBe(0);
    expect(await prisma.inventoryConnector.count({ where: { workspaceId: ws.id } })).toBe(0);
  });
});

/* ============================ products and stock ============================ */

describe("shopify product import", () => {
  it("imports products, maps both of Shopify's handles, and moves stock through applySync", async () => {
    const { a, workspace: ws } = await connected();
    const variant = variantFixture({ id: 4001, option1: "M", option2: "Cobalt", inventory_quantity: 12 });
    fakeShopify.storeProducts.push(productFixture({ id: 9001, title: "Cotton Polo", variants: [variant] }));

    const res = await sync(a).expect(200);
    expect(res.body.products).toMatchObject({ products: 1, variants: 1, skipped: 0 });

    const product = await prisma.product.findFirstOrThrow({ where: { workspaceId: ws.id } });
    expect(product.name).toBe("Cotton Polo");
    expect(product.axes).toEqual(["Size", "Colour"]);
    // Invariant 4: paise, integer, never a float off the wire.
    expect(product.price).toBe(129_900);

    const [row] = await variantsOf(ws.id);
    expect(row).toMatchObject({ optionA: "M", optionB: "Cobalt", stock: 12, reserved: 0 });

    const mapping = await prisma.inventoryMapping.findFirstOrThrow({ where: { variantId: row!.id } });
    expect(mapping.externalSku).toBe("4001");
    expect(mapping.externalRef).toBe(String(variant.inventory_item_id));

    // The number came through the one path that moves stock, so it left the
    // trail every other correction leaves.
    const events = await prisma.twinEvent.findMany({ where: { type: "inventory_twin.corrected" } });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toContain("via shopify");
    expect(res.body.stock).toMatchObject({ status: "applied", applied: 1 });
  });

  it("folds a third option axis into the second rather than losing it", async () => {
    const { a, workspace: ws } = await connected();
    fakeShopify.storeProducts.push(
      productFixture({
        options: [
          { name: "Size", position: 1 },
          { name: "Colour", position: 2 },
          { name: "Fabric", position: 3 },
        ],
        variants: [
          variantFixture({ id: 11, option1: "M", option2: "Cobalt", option3: "Linen" }),
          variantFixture({ id: 12, option1: "M", option2: "Cobalt", option3: "Cotton" }),
        ],
      }),
    );

    await sync(a).expect(200);

    const product = await prisma.product.findFirstOrThrow({ where: { workspaceId: ws.id } });
    expect(product.axes).toEqual(["Size", "Colour / Fabric"]);
    expect((await variantsOf(ws.id)).map((v) => v.optionB).sort()).toEqual(["Cobalt / Cotton", "Cobalt / Linen"]);
  });

  it("raises an exception for a variant it cannot map instead of failing the run", async () => {
    const { a, workspace: ws } = await connected();
    fakeShopify.storeProducts.push(
      productFixture({
        variants: [
          variantFixture({ id: 21, option1: "M", option2: "Cobalt" }),
          variantFixture({ id: 22, option1: "M", option2: "Cobalt" }),
          variantFixture({ id: 23, option1: "L", option2: "Cobalt" }),
        ],
      }),
    );

    const res = await sync(a).expect(200);

    expect(res.body.products).toMatchObject({ products: 1, variants: 2, skipped: 1 });
    expect(await variantsOf(ws.id)).toHaveLength(2);

    // The run carried on and applied the two it could. The one it could not
    // is visible work in the queue the operator already knows, twice over:
    // the import says why it could not become a variant, and applySync says
    // its count landed on nothing.
    expect(res.body.stock).toMatchObject({ status: "partial", applied: 2, rejected: 1 });
    const exceptions = await prisma.inventoryException.findMany();
    expect(exceptions.map((e) => `${e.kind}:${e.externalSku}`).sort()).toEqual([
      "ambiguous_sku:22",
      "unmapped_sku:22",
    ]);
  });

  it("re-running a sync duplicates nothing and double-counts nothing", async () => {
    const { a, workspace: ws } = await connected();
    fakeShopify.storeProducts.push(productFixture({ id: 9001, variants: [variantFixture({ id: 4001 })] }));

    await sync(a).expect(200);
    const second = await sync(a).expect(200);

    expect(await prisma.product.count({ where: { workspaceId: ws.id } })).toBe(1);
    expect(await variantsOf(ws.id)).toHaveLength(1);
    expect(await prisma.inventoryMapping.count()).toBe(1);
    expect((await variantsOf(ws.id))[0]!.stock).toBe(12);
    // Same tail, same watermark, same batch key: applySync replays it.
    expect(second.body.stock.replayed).toBe(true);
    expect(await prisma.twinEvent.count({ where: { type: "inventory_twin.corrected" } })).toBe(1);
  });

  it("carries the watermark forward and holds it when a poll finds nothing", async () => {
    const { a, workspace: ws } = await connected();
    fakeShopify.storeProducts.push(
      productFixture({ id: 1, updated_at: "2026-09-18T09:00:00Z", variants: [variantFixture({ id: 31 })] }),
      productFixture({ id: 2, updated_at: "2026-09-19T09:00:00Z", variants: [variantFixture({ id: 32 })] }),
    );

    await sync(a).expect(200);
    expect(fakeShopify.calls.products[0]!.options.updatedAtMin).toBeNull();

    const after = await prisma.inventoryConnector.findFirstOrThrow({ where: { workspaceId: ws.id } });
    expect(after.cursor).toBe("2026-09-19T09:00:00Z");

    // The store goes quiet. The position must not move backwards or forwards.
    fakeShopify.storeProducts = [];
    const quiet = await sync(a).expect(200);
    expect(fakeShopify.calls.products[1]!.options.updatedAtMin).toBe("2026-09-19T09:00:00Z");
    expect(quiet.body.stock).toBeNull();
    expect((await prisma.inventoryConnector.findFirstOrThrow({ where: { workspaceId: ws.id } })).cursor)
      .toBe("2026-09-19T09:00:00Z");
  });

  it("reads past the first page, because Shopify pages by id and not by time", async () => {
    // The trap this exists for: page one holds the three oldest ids, and the
    // newest `updated_at` is on page two. A poll that stopped at one page
    // would take its watermark from page one and skip the rest for ever.
    for (const [id, updatedAt] of [
      [1, "2026-09-10T00:00:00Z"],
      [2, "2026-09-11T00:00:00Z"],
      [3, "2026-09-12T00:00:00Z"],
      [4, "2026-09-30T00:00:00Z"],
    ] as const) {
      fakeShopify.storeProducts.push(productFixture({ id, updated_at: updatedAt }));
    }

    const pulled = await pullAll(
      (options) => fakeShopify.products(SHOP, "token", options),
      null,
      3,
    );

    expect(pulled.map((p) => p.id)).toEqual([1, 2, 3, 4]);
    expect(fakeShopify.calls.products.map((c) => c.options.sinceId)).toEqual([0, 3]);
  });

  it("refuses to sync a store that is not connected", async () => {
    const { a } = await workspace();
    await sync(a).expect(404);

    await a.post("/v1/inventory/shopify/install").send({ shop: SHOP }).expect(201);
    // Pending: a row exists, a token does not.
    await sync(a).expect(409);
  });
});

/* ================================= webhooks ================================= */

describe("shopify webhooks", () => {
  it("rejects a body whose signature does not check out", async () => {
    const { a } = await connected();
    const variant = variantFixture({ id: 41, inventory_quantity: 4 });
    fakeShopify.storeProducts.push(productFixture({ variants: [variant] }));
    await sync(a).expect(200);

    const level = { inventory_item_id: variant.inventory_item_id, available: 99 };
    await deliver("inventory_levels/update", level, { hmac: "nope" }).expect(401);
    // And a delivery carrying no signature at all.
    await agent()
      .post("/webhooks/shopify")
      .set("x-shopify-topic", "inventory_levels/update")
      .set("x-shopify-shop-domain", SHOP)
      .send(level)
      .expect(401);

    // Nothing moved on a body we could not prove came from Shopify.
    const [row] = await prisma.variant.findMany({});
    expect(row!.stock).toBe(4);
  });

  it("applies a level change to the mapped variant, through applySync", async () => {
    const { a, workspace: ws } = await connected();
    const variant = variantFixture({ id: 51, inventory_quantity: 9 });
    fakeShopify.storeProducts.push(productFixture({ variants: [variant] }));
    await sync(a).expect(200);

    await deliver("inventory_levels/update", {
      inventory_item_id: variant.inventory_item_id,
      available: 2,
      updated_at: "2026-09-20T08:00:00Z",
    }).expect(200);

    expect((await variantsOf(ws.id))[0]!.stock).toBe(2);
    expect(await prisma.twinEvent.count({ where: { type: "inventory_twin.corrected" } })).toBe(2);
  });

  it("replays a redelivered level rather than applying it twice", async () => {
    const { a } = await connected();
    const variant = variantFixture({ id: 52, inventory_quantity: 9 });
    fakeShopify.storeProducts.push(productFixture({ variants: [variant] }));
    await sync(a).expect(200);

    const level = { inventory_item_id: variant.inventory_item_id, available: 3, updated_at: "2026-09-20T08:00:00Z" };
    await deliver("inventory_levels/update", level).expect(200);
    await deliver("inventory_levels/update", level).expect(200);

    const runs = await prisma.inventorySyncRun.findMany({});
    expect(runs.filter((r) => r.idempotencyKey.startsWith("shopify:inventory:"))).toHaveLength(1);
  });

  it("raises unmapped_sku for an inventory item nobody has imported", async () => {
    const { a } = await connected();
    fakeShopify.storeProducts.push(productFixture({ variants: [variantFixture({ id: 61 })] }));
    await sync(a).expect(200);

    await deliver("inventory_levels/update", { inventory_item_id: 777_000, available: 5 }).expect(200);

    const exception = await prisma.inventoryException.findFirstOrThrow({ where: { kind: "unmapped_sku" } });
    expect(exception.externalSku).toBe("inventory_item:777000");
  });

  it("takes a product update and corrects the twin from it", async () => {
    const { a, workspace: ws } = await connected();
    const variant = variantFixture({ id: 71, inventory_quantity: 6 });
    const product = productFixture({ id: 9101, title: "Cotton Polo", variants: [variant] });
    fakeShopify.storeProducts.push(product);
    await sync(a).expect(200);

    await deliver("products/update", {
      ...product,
      title: "Cotton Polo V2",
      updated_at: "2026-09-20T12:00:00Z",
      variants: [{ ...variant, inventory_quantity: 1 }],
    }).expect(200);

    expect((await prisma.product.findFirstOrThrow({ where: { workspaceId: ws.id } })).name).toBe("Cotton Polo V2");
    expect((await variantsOf(ws.id))[0]!.stock).toBe(1);
  });

  it("refuses a signed body that is not a product or a level", async () => {
    await connected();

    // Signed, and still unusable: neither handler has anything to read.
    await deliver("inventory_levels/update", null).expect(400);
    await deliver("products/update", "not-a-product").expect(400);
    await deliver("inventory_levels/update", { available: 5 }).expect(400);
    await deliver("products/update", { id: 1 }).expect(400);
  });

  it("acknowledges a topic it does not serve and a shop it does not know", async () => {
    await connected();

    await deliver("orders/create", { id: 1 }).expect(200);
    await deliver("inventory_levels/update", { inventory_item_id: 1, available: 1 }, { shop: "other.myshopify.com" })
      .expect(200);
    expect(await prisma.inventoryException.count()).toBe(0);
  });
});

/* ================================== orders ================================== */

describe("shopify order import", () => {
  const lineFor = (variantId: number, quantity = 2, price = "1299.00") => ({
    id: variantId * 10,
    variant_id: variantId,
    sku: `SHOP-${variantId}`,
    quantity,
    price,
  });

  it("brings an order in with its customer, its money in paise, and its first touch", async () => {
    const { a, workspace: ws } = await connected();
    fakeShopify.storeProducts.push(productFixture({ variants: [variantFixture({ id: 81 })] }));
    fakeShopify.storeOrders.push(orderFixture({ id: 5001, line_items: [lineFor(81)] }));

    const res = await sync(a).expect(200);
    expect(res.body.orders).toMatchObject({ orders: 1, lines: 1, skipped: 0 });

    const order = await prisma.order.findFirstOrThrow({ where: { workspaceId: ws.id } });
    expect(order.qty).toBe(2);
    expect(order.value).toBe(259_800);
    expect(order.stage).toBe("Paid");

    const customer = await prisma.customer.findUniqueOrThrow({ where: { id: order.customerId } });
    expect(customer.handle).toBe("buyer@example.com");
    expect(customer.utmSource).toBe("google");
    expect(customer.utmMedium).toBe("cpc");
    expect(customer.adClickId).toBe("abc123");
    expect(customer.referrer).toBe("https://www.google.com/");
    expect(customer.firstTouchAt).not.toBeNull();
    // Revenue that happened in Shopify, visible where the dashboard reads it.
    expect(customer.lifetimeValue).toBe(259_800);
    expect(customer.orderCount).toBe(1);
  });

  it("never re-credits a returning buyer to the campaign that brought them back", async () => {
    const { a, workspace: ws } = await connected();
    fakeShopify.storeProducts.push(productFixture({ variants: [variantFixture({ id: 82 })] }));
    fakeShopify.storeOrders.push(orderFixture({ id: 5002, line_items: [lineFor(82, 1)] }));
    await sync(a).expect(200);

    fakeShopify.storeOrders.push(
      orderFixture({
        id: 5003,
        updated_at: "2026-09-19T15:00:00Z",
        created_at: "2026-09-19T15:00:00Z",
        landing_site: "/?utm_source=meta&utm_medium=retargeting",
        line_items: [lineFor(82, 1)],
      }),
    );
    await sync(a).expect(200);

    const customer = await prisma.customer.findFirstOrThrow({ where: { workspaceId: ws.id } });
    expect(customer.utmSource).toBe("google");
    expect(customer.utmMedium).toBe("cpc");
    expect(await prisma.order.count({ where: { workspaceId: ws.id } })).toBe(2);
    expect(customer.orderCount).toBe(2);
  });

  it("re-importing corrects where an order stands and adds nothing", async () => {
    const { a, workspace: ws } = await connected();
    fakeShopify.storeProducts.push(productFixture({ variants: [variantFixture({ id: 83 })] }));
    const order = orderFixture({ id: 5004, financial_status: "pending", line_items: [lineFor(83, 3)] });
    fakeShopify.storeOrders.push(order);

    await sync(a).expect(200);
    expect((await prisma.order.findFirstOrThrow({ where: { workspaceId: ws.id } })).stage).toBe("Quoted");

    order.financial_status = "paid";
    order.fulfillment_status = "fulfilled";
    order.updated_at = "2026-09-19T18:00:00Z";
    await sync(a).expect(200);

    const rows = await prisma.order.findMany({ where: { workspaceId: ws.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.stage).toBe("Shipped");
    expect(rows[0]!.qty).toBe(3);
  });

  it("does not touch stock: Shopify already counted the sale", async () => {
    const { a, workspace: ws } = await connected();
    fakeShopify.storeProducts.push(productFixture({ variants: [variantFixture({ id: 84, inventory_quantity: 7 })] }));
    fakeShopify.storeOrders.push(orderFixture({ id: 5005, line_items: [lineFor(84, 4)] }));

    await sync(a).expect(200);

    const [variant] = await variantsOf(ws.id);
    expect(variant!.stock).toBe(7);
    expect(variant!.reserved).toBe(0);
  });

  it("skips a line whose variant this connector has never mapped", async () => {
    const { a, workspace: ws } = await connected();
    fakeShopify.storeProducts.push(productFixture({ variants: [variantFixture({ id: 85 })] }));
    fakeShopify.storeOrders.push(orderFixture({ id: 5006, line_items: [lineFor(85), lineFor(999_999)] }));

    const res = await sync(a).expect(200);

    expect(res.body.orders).toMatchObject({ orders: 1, lines: 1, skipped: 1 });
    expect(await prisma.order.count({ where: { workspaceId: ws.id } })).toBe(1);
  });

  it("a refunded order stops counting towards lifetime value", async () => {
    const { a, workspace: ws } = await connected();
    fakeShopify.storeProducts.push(productFixture({ variants: [variantFixture({ id: 86 })] }));
    const order = orderFixture({ id: 5007, line_items: [lineFor(86, 1)] });
    fakeShopify.storeOrders.push(order);
    await sync(a).expect(200);

    order.financial_status = "refunded";
    order.updated_at = "2026-09-19T20:00:00Z";
    await sync(a).expect(200);

    const customer = await prisma.customer.findFirstOrThrow({ where: { workspaceId: ws.id } });
    expect(customer.lifetimeValue).toBe(0);
    expect(customer.orderCount).toBe(0);
  });
});

/* ================================== tenancy ================================= */

describe("shopify tenancy", () => {
  it("keeps one store's import inside its own workspace", async () => {
    const first = await connected();
    fakeShopify.storeProducts.push(productFixture({ id: 9500, variants: [variantFixture({ id: 91 })] }));
    fakeShopify.storeOrders.push(orderFixture({ id: 5100, line_items: [{ id: 1, variant_id: 91, sku: "s", quantity: 1, price: "10.00" }] }));
    await sync(first.a).expect(200);

    const second = await connected({ email: "other@test.local", shop: "beta.myshopify.com" });

    expect(await prisma.product.count({ where: { workspaceId: second.workspace.id } })).toBe(0);
    expect(await prisma.order.count({ where: { workspaceId: second.workspace.id } })).toBe(0);
    expect(await prisma.customer.count({ where: { workspaceId: second.workspace.id } })).toBe(0);

    // And the second workspace cannot reach the first's connector.
    await second.a.delete(`/v1/inventory/connectors/${first.connector.id}`).expect(404);
    await second.a.get(`/v1/inventory/connectors/${first.connector.id}/mappings`).expect(404);
  });

  it("a delivery for one store never moves another store's stock", async () => {
    const first = await connected();
    const variant = variantFixture({ id: 92, inventory_quantity: 5 });
    fakeShopify.storeProducts.push(productFixture({ variants: [variant] }));
    await sync(first.a).expect(200);

    await deliver("inventory_levels/update", { inventory_item_id: variant.inventory_item_id, available: 0 }, {
      shop: "beta.myshopify.com",
    }).expect(200);

    expect((await variantsOf(first.workspace.id))[0]!.stock).toBe(5);
  });
});
