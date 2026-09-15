import { beforeEach, describe, expect, it } from "vitest";
import { agent, createUser, createWorkspace, resetDatabase, signedIn } from "./helpers";
import { prisma } from "@/server/lib/prisma";

beforeEach(resetDatabase);

/** A connector plus its one-time token, and the SKU->variant map for a product. */
async function connected(opts: { mapAll?: boolean } = {}) {
  const { user } = await createUser();
  const workspace = await createWorkspace({ userId: user.id });
  const a = await signedIn();

  const created = await a
    .post("/v1/inventory/connectors")
    .send({ source: "shopify", name: "Main store" })
    .expect(201);

  const connectorId = created.body.connector.id as string;
  const secret = created.body.secret as string;

  const product = await prisma.product.findFirstOrThrow({
    where: { workspaceId: workspace.id },
    include: { variants: { orderBy: [{ optionA: "asc" }, { optionB: "asc" }] } },
  });

  const skuOf = (v: { optionA: string; optionB: string }) =>
    `SKU-${v.optionA}-${v.optionB}`.replace(/\s+/g, "");

  if (opts.mapAll !== false) {
    for (const variant of product.variants) {
      await a
        .post(`/v1/inventory/connectors/${connectorId}/mappings`)
        .send({ externalSku: skuOf(variant), variantId: variant.id })
        .expect(201);
    }
  }

  return { a, workspace, connectorId, secret, product, skuOf };
}

const push = (connectorId: string, secret: string, body: unknown) =>
  agent()
    .post(`/v1/inventory/${connectorId}/sync`)
    .set("Authorization", `Bearer ${secret}`)
    .send(body);

describe("inventory connector auth", () => {
  it("refuses a push with no token, a wrong token, or an unknown connector", async () => {
    const { connectorId, secret } = await connected();
    const batch = { idempotencyKey: "batch-0001", rows: [{ sku: "SKU-X", stock: 1 }] };

    await agent().post(`/v1/inventory/${connectorId}/sync`).send(batch).expect(401);
    await push(connectorId, "lipi_inv_wrong", batch).expect(401);
    await push("cnt_does_not_exist", secret, batch).expect(401);
  });

  it("shows the token once and never again", async () => {
    const { a, connectorId } = await connected();

    const list = await a.get("/v1/inventory/connectors").expect(200);
    const row = list.body.connectors.find((c: { id: string }) => c.id === connectorId);

    expect(JSON.stringify(row)).not.toMatch(/lipi_inv_/);
    expect(row.secret).toBeUndefined();
    expect(row.secretHash).toBeUndefined();
  });

  it("rotating issues a new token and retires the old one", async () => {
    const { a, connectorId, secret } = await connected();

    const rotated = await a.post(`/v1/inventory/connectors/${connectorId}/rotate`).expect(200);
    const fresh = rotated.body.secret as string;
    expect(fresh).not.toBe(secret);

    await push(connectorId, secret, { idempotencyKey: "old-token-1", rows: [{ sku: "x", stock: 1 }] }).expect(401);
    await push(connectorId, fresh, { idempotencyKey: "new-token-1", rows: [{ sku: "x", stock: 1 }] }).expect(201);
  });
});

