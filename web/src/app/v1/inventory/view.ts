import { env } from "@/server/env";
import { HttpError } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";

export const SOURCES = ["shopify", "woocommerce", "zoho", "erp", "pos", "custom"] as const;

/**
 * The secret is never returned after creation, only its presence — and an
 * OAuth connector's `accessToken` is not projected at all, at any stage. The
 * store's own domain is not a credential and the operator needs to see which
 * store they connected, so `externalId` comes back as `shop`.
 */
export const connectorView = (c: {
  id: string; source: string; name: string; status: string; cursor: string | null;
  lastSyncAt: Date | null; lastError: string | null; appliedCount: number; failedCount: number;
  externalId?: string | null;
}) => ({
  id: c.id, source: c.source, name: c.name, status: c.status, cursor: c.cursor,
  lastSyncIso: c.lastSyncAt?.toISOString() ?? null, lastError: c.lastError,
  appliedCount: c.appliedCount, failedCount: c.failedCount,
  shop: c.externalId ?? null,
  pushUrl: `${env.PUBLIC_URL}/v1/inventory/${c.id}/sync`,
});

export async function requireConnector(id: string, workspaceId: string) {
  const connector = await prisma.inventoryConnector.findFirst({ where: { id, workspaceId } });
  if (!connector) throw new HttpError(404, "Connector not found");
  return connector;
}
