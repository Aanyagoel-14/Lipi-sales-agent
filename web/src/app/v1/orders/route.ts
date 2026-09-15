import { json, route } from "@/server/lib/http";
import { toRupees } from "@/server/lib/money";
import { after, paged, pageOf } from "@/server/lib/page";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";

export const GET = route(async (req) => {
  const workspaceId = await resolveWorkspaceId();
  const page = pageOf(req);
  const found = await prisma.order.findMany({
    where: { workspaceId, ...after("createdAt", page) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: { customer: { select: { name: true } }, product: { select: { name: true } } },
    take: page.take,
  });
  const { rows, nextCursor } = paged(found, page, (o) => o.createdAt);

  return json({
    nextCursor,
    orders: rows.map((o) => ({
      id: o.id, customerId: o.customerId, productId: o.productId, variant: o.variant,
      qty: o.qty, valueInr: toRupees(o.value), stage: o.stage, channel: o.channel,
      createdIso: o.createdAt.toISOString(), blocked: o.blocked ?? undefined,
      customerName: o.customer.name, productName: o.product.name,
    })),
  });
});