describe("inventory sync", () => {
  it("corrects stock through the twin and appends an event per change", async () => {
    const { connectorId, secret, product, skuOf } = await connected();
    const variant = product.variants[0]!;

    const res = await push(connectorId, secret, {
      idempotencyKey: "batch-real-1",
      cursor: "updated_at=2026-09-05T10:00:00Z",
      rows: [{ sku: skuOf(variant), stock: variant.stock + 17 }],
    }).expect(201);

    expect(res.body.status).toBe("applied");
    expect(res.body.applied).toBe(1);
    expect(res.body.changes[0]).toMatchObject({ from: variant.stock, to: variant.stock + 17 });

    const after = await prisma.variant.findUniqueOrThrow({ where: { id: variant.id } });
    expect(after.stock).toBe(variant.stock + 17);

    const events = await prisma.twinEvent.findMany({ where: { type: "inventory_twin.corrected" } });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toContain("via shopify");
  });

  it("applies a replayed batch exactly once", async () => {
    const { connectorId, secret, product, skuOf } = await connected();
    const variant = product.variants[0]!;
    const batch = {
      idempotencyKey: "batch-retry-me",
      rows: [{ sku: skuOf(variant), stock: 3 }],
    };

    const first = await push(connectorId, secret, batch).expect(201);
    expect(first.body.replayed).toBe(false);

    // The source timed out and re-sent. It must not correct twice, and it must
    // get the original answer back rather than an error.
    const second = await push(connectorId, secret, batch).expect(200);
    expect(second.body.replayed).toBe(true);
    expect(second.body.runId).toBe(first.body.runId);
    expect(second.body.applied).toBe(first.body.applied);

    const runs = await prisma.inventorySyncRun.count({ where: { connectorId } });
    expect(runs).toBe(1);

    const after = await prisma.variant.findUniqueOrThrow({ where: { id: variant.id } });
    expect(after.stock).toBe(3);
  });

  it("stores the source's cursor and only advances it on a processed batch", async () => {
    const { a, connectorId, secret, product, skuOf } = await connected();
    const variant = product.variants[0]!;

    await push(connectorId, secret, {
      idempotencyKey: "cursor-1", cursor: "page=1",
      rows: [{ sku: skuOf(variant), stock: 5 }],
    }).expect(201);

    let list = await a.get("/v1/inventory/connectors").expect(200);
    expect(list.body.connectors[0].cursor).toBe("page=1");

    // A malformed batch must not move the watermark, or the rows between the
    // two positions are lost.
    await push(connectorId, secret, { idempotencyKey: "cursor-2", rows: [] }).expect(422);

    list = await a.get("/v1/inventory/connectors").expect(200);
    expect(list.body.connectors[0].cursor).toBe("page=1");
  });

  // H-1 regression: the audit's actual reproduction. Unlike the malformed
  // batch above (a schema-level 422 that never reaches the transaction), this
  // batch IS processed -- it gets a 201 -- but every row is rejected, so
  // nothing is actually applied. The cursor must hold here too, or a source
  // resuming from the advanced position skips the rejected rows for good.
  it("does not advance the cursor when a processed batch is fully rejected", async () => {
    const { a, connectorId, secret, product, skuOf } = await connected();
    const variant = product.variants[0]!;

    // Establish a real held cursor first via a mapped, applied batch.
    const applied = await push(connectorId, secret, {
      idempotencyKey: "seq-5-applied", cursor: "seq=5",
      rows: [{ sku: skuOf(variant), stock: variant.stock + 1 }],
    }).expect(201);
    expect(applied.body.status).toBe("applied");

    let list = await a.get("/v1/inventory/connectors").expect(200);
    expect(list.body.connectors[0].cursor).toBe("seq=5");

    // Now a batch that reaches the transaction (well-formed) but rejects
    // every row: send a stock count below what is already reserved, via a
    // mapped SKU, so the row is rejected as `below_reserved` rather than
    // failing schema validation.
    await prisma.variant.update({ where: { id: variant.id }, data: { reserved: 10 } });

    const failed = await push(connectorId, secret, {
      idempotencyKey: "seq-6-all-rejected", cursor: "seq=6",
      rows: [{ sku: skuOf(variant), stock: 2 }], // 2 < reserved(10) -> below_reserved
    }).expect(201);

    expect(failed.body.status).toBe("failed");
    expect(failed.body.applied).toBe(0);
    expect(failed.body.rejected).toBe(1);

    list = await a.get("/v1/inventory/connectors").expect(200);
    expect(list.body.connectors[0].cursor).toBe("seq=5");

    // A subsequent applied batch that reports seq=6 again must still be
    // accepted and move the cursor on: the source can safely resume from
    // seq=5 and resend seq=6 once the exception is resolved.
    await prisma.variant.update({ where: { id: variant.id }, data: { reserved: 0 } });
    const retried = await push(connectorId, secret, {
      idempotencyKey: "seq-6-retry", cursor: "seq=6",
      rows: [{ sku: skuOf(variant), stock: 9 }],
    }).expect(201);
    expect(retried.body.status).toBe("applied");

    list = await a.get("/v1/inventory/connectors").expect(200);
    expect(list.body.connectors[0].cursor).toBe("seq=6");
  });

  it("leaves a variant alone when the source agrees with it", async () => {
    const { connectorId, secret, product, skuOf } = await connected();
    const variant = product.variants[0]!;

    const res = await push(connectorId, secret, {
      idempotencyKey: "no-change-1",
      rows: [{ sku: skuOf(variant), stock: variant.stock }],
    }).expect(201);

    expect(res.body.applied).toBe(0);
    expect(res.body.status).toBe("applied");
    expect(await prisma.twinEvent.count({ where: { type: "inventory_twin.corrected" } })).toBe(0);
  });
});

