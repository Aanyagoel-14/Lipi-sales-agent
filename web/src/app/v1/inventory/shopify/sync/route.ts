import { HttpError, json, route } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { syncStore } from "@/server/services/shopify";

/**
 * Runs one poll of the connected store.
 *
 * Lipi has no scheduler of its own, so the cadence is whoever calls this —
 * a cron, a platform timer, or the operator pressing the button. It takes a
 * session or an API key like the rest of `/v1`, which is what makes an
 * unattended cadence possible at all, and it is idempotent: a poll that finds
 * the same tail twice replays through `applySync()` rather than re-applying.
 */
export const POST = route(async () => {
  const workspaceId = await resolveWorkspaceId();

  const connector = await prisma.inventoryConnector.findUnique({
    where: { workspaceId_source: { workspaceId, source: "shopify" } },
  });
  if (!connector) throw new HttpError(404, "No Shopify store is connected");

  return json(await syncStore(connector));
});
