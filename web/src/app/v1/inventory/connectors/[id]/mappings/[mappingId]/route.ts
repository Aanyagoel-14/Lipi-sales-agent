import { HttpError, noContent, route } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { requireConnector } from "../../../../view";

export const DELETE = route<{ id: string; mappingId: string }>(async (_req, { id, mappingId }) => {
  const workspaceId = await resolveWorkspaceId();
  const connector = await requireConnector(id, workspaceId);

  const { count } = await prisma.inventoryMapping.deleteMany({
    where: { id: mappingId, connectorId: connector.id },
  });
  if (!count) throw new HttpError(404, "Mapping not found");
  return noContent();
});
