import { beforeEach, describe, expect, it } from "vitest";
import { createUser, createWorkspace, resetDatabase, signedIn } from "./helpers";
import { parseCatalogueCsv } from "@/lib/catalogue-import";
import { prisma } from "@/server/lib/prisma";
import { buildGrounding } from "@/server/services/briefing";

let workspaceId: string;

const product = (over: Record<string, unknown> = {}) => ({
  name: "Merino Crew", category: "Knitwear", axes: ["Size", "Colour"],
  priceInr: 3200, marginPct: 45, leadTimeDays: 10, supplierId: null, attributes: {},
  variants: [
    { optionA: "M", optionB: "Charcoal", stock: 12 },
    { optionA: "L", optionB: "Charcoal", stock: 8 },
  ],
  ...over,
});

beforeEach(async () => {
  await resetDatabase();
  const { user } = await createUser();
  workspaceId = (await createWorkspace({ userId: user.id })).id;
});

describe("adding a product", () => {
  it("creates one variant per option pair", async () => {
    const a = await signedIn();
    const res = await a.post("/v1/catalogue/products").send(product()).expect(201);
    expect(res.body.product.variants).toHaveLength(2);
  });

  it("makes it immediately answerable by the twin", async () => {
    const a = await signedIn();
    await a.post("/v1/catalogue/products").send(product()).expect(201);

    const res = await a.post("/v1/messages")
      .send({ channel: "whatsapp", handle: "+91 1", text: "do you have the merino crew in M charcoal" })
      .expect(201);

    expect(res.body.matched?.product).toBe("Merino Crew");
  });

  // Two rows for one sellable thing would mean two different stock numbers.
  it("refuses a duplicated option pair", async () => {
    const a = await signedIn();
    await a.post("/v1/catalogue/products")
      .send(product({ variants: [
        { optionA: "M", optionB: "Navy", stock: 1 },
        { optionA: "M", optionB: "Navy", stock: 2 },
      ] }))
      .expect(422);
  });

  it("rejects a product with no variants", async () => {
    const a = await signedIn();
    await a.post("/v1/catalogue/products").send(product({ variants: [] })).expect(422);
  });

  // L-1(d): the SKU is generated once at creation and stored, not rebuilt
  // from the product's current name on every read. Renaming the product
  // must not change a SKU already handed to an inventory connector or
  // written into a past event payload.
  it("stores a SKU that survives a later product rename", async () => {
    const a = await signedIn();
    const res = await a.post("/v1/catalogue/products").send(product()).expect(201);
    const created = await prisma.variant.findFirstOrThrow({
      where: { productId: res.body.product.id, optionA: "M", optionB: "Charcoal" },
    });
    expect(created.sku).toBe("MERINO-CREW-M-CHARCOAL");

    await prisma.product.update({ where: { id: res.body.product.id }, data: { name: "Merino Crew V2" } });

    const afterRename = await prisma.variant.findUniqueOrThrow({ where: { id: created.id } });
    expect(afterRename.sku).toBe("MERINO-CREW-M-CHARCOAL");
  });
});

describe("importing real catalogue data", () => {
  it("groups variant rows into products in one import", async () => {
    const a = await signedIn();
    const res = await a.post("/v1/catalogue/import").send({ rows: [
      { product: "Canvas Tote", category: "Bags", axisAName: "Size", axisAValue: "One size", axisBName: "Colour", axisBValue: "Natural", priceInr: 800, stock: 20, marginPct: 30, leadTimeDays: 4 },
      { product: "Canvas Tote", category: "Bags", axisAName: "Size", axisAValue: "One size", axisBName: "Colour", axisBValue: "Black", priceInr: 800, stock: 12, marginPct: 30, leadTimeDays: 4 },
    ] }).expect(201);

    expect(res.body.imported).toEqual({ products: 1, variants: 2 });
    const imported = await prisma.product.findFirstOrThrow({ where: { workspaceId, name: "Canvas Tote" }, include: { variants: true } });
    expect(imported.variants).toHaveLength(2);
  });

  it("rejects the whole file when a variant is duplicated", async () => {
    const a = await signedIn();
    const row = { product: "Canvas Tote", category: "Bags", axisAName: "Size", axisAValue: "One size", axisBName: "Colour", axisBValue: "Black", priceInr: 800, stock: 12, marginPct: 30, leadTimeDays: 4 };
    await a.post("/v1/catalogue/import").send({ rows: [row, row] }).expect(422);
    expect(await prisma.product.count({ where: { workspaceId, name: "Canvas Tote" } })).toBe(0);
  });
});

