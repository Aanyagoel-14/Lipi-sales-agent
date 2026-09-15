import { body, HttpError, json, route } from "@/server/lib/http";
import { toPaise, toRupees } from "@/server/lib/money";
import { prisma } from "@/server/lib/prisma";
import { generateSku } from "@/server/lib/sku";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { eventId } from "../../events";
import { productId, productSchema, supplierId } from "../schemas";

export const POST = route(async (req) => {
  const workspaceId = await resolveWorkspaceId();
  const data = await body(req, productSchema, "Check the product");

  const { variants, supplierId: chosenSupplier, priceInr, ...fields } = data;

  // A variant grid with the same pair twice would violate the unique index
  // and, worse, mean two different stock numbers for one sellable thing.
  const seen = new Set(variants.map((v) => `${v.optionA}|||${v.optionB}`));
  if (seen.size !== variants.length) {
    throw new HttpError(422, "Two variants share the same options");
  }

  if (chosenSupplier) {
    const supplier = await prisma.supplier.findFirst({ where: { id: chosenSupplier, workspaceId } });
    if (!supplier) throw new HttpError(422, "That supplier is not in this workspace");
  }

  const resolvedSupplier = chosenSupplier ?? (await ensureSupplier(workspaceId));

  const product = await prisma.product.create({
    data: {
      id: productId(), workspaceId, ...fields,
      price: toPaise(priceInr),
      crossSell: [],
      supplierId: resolvedSupplier,
      // L-1(d) fix: the SKU is generated once, here, from the name and
      // options as they stand right now, and stored — never rebuilt from
      // whatever the product happens to be called on a later read.
      variants: {
        create: variants.map((v) => ({ ...v, reserved: 0, sku: generateSku(fields.name, v.optionA, v.optionB) })),
      },
    },
    include: { variants: true },
  });

  await prisma.twinEvent.create({
    data: {
      id: eventId(), workspaceId, occurredAt: new Date(),
      type: "product_twin.created", twin: "product",
      payload: `${product.id} name="${product.name}" variants=${product.variants.length}`,
    },
  });

  return json({ product: { ...product, priceInr: toRupees(product.price) } }, 201);
});

async function ensureSupplier(workspaceId: string) {
  const existing = await prisma.supplier.findFirst({ where: { workspaceId }, select: { id: true } });
  if (existing) return existing.id;

  const created = await prisma.supplier.create({
    data: {
      id: supplierId(), workspaceId,
      name: "Unassigned", onTimePct: 100, avgLeadDays: 7, defectRatePct: 0, moq: 1, responseHours: 24,
    },
  });
  return created.id;
}
