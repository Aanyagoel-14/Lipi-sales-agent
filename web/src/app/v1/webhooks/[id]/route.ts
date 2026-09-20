import { env } from "@/server/env";
import { body, HttpError, json, route } from "@/server/lib/http";
import { recordEvent } from "@/server/lib/events";
import { preflight } from "@/server/lib/origins";
import { prisma } from "@/server/lib/prisma";
import { requireDeliverableUrl } from "@/server/lib/webhook-endpoint";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { updateWebhookBody } from "../../contract";
import { subscriptionView } from "../view";

/** One subscription. Every read and write is scoped by `workspaceId` as well
 *  as by id, so a guessed id from another tenant is a 404 and not a row. */
const mine = async (id: string) => {
  const workspaceId = await resolveWorkspaceId();
  const subscription = await prisma.webhookSubscription.findFirst({ where: { id, workspaceId } });
  if (!subscription) throw new HttpError(404, "No such webhook subscription");
  return { workspaceId, subscription };
};

export const GET = route<{ id: string }>(async (_req, { id }) =>
  json({ subscription: subscriptionView((await mine(id)).subscription) }),
);

export const PATCH = route<{ id: string }>(async (req, { id }) => {
  const { subscription } = await mine(id);
  const data = await body(req, updateWebhookBody, "Check the subscription");

  const url = data.url
    ? requireDeliverableUrl(data.url, env.NODE_ENV !== "production").toString()
    : undefined;

  const updated = await prisma.webhookSubscription.update({
    where: { id: subscription.id },
    data: { ...(url ? { url } : {}), ...(data.eventTypes ? { eventTypes: data.eventTypes } : {}),
            ...(data.active === undefined ? {} : { active: data.active }) },
  });

  return json({ subscription: subscriptionView(updated) });
});

/**
 * Deleted, not revoked — unlike an API key, which stays listed because what
 * called with it is worth keeping. A subscription's history is the delivery
 * rows, and those cascade with it: they are about an endpoint nobody will
 * ever call again.
 */
export const DELETE = route<{ id: string }>(async (_req, { id }) => {
  const { workspaceId, subscription } = await mine(id);

  await prisma.webhookSubscription.delete({ where: { id: subscription.id } });
  await recordEvent(workspaceId, "webhook.removed", "operations", new URL(subscription.url).host);

  return json({ subscription: subscriptionView(subscription) });
});

export const OPTIONS = route<{ id: string }>(preflight);