describe("the downloadable template", () => {
  it("is written by the server with the currency filled in", async () => {
    const a = await signedIn();
    const res = await a.get("/v1/catalogue/import/template").expect(200);

    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    const [header, ...rows] = res.text.split("\n");
    expect(header).toBe("product,category,size,colour,price_inr,currency,stock,margin_pct,lead_time_days,description");
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.split(",")[5]).toBe("INR");
  });

  it("imports exactly as downloaded", async () => {
    const a = await signedIn();
    // Renamed only because the test workspace already sells a Polo Classic.
    const csv = (await a.get("/v1/catalogue/import/template").expect(200)).text.replaceAll("Polo Classic", "Pique Polo");
    await a.post("/v1/catalogue/import").send({ rows: parseCatalogueCsv(csv) }).expect(201);

    const imported = await prisma.product.findFirstOrThrow({ where: { workspaceId, name: "Pique Polo" }, include: { variants: true } });
    expect(imported.axes).toEqual(["Size", "Colour"]);
    expect(imported.variants.map((v) => `${v.optionA}/${v.optionB}`).sort()).toEqual(["L/Olive", "XL/Olive"]);
    expect(imported.description).toBe("Pique cotton polo with a two-button placket.");
  });
});

describe("importing a currency and a description", () => {
  const tote = (over: Record<string, unknown> = {}) => ({
    product: "Canvas Tote", category: "Bags", axisAName: "Size", axisAValue: "One size", axisBName: "Colour",
    axisBValue: "Black", priceInr: 800, stock: 12, marginPct: 30, leadTimeDays: 4, ...over,
  });

  it("refuses a file priced in another currency, and writes nothing", async () => {
    const a = await signedIn();
    const res = await a.post("/v1/catalogue/import").send({ rows: [tote({ currency: "usd" })] }).expect(422);

    expect(res.body.error).toMatch(/USD.*INR/);
    expect(await prisma.product.count({ where: { workspaceId, name: "Canvas Tote" } })).toBe(0);
  });

  it("keeps the first description a product's rows give", async () => {
    const a = await signedIn();
    await a.post("/v1/catalogue/import").send({ rows: [
      tote({ axisBValue: "Natural", currency: "INR" }),
      tote({ description: "Heavy cotton canvas, fits a laptop." }),
    ] }).expect(201);

    const imported = await prisma.product.findFirstOrThrow({ where: { workspaceId, name: "Canvas Tote" } });
    expect(imported.description).toBe("Heavy cotton canvas, fits a laptop.");
  });

  it("puts the description in front of the salesperson", async () => {
    const a = await signedIn();
    await a.post("/v1/catalogue/import").send({ rows: [tote({ description: "Heavy cotton canvas, fits a laptop." })] }).expect(201);

    const grounding = await buildGrounding(workspaceId, { text: "tell me about the canvas tote", intent: "support", matched: null });
    expect(grounding.text).toContain("About it: Heavy cotton canvas, fits a laptop.");
  });
});

describe("correcting stock", () => {
  it("updates the figure and records why", async () => {
    const a = await signedIn();
    const created = await a.post("/v1/catalogue/products").send(product()).expect(201);
    const id = created.body.product.id;

    const res = await a.put(`/v1/catalogue/products/${id}/stock`)
      .send({ variants: [{ optionA: "M", optionB: "Charcoal", stock: 40 }] })
      .expect(200);

    expect(res.body.updated).toBe(1);
    const events = await prisma.twinEvent.findMany({ where: { workspaceId, type: "inventory_twin.corrected" } });
    expect(events[0]?.payload).toContain("12->40");
  });
});

describe("deleting a product", () => {
  it("refuses while orders reference it", async () => {
    const a = await signedIn();
    await a.post("/v1/messages")
      .send({ channel: "whatsapp", handle: "+91 2", text: "I want 2 olive L polos" })
      .expect(201);

    const order = await prisma.order.findFirstOrThrow({ where: { workspaceId } });
    await a.delete(`/v1/catalogue/products/${order.productId}`).expect(409);
  });

  it("allows it when nothing references it", async () => {
    const a = await signedIn();
    const created = await a.post("/v1/catalogue/products").send(product()).expect(201);
    await a.delete(`/v1/catalogue/products/${created.body.product.id}`).expect(204);
  });
});
