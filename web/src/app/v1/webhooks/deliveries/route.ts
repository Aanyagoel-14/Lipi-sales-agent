import { json, route, searchParams } from "@/server/lib/http";
import { preflight } from "@/server/lib/origins";
import { after, paged, pageOf } from "@/server/lib/page";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { deliveryView } from "../view";

/**
 * What has been delivered, what is waiting, and what gave up — newest first.
 *
 * This is the screen an operator opens when a customer says "we stopped
 * seeing orders", so it is a log rather than a summary: the status code the
 * endpoint answered with and the attempt count are the two facts that settle
 * whose side the fault is on.
 *
 * `?status=dead` narrows it to the dead letter, and `?subscription=` to one
 * endpoint.
 */
export const GET = route(async (req) => {
  const workspaceId = await resolveWorkspaceId();
  const page = pageOf(req);
  const query = searchParams(req);

  const status = query.getAll("status").filter(isStatus);
  const subscriptionId = query.get("subscription");

  const found = await prisma.webhookDelivery.findMany({
    where: {
      workspaceId,
      ...(status.length ? { status: { in: status } } : {}),
      ...(subscriptionId ? { subscriptionId } : {}),
      ...after("createdAt", page),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: page.take,
  });
  const { rows, nextCursor } = paged(found, page, (d) => d.createdAt);

  return json({ nextCursor, deliveries: rows.map(deliveryView) });
});

const STATUSES = ["pending", "delivered", "dead"] as const;

/* An unknown status filters to nothing rather than 422ing: these are our own
 * names, and a caller polling `?status=dead` should not start failing the day
 * a fourth one is added. */
const isStatus = (value: string): value is (typeof STATUSES)[number] =>
  (STATUSES as readonly string[]).includes(value);

export const OPTIONS = route(preflight);