describe("the exception queue", () => {
  it("queues an unmapped SKU instead of dropping it", async () => {
    const { a, connectorId, secret } = await connected({ mapAll: false });

    const res = await push(connectorId, secret, {
      idempotencyKey: "unmapped-1",
      rows: [{ sku: "ACME-999", stock: 12 }],
    }).expect(201);

    expect(res.body.status).toBe("failed");
    expect(res.body.rejected).toBe(1);

    const queue = await a.get("/v1/inventory/exceptions").expect(200);
    expect(queue.body.exceptions).toHaveLength(1);
    expect(queue.body.exceptions[0]).toMatchObject({ kind: "unmapped_sku", externalSku: "ACME-999" });
  });

  it("refuses a count below what is already reserved", async () => {
    const { a, connectorId, secret, product, skuOf } = await connected();
    const variant = product.variants[0]!;
    await prisma.variant.update({ where: { id: variant.id }, data: { reserved: 6 } });

    const res = await push(connectorId, secret, {
      idempotencyKey: "below-reserved-1",
      rows: [{ sku: skuOf(variant), stock: 2 }],
    }).expect(201);

    expect(res.body.rejected).toBe(1);
    // The promised units survive: clamping here would let the twin sell them twice.
    const after = await prisma.variant.findUniqueOrThrow({ where: { id: variant.id } });
    expect(after.stock).toBe(variant.stock);

    const queue = await a.get("/v1/inventory/exceptions").expect(200);
    expect(queue.body.exceptions[0].kind).toBe("below_reserved");
  });

  it("queues a nonsense quantity and a SKU sent twice", async () => {
    const { a, connectorId, secret, product, skuOf } = await connected();
    const variant = product.variants[0]!;

    const res = await push(connectorId, secret, {
      idempotencyKey: "bad-rows-1",
      rows: [
        { sku: skuOf(variant), stock: 4 },
        { sku: skuOf(variant), stock: 9 },
        { sku: skuOf(product.variants[1]!), stock: -3 },
        { sku: skuOf(product.variants[2]!), stock: 2.5 },
      ],
    }).expect(201);

    expect(res.body.applied).toBe(0);
    expect(res.body.rejected).toBe(4);

    const queue = await a.get("/v1/inventory/exceptions").expect(200);
    const kinds = queue.body.exceptions.map((e: { kind: string }) => e.kind).sort();
    expect(kinds).toEqual(["ambiguous_sku", "ambiguous_sku", "invalid_quantity", "invalid_quantity"]);
  });

  it("still applies the good rows in a mixed batch", async () => {
    const { connectorId, secret, product, skuOf } = await connected();
    const good = product.variants[0]!;

    const res = await push(connectorId, secret, {
      idempotencyKey: "mixed-1",
      rows: [
        { sku: skuOf(good), stock: 11 },
        { sku: "NOT-MAPPED", stock: 4 },
      ],
    }).expect(201);

    expect(res.body.status).toBe("partial");
    expect(res.body.applied).toBe(1);
    expect(res.body.rejected).toBe(1);
    expect((await prisma.variant.findUniqueOrThrow({ where: { id: good.id } })).stock).toBe(11);
  });

  it("resolving by mapping fixes every repeat of that SKU and makes the next sync land", async () => {
    const { a, connectorId, secret, product } = await connected({ mapAll: false });
    const variant = product.variants[0]!;

    // A daily sync raises the same unmapped SKU every day.
    for (const key of ["day-1", "day-2", "day-3"]) {
      await push(connectorId, secret, { idempotencyKey: key, rows: [{ sku: "ACME-1", stock: 8 }] }).expect(201);
    }

    let queue = await a.get("/v1/inventory/exceptions").expect(200);
    expect(queue.body.exceptions).toHaveLength(3);

    const resolved = await a
      .post(`/v1/inventory/exceptions/${queue.body.exceptions[0].id}/resolve`)
      .send({ action: "map", variantId: variant.id })
      .expect(200);
    expect(resolved.body.resolved).toBe(3);

    queue = await a.get("/v1/inventory/exceptions").expect(200);
    expect(queue.body.exceptions).toHaveLength(0);

    // And the mapping actually works from here on.
    await push(connectorId, secret, { idempotencyKey: "day-4", rows: [{ sku: "ACME-1", stock: 8 }] }).expect(201);
    expect((await prisma.variant.findUniqueOrThrow({ where: { id: variant.id } })).stock).toBe(8);
  });

  it("dismisses a SKU this twin does not sell", async () => {
    const { a, connectorId, secret } = await connected({ mapAll: false });
    await push(connectorId, secret, { idempotencyKey: "d-1", rows: [{ sku: "GIFTCARD", stock: 0 }] }).expect(201);

    const queue = await a.get("/v1/inventory/exceptions").expect(200);
    await a.post(`/v1/inventory/exceptions/${queue.body.exceptions[0].id}/resolve`)
      .send({ action: "dismiss" }).expect(200);

    expect((await a.get("/v1/inventory/exceptions").expect(200)).body.exceptions).toHaveLength(0);
    // Dismissing records no mapping: the SKU stays unknown on purpose.
    expect(await prisma.inventoryMapping.count({ where: { connectorId } })).toBe(0);
  });

  it("will not resolve the same exception twice", async () => {
    const { a, connectorId, secret } = await connected({ mapAll: false });
    await push(connectorId, secret, { idempotencyKey: "once-1", rows: [{ sku: "ONCE", stock: 1 }] }).expect(201);

    const queue = await a.get("/v1/inventory/exceptions").expect(200);
    const id = queue.body.exceptions[0].id;

    await a.post(`/v1/inventory/exceptions/${id}/resolve`).send({ action: "dismiss" }).expect(200);
    await a.post(`/v1/inventory/exceptions/${id}/resolve`).send({ action: "dismiss" }).expect(409);
  });
});

