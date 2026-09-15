import { json, route } from "@/server/lib/http";
import { after, paged, pageOf } from "@/server/lib/page";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { requireConnector } from "../../../view";

export const GET = route<{ id: string }>(async (req, { id }) => {
  const workspaceId = await resolveWorkspaceId();
  const connector = await requireConnector(id, workspaceId);
  const page = pageOf(req);

  const found = await prisma.inventorySyncRun.findMany({
    where: { connectorId: connector.id, ...after("startedAt", page) },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    take: page.take,
  });

  const { rows, nextCursor } = paged(found, page, (r) => r.startedAt);

  return json({
    nextCursor,
    runs: rows.map((r) => ({
      id: r.id, status: r.status, received: r.received, applied: r.applied,
      rejected: r.rejected, cursor: r.cursor, durationMs: r.durationMs,
      startedIso: r.startedAt.toISOString(), error: r.error, changes: r.changes,
    })),
  });
});
