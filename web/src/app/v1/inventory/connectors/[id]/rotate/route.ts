import { HttpError, json, route } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { newConnectorSecret } from "@/server/services/inventory";
import { connectorView } from "../../../view";

/** Rotating is the only remedy for a leaked token, so it must not need support. */
export const POST = route<{ id: string }>(async (_req, { id }) => {
  const workspaceId = await resolveWorkspaceId();

  const existing = await prisma.inventoryConnector.findFirst({ where: { id, workspaceId } });
  if (!existing) throw new HttpError(404, "Connector not found");

  const { secret, hash } = newConnectorSecret();
  const connector = await prisma.inventoryConnector.update({ where: { id }, data: { secretHash: hash } });

  return json({ connector: connectorView(connector), secret });
});
