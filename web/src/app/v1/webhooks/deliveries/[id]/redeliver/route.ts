import { HttpError, json, route } from "@/server/lib/http";
import { preflight } from "@/server/lib/origins";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { redeliver } from "@/server/services/webhooks";
import { deliveryView } from "../../../view";

/**
 * Puts a finished delivery back in the queue, for the endpoint that lost it.
 *
 * Only a delivery that is finished — delivered or dead — can be redelivered.
 * One that is still pending is already owed, so re-sending it would be a
 * second copy rather than a second try, and the button would be a way to
 * double-post rather than to recover.
 *
 * It queues; it does not send. `POST /v1/webhooks/dispatch` is what sends,
 * and keeping the two apart means the operator's click returns immediately
 * rather than waiting on somebody else's server.
 */
export const POST = route<{ id: string }>(async (_req, { id }) => {
  const workspaceId = await resolveWorkspaceId();

  if (!(await redeliver(workspaceId, id))) {
    const exists = await prisma.webhookDelivery.findFirst({
      where: { id, workspaceId },
      select: { id: true },
    });
    if (!exists) throw new HttpError(404, "No such delivery");
    throw new HttpError(409, "That delivery is already queued");
  }

  const delivery = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id } });
  return json({ delivery: deliveryView(delivery) });
});

export const OPTIONS = route<{ id: string }>(preflight);
