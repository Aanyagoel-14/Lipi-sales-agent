import { createHash, timingSafeEqual } from "node:crypto";
import { env } from "@/server/env";
import { HttpError, json, route } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { recordSweep, releaseExpiredReservations } from "@/server/services/reservations";
import { dispatch } from "@/server/services/webhooks";

/**
 * The scheduled tick, for Cloud Scheduler (or any cron) to call every few
 * minutes with `Authorization: Bearer $CRON_SECRET`.
 *
 * Two jobs nothing else runs on time. A purchase order's stock hold lapses
 * after `HOLD_HOURS`, but was only released when somebody opened the Orders
 * page or called the per-workspace sweep, so a quiet workspace kept that
 * stock locked and the twin told customers it was gone. Outbound webhooks
 * were queued and retried only when `/v1/webhooks/dispatch` was called. Both
 * are idempotent per workspace, so a tick that overlaps the last one, or a
 * page load that ran the sweep first, does no harm.
 *
 * Every tenant in one call, which is why it answers to a deployment secret
 * rather than a session: no user belongs to all of them.
 */
export const POST = route(async (req) => {
  if (!env.CRON_SECRET) throw new HttpError(503, "The scheduled tick is not configured (CRON_SECRET is empty)");
  if (!matches(req.headers.get("authorization") ?? "", `Bearer ${env.CRON_SECRET}`)) {
    throw new HttpError(401, "Not authorised");
  }

  const workspaces = await prisma.workspace.findMany({ select: { id: true }, orderBy: { createdAt: "asc" } });
  let released = 0;
  let delivered = 0;
  const failed: string[] = [];

  for (const { id } of workspaces) {
    // One tenant's failure is that tenant's, not every tenant's after it.
    try {
      const sweep = await releaseExpiredReservations(id);
      // Recorded only when it found something: on a tick every few minutes,
      // "ran and found nothing" would bury each workspace's trail.
      if (sweep.released) await recordSweep(id, sweep.released);
      released += sweep.released;
      delivered += (await dispatch(id)).delivered;
    } catch (error) {
      failed.push(id);
      console.error(`[cron] workspace ${id}: ${(error as Error).message}`);
    }
  }

  return json({ workspaces: workspaces.length, released, delivered, failed });
});

/** Compared as digests, so neither the length nor the content leaks through timing. */
function matches(presented: string, expected: string) {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(presented), digest(expected));
}
