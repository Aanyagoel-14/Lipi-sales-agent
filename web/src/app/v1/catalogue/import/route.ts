import { body, HttpError, json, route } from "@/server/lib/http";
import { toPaise } from "@/server/lib/money";
import { prisma } from "@/server/lib/prisma";
import { generateSku } from "@/server/lib/sku";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { eventId } from "../../events";
import { importSchema, productId, supplierId } from "../schemas";

/**
 * Imports a variant-level CSV after the browser has parsed it. Grouping and
 * validation happen again here so a malformed file can never leave half a
 * catalogue behind. One transaction makes the import all-or-nothing.
 */
export const POST = route(async (req) => {
  const workspaceId = await resolveWorkspaceId();
  const data = await body(req, importSchema, "Check the catalogue file");

  const groups = new Map<string, typeof data.rows>();
  for (const row of data.rows) {
    const key = row.product.toLocaleLowerCase();
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  const existing = await prisma.product.findMany({ where: { workspaceId }, select: { name: true } });
  const existingNames = new Set(existing.map((p) => p.name.toLocaleLowerCase()));
  const duplicate = [...groups.keys()].find((name) => existingNames.has(name));
  if (duplicate) throw new HttpError(409, `A product named ${groups.get(duplicate)![0]!.product} already exists`);

  for (const rows of groups.values()) {
    const first = rows[0]!;
    if (rows.some((r) => r.axisAName !== first.axisAName || r.axisBName !== first.axisBName)) {
      throw new HttpError(422, `${first.product} uses inconsistent axis names`);
    }
    const pairs = new Set(rows.map((r) => `${r.axisAValue}|||${r.axisBValue}`));
    if (pairs.size !== rows.length) throw new HttpError(422, `${first.product} contains a duplicate variant`);
  }

  const result = await prisma.$transaction(async (tx) => {
    let supplier = await tx.supplier.findFirst({ where: { workspaceId }, select: { id: true } });
    if (!supplier) {
      supplier = await tx.supplier.create({
        data: {
          id: supplierId(), workspaceId,
          name: "Imported catalogue", onTimePct: 100, avgLeadDays: 7,
          defectRatePct: 0, moq: 1, responseHours: 24,
        },
        select: { id: true },
      });
    }

    let variants = 0;
    for (const rows of groups.values()) {
      const first = rows[0]!;
      const product = await tx.product.create({
        data: {
          id: productId(), workspaceId, name: first.product, category: first.category,
          axes: [first.axisAName, first.axisBName], attributes: {},
          price: toPaise(first.priceInr), marginPct: first.marginPct,
          leadTimeDays: first.leadTimeDays, supplierId: supplier.id, crossSell: [],
          // L-1(d) fix: stored once here rather than rebuilt on read.
          variants: {
            create: rows.map((r) => ({
              optionA: r.axisAValue, optionB: r.axisBValue,
              stock: r.stock, reserved: 0,
              sku: generateSku(first.product, r.axisAValue, r.axisBValue),
            })),
          },
        },
      });
      variants += rows.length;
      await tx.twinEvent.create({
        data: {
          id: eventId(),
          workspaceId, occurredAt: new Date(), type: "product_twin.imported", twin: "product",
          payload: `${product.id} name="${product.name}" variants=${rows.length} source=csv`,
        },
      });
    }

    await tx.workspace.update({ where: { id: workspaceId }, data: { catalogueSeeded: false } });
    return { products: groups.size, variants };
  }, { timeout: 30_000 });

  return json({ imported: result }, 201);
});
