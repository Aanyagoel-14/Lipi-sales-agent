import { HttpError, noContent, route } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";

export const DELETE = route<{ id: string }>(async (_req, { id: productId }) => {
  const workspaceId = await resolveWorkspaceId();

  const orders = await prisma.order.count({ where: { productId, workspaceId } });
  if (orders) {
    throw new HttpError(409, `${orders} order${orders === 1 ? "" : "s"} reference this product. Set its stock to zero instead.`);
  }

  const { count } = await prisma.product.deleteMany({ where: { id: productId, workspaceId } });
  if (!count) throw new HttpError(404, "Product not found");
  return noContent();
});
