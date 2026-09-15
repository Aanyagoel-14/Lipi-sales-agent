import { json, route } from "@/server/lib/http";
import { after, paged, pageOf } from "@/server/lib/page";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { eventOut } from "../shapes";

export const GET = route(async (req) => {
  const workspaceId = await resolveWorkspaceId();
  const page = pageOf(req);
  const found = await prisma.twinEvent.findMany({
    where: { workspaceId, ...after("occurredAt", page) },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: page.take,
  });
  const { rows, nextCursor } = paged(found, page, (e) => e.occurredAt);
  return json({ nextCursor, events: rows.map(eventOut) });
});
