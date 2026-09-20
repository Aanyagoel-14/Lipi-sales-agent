import { env } from "@/server/env";
import { body, json, route } from "@/server/lib/http";
import { recordEvent } from "@/server/lib/events";
import { preflight } from "@/server/lib/origins";
import { prisma } from "@/server/lib/prisma";
import { requireDeliverableUrl } from "@/server/lib/webhook-endpoint";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { subscribe } from "@/server/services/webhooks";
import { createWebhookBody } from "../contract";
import { subscriptionView } from "./view";

/**
 * Where this workspace's twin events are delivered.
 *
 * `/webhooks/*` at the app root is the other direction — what providers send
 * *to* Lipi. This is the mirror of it: what Lipi sends to a customer's own
 * system, off the same append-only event log the dashboard's twin events
 * screen reads. Nothing here writes an event into that log except the record
 * of the subscription itself.
 */

export const GET = route(async () => {
  const workspaceId = await resolveWorkspaceId();
  const subscriptions = await prisma.webhookSubscription.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
  });
  return json({ subscriptions: subscriptions.map(subscriptionView) });
});

export const POST = route(async (req) => {
  const workspaceId = await resolveWorkspaceId();
  const data = await body(req, createWebhookBody, "Check the subscription");
  const url = requireDeliverableUrl(data.url, env.NODE_ENV !== "production");

  const { subscription, secret } = await subscribe(workspaceId, {
    url: url.toString(),
    eventTypes: data.eventTypes,
  });

  // Recorded after the row exists, so it falls on the live side of the new
  // cursor: the first thing a fresh endpoint receives is the news that it was
  // subscribed, which is as good a delivery test as an integrator can get.
  await recordEvent(workspaceId, "webhook.subscribed", "operations", url.host);

  // Shown exactly once. Only the ciphertext is stored and no endpoint returns
  // it, so a lost secret is replaced by a new subscription rather than read back.
  return json({ subscription: subscriptionView(subscription), secret }, 201);
});

export const OPTIONS = route(preflight);
