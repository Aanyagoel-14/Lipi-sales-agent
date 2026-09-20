import { json, route } from "@/server/lib/http";
import { preflight } from "@/server/lib/origins";
import { after, paged, pageOf } from "@/server/lib/page";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { customerOut } from "../shapes";

/**
 * Customer twins, most recently active first.
 *
 * Ordered by `lastSeenAt` rather than lifetime value so it pages on the same
 * keyset rule as every other list here: a total order over a column that a
 * new row cannot insert itself into the middle of. A client that wants the
 * biggest spenders sorts what it has loaded — the dashboard does.
 */
export const GET = route(async (req) => {
  const workspaceId = await resolveWorkspaceId();
  const page = pageOf(req);

  const found = await prisma.customer.findMany({
    where: { workspaceId, ...after("lastSeenAt", page) },
    orderBy: [{ lastSeenAt: "desc" }, { id: "desc" }],
    take: page.take,
  });
  const { rows, nextCursor } = paged(found, page, (c) => c.lastSeenAt);

  return json({ nextCursor, customers: rows.map(customerOut) });
});

export const OPTIONS = route(preflight);
