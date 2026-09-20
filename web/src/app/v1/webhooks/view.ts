import type { z } from "zod";
import type { WebhookDelivery, WebhookSubscription } from "@/generated/prisma/client";
import type { webhookDeliveryShape, webhookSubscriptionShape } from "../contract";

/**
 * Subscriptions and deliveries, as the API and the dashboard see them.
 *
 * Typed as `z.infer` of the contract's schemas, the way `shapes.ts` is, so a
 * column that leaves the API without being described fails typecheck.
 *
 * The one thing these two projections exist to guarantee is the omission:
 * `secret` and `cursorId` never appear. The secret is shown once by the
 * create response and by nothing else, and the cursor is the queue's own
 * bookkeeping — an integrator who could read it would read it as a position
 * they can set.
 */
type Out<T extends z.ZodTypeAny> = z.infer<T>;

export const subscriptionView = (
  s: WebhookSubscription,
): Out<typeof webhookSubscriptionShape> => ({
  id: s.id,
  url: s.url,
  eventTypes: s.eventTypes,
  active: s.active,
  createdIso: s.createdAt.toISOString(),
  updatedIso: s.updatedAt.toISOString(),
});

export const deliveryView = (d: WebhookDelivery): Out<typeof webhookDeliveryShape> => ({
  id: d.id,
  subscriptionId: d.subscriptionId,
  eventId: d.eventId,
  eventType: d.eventType,
  status: d.status,
  attempts: d.attempts,
  nextAttemptIso: d.nextAttemptAt.toISOString(),
  lastStatus: d.lastStatus,
  lastError: d.lastError,
  lastAttemptIso: d.lastAttemptAt?.toISOString() ?? null,
  deliveredIso: d.deliveredAt?.toISOString() ?? null,
  createdIso: d.createdAt.toISOString(),
});
