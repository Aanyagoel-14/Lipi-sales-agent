import { json, route } from "@/server/lib/http";
import { toRupees } from "@/server/lib/money";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";

export const GET = route(async () => {
  const workspaceId = await resolveWorkspaceId();
  const [rows, suppliers] = await Promise.all([
    prisma.product.findMany({ where: { workspaceId }, include: { variants: true }, orderBy: { name: "asc" } }),
    prisma.supplier.findMany({ where: { workspaceId } }),
  ]);

  return json({
    products: rows.map((p) => ({
      id: p.id, name: p.name, category: p.category,
      axes: p.axes as [string, string], attributes: p.attributes,
      priceInr: toRupees(p.price), marginPct: p.marginPct, leadTimeDays: p.leadTimeDays,
      supplierId: p.supplierId, crossSell: p.crossSell,
      variants: p.variants.map((v) => ({
        // The id is what an inventory mapping points at, so it has to leave
        // the API; a variant is not addressable by its option pair alone.
        id: v.id, optionA: v.optionA, optionB: v.optionB, stock: v.stock, reserved: v.reserved,
      })),
    })),
    suppliers,
  });
});