describe("reconciliation", () => {
  it("reports a connector never synced as stale, not healthy", async () => {
    const { a } = await connected();
    const res = await a.get("/v1/inventory/connectors").expect(200);

    expect(res.body.connectors[0]).toMatchObject({ stale: true, healthy: false, status: "disconnected" });
  });

  it("reports healthy only with a recent sync and an empty queue", async () => {
    const { a, connectorId, secret, product, skuOf } = await connected();

    await push(connectorId, secret, {
      idempotencyKey: "healthy-1",
      rows: [{ sku: skuOf(product.variants[0]!), stock: 9 }],
    }).expect(201);

    let res = await a.get("/v1/inventory/connectors").expect(200);
    expect(res.body.connectors[0]).toMatchObject({ stale: false, healthy: true, openExceptions: 0 });

    await push(connectorId, secret, { idempotencyKey: "healthy-2", rows: [{ sku: "NOPE", stock: 1 }] }).expect(201);

    res = await a.get("/v1/inventory/connectors").expect(200);
    // Synced recently, but sitting on unresolved work: not healthy.
    expect(res.body.connectors[0]).toMatchObject({ stale: false, healthy: false, openExceptions: 1 });
  });

  it("counts the variants no connector covers", async () => {
    const { a, product } = await connected({ mapAll: false });
    const total = await prisma.variant.count({ where: { productId: { not: undefined }, product: { workspaceId: product.workspaceId } } });

    let res = await a.get("/v1/inventory/connectors").expect(200);
    expect(res.body.coverage).toMatchObject({ mappedVariants: 0, unmappedVariants: total });

    const list = await a.get("/v1/inventory/connectors").expect(200);
    await a.post(`/v1/inventory/connectors/${list.body.connectors[0].id}/mappings`)
      .send({ externalSku: "ONE", variantId: product.variants[0]!.id }).expect(201);

    res = await a.get("/v1/inventory/connectors").expect(200);
    expect(res.body.coverage).toMatchObject({ mappedVariants: 1, unmappedVariants: total - 1 });
  });
});

describe("inventory connector tenancy", () => {
  it("will not map a variant belonging to another workspace", async () => {
    const { a, connectorId } = await connected();

    const { user: other } = await createUser("other@test.local");
    const theirs = await createWorkspace({ userId: other.id, name: "Theirs", vertical: "marine" });
    const theirVariant = await prisma.variant.findFirstOrThrow({
      where: { product: { workspaceId: theirs.id } },
    });

    await a.post(`/v1/inventory/connectors/${connectorId}/mappings`)
      .send({ externalSku: "CROSS", variantId: theirVariant.id })
      .expect(422);
  });

  it("hides another workspace's connectors and exceptions", async () => {
    const { connectorId, secret } = await connected({ mapAll: false });
    await push(connectorId, secret, { leak: 1, idempotencyKey: "leak-0001", rows: [{ sku: "L", stock: 1 }] }).expect(201);

    const { user: other } = await createUser("other@test.local");
    await createWorkspace({ userId: other.id, name: "Theirs" });
    const b = await signedIn("other@test.local");

    expect((await b.get("/v1/inventory/connectors").expect(200)).body.connectors).toHaveLength(0);
    expect((await b.get("/v1/inventory/exceptions").expect(200)).body.exceptions).toHaveLength(0);
    await b.get(`/v1/inventory/connectors/${connectorId}/mappings`).expect(404);
    await b.delete(`/v1/inventory/connectors/${connectorId}`).expect(404);
  });

  it("needs a session for the operator routes", async () => {
    const { connectorId } = await connected();
    await agent().get("/v1/inventory/connectors").expect(401);
    await agent().get("/v1/inventory/exceptions").expect(401);
    await agent().post(`/v1/inventory/connectors/${connectorId}/rotate`).expect(401);
  });

  it("allows one connector per source", async () => {
    const { a } = await connected();
    await a.post("/v1/inventory/connectors").send({ source: "shopify", name: "Second" }).expect(409);
    await a.post("/v1/inventory/connectors").send({ source: "zoho", name: "Also fine" }).expect(201);
  });
});
