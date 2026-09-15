import { json, route, searchParams } from "@/server/lib/http";
import { after, paged, pageOf } from "@/server/lib/page";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";

export const GET = route(async (req) => {
  const workspaceId = await resolveWorkspaceId();
  const page = pageOf(req);
  const open = searchParams(req).get("state") !== "all";

  const found = await prisma.inventoryException.findMany({
    where: {
      connector: { workspaceId },
      ...(open ? { resolvedAt: null } : {}),
      ...after("raisedAt", page),
    },
    include: { connector: { select: { id: true, source: true, name: true } } },
    orderBy: [{ raisedAt: "desc" }, { id: "desc" }],
    take: page.take,
  });

  const { rows, nextCursor } = paged(found, page, (e) => e.raisedAt);

  return json({
    nextCursor,
    exceptions: rows.map((e) => ({
      id: e.id, kind: e.kind, externalSku: e.externalSku, detail: e.detail,
      payload: e.payload, raisedIso: e.raisedAt.toISOString(),
      resolvedIso: e.resolvedAt?.toISOString() ?? null, resolvedBy: e.resolvedBy,
      connectorId: e.connector.id, connectorName: e.connector.name, source: e.connector.source,
    })),
  });
});
