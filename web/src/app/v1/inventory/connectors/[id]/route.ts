import { HttpError, noContent, route } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { disconnect } from "@/server/services/shopify";

/**
 * Removing a connector has to leave nothing behind at the source either.
 *
 * A pushed connector holds only a hash, so deleting the row is the whole of
 * it. A Shopify one holds a real token and a pair of live webhook
 * subscriptions, and dropping the row without withdrawing those would leave
 * a credential and two callbacks nobody is accountable for — so the store is
 * disconnected first, and only then is the row deleted.
 */
export const DELETE = route<{ id: string }>(async (_req, { id }) => {
  const workspaceId = await resolveWorkspaceId();

  const connector = await prisma.inventoryConnector.findFirst({ where: { id, workspaceId } });
  if (!connector) throw new HttpError(404, "Connector not found");

  if (connector.source === "shopify" && connector.accessToken) await disconnect(connector);

  await prisma.inventoryConnector.delete({ where: { id: connector.id } });
  return noContent();
});
