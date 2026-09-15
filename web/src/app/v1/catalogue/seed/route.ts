import { HttpError, json, route } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { provisionCatalogue } from "@/server/services/provision";

/** Loads the vertical's demo catalogue into a workspace that started empty. */
export const POST = route(async () => {
  const workspaceId = await resolveWorkspaceId();
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });

  const existing = await prisma.product.count({ where: { workspaceId } });
  if (existing) throw new HttpError(409, "This workspace already has products");

  const { products } = await prisma.$transaction(
    (tx) => provisionCatalogue(tx, workspaceId, workspace.vertical),
    { timeout: 30_000 },
  );

  await prisma.workspace.update({ where: { id: workspaceId }, data: { catalogueSeeded: true } });
  return json({ products: products.length }, 201);
});
