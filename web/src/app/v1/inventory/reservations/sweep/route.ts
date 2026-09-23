import { json, route } from "@/server/lib/http";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { HOLD_HOURS, recordSweep, releaseExpiredReservations } from "@/server/services/reservations";

/**
 * `POST /v1/inventory/reservations/sweep` — give back the stock that lapsed.
 *
 * A cron tick, in the same shape as `POST /v1/webhooks/dispatch` and
 * `POST /v1/inventory/shopify/sync`: there is no scheduler in this deployment,
 * so an API key on a timer is what makes an unattended cadence possible.
 *
 * Scoped to one workspace, because a tick that swept every tenant would be a
 * tick any tenant could make expensive. Bounded to 500 orders a pass, for the
 * same reason. Idempotent: releasing clears `reservedUntil`, so a second pass
 * over the same window finds nothing.
 */
export const POST = route(async () => {
  const workspaceId = await resolveWorkspaceId();
  const { released, orders } = await releaseExpiredReservations(workspaceId);

  // Recorded even when it released nothing: an operator asking "did the sweep
  // run" is asking a different question from "did it find anything".
  await recordSweep(workspaceId, released);

  return json({ released, orders, holdHours: HOLD_HOURS });
});
