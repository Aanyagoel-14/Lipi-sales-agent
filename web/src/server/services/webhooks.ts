import type { Prisma, WebhookDelivery, WebhookSubscription } from "@/generated/prisma/client";
import { decrypt, encrypt, newWebhookSecret, signWebhookBody } from "../lib/crypto";
import { prisma } from "../lib/prisma";
import { webhookPoster } from "../lib/webhook-endpoint";

/**
 * Outbound webhooks: the twin event log, delivered to a customer's own system.
 *
 * Every mutation in this codebase already appends to `TwinEvent`, so outbound
 * integration needs no new stream and no new write inside anybody's
 * transaction — it needs a *reader* of the log and a place to keep what it
 * has managed to hand over. That is the whole shape of this module, and it is
 * why nothing here touches an event row (invariant 6) and why nothing here is
 * reachable from `ingest()`.
 *
 * Two passes, run back to back by `dispatch()`:
 *
 *   enqueue  walks each subscription's cursor forward over the log and owes
 *            it a `WebhookDelivery` per matching event.
 *   deliver  takes the deliveries that are due, posts them, and either marks
 *            them delivered or pushes `nextAttemptAt` out by the backoff.
 *
 * Splitting them is what makes the second one safe to fail. A subscriber that
 * is down does not stop the queue growing correctly, and nothing is lost
 * because the debt was recorded before the first attempt was made.
 */

/**
 * Seconds to wait before attempt *n+1*, indexed by the attempt that failed.
 * Roughly three hours end to end: an endpoint that is down for a deploy or an
 * hour of cloud weather still gets its events, and one that is down for an
 * afternoon is a person's problem rather than a retry loop's.
 */
export const BACKOFF_SECONDS = [30, 120, 600, 1_800, 7_200];

/** Tries per delivery before it is dead: one per backoff, plus the first. */
export const MAX_ATTEMPTS = BACKOFF_SECONDS.length + 1;

/** Events read from the log in one enqueue pass, per subscription. */
const SCAN_LIMIT = 500;

/** Deliveries attempted in one dispatch, across the workspace. */
const DELIVER_LIMIT = 100;

export type DispatchSummary = {
  queued: number;
  delivered: number;
  /** Failed, but due again later. */
  retrying: number;
  dead: number;
};

/* ------------------------------------------------------------ subscribing */

export type SubscribeInput = { url: string; eventTypes?: string[] };

/**
 * A new subscription, and the one time its signing secret exists in plaintext.
 *
 * The cursor starts at the *end of the log*, not at the beginning. An endpoint
 * that has just been registered has no business receiving three months of
 * history it cannot tell apart from live traffic, and an integrator who wants
 * the history has `/v1/events`, which pages.
 *
 * The position is read off the newest event rather than off the wall clock.
 * `occurredAt` has millisecond resolution, so a subscription created in the
 * same millisecond as the event before it used to land on `(thatMillisecond,
 * "")` — a cursor that every event in that millisecond sorts *after*, which
 * replayed them. Naming the newest event makes the start exact whatever the
 * clock did, and an empty log still starts at now.
 */
export async function subscribe(workspaceId: string, input: SubscribeInput) {
  const secret = newWebhookSecret();
  const newest = await prisma.twinEvent.findFirst({
    where: { workspaceId },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    select: { occurredAt: true, id: true },
  });
  const subscription = await prisma.webhookSubscription.create({
    data: {
      workspaceId,
      url: input.url,
      eventTypes: input.eventTypes ?? [],
      secret: encrypt(secret),
      cursorAt: newest?.occurredAt ?? new Date(),
      cursorId: newest?.id ?? "",
    },
  });
  return { subscription, secret };
}

/* -------------------------------------------------------------- enqueuing */

/** Empty means every type. Otherwise the type has to be named exactly. */
const wants = (subscription: WebhookSubscription, type: string) =>
  subscription.eventTypes.length === 0 || subscription.eventTypes.includes(type);

/**
 * Owes every active subscription the events that have happened since it last
 * looked, and moves its cursor to the end of what it read.
 *
 * The cursor advances over events the subscription did *not* want as well as
 * the ones it did — otherwise a subscription filtered to one type rescans the
 * whole tail of the log on every tick for ever.
 *
 * `skipDuplicates` against `(subscriptionId, eventId)` is what makes a second
 * pass over the same window free rather than a double delivery, so a cursor
 * that failed to save is a retry and not a duplicate.
 */
export async function enqueue(workspaceId: string): Promise<number> {
  const subscriptions = await prisma.webhookSubscription.findMany({
    where: { workspaceId, active: true },
  });

  let queued = 0;
  for (const subscription of subscriptions) {
    const events = await prisma.twinEvent.findMany({
      where: { workspaceId, ...afterCursor(subscription) },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
      take: SCAN_LIMIT,
    });
    if (!events.length) continue;

    const owed = events.filter((event) => wants(subscription, event.type));
    if (owed.length) {
      const { count } = await prisma.webhookDelivery.createMany({
        data: owed.map((event) => ({
          workspaceId,
          subscriptionId: subscription.id,
          eventId: event.id,
          eventType: event.type,
          nextAttemptAt: new Date(),
        })),
        skipDuplicates: true,
      });
      queued += count;
    }

    const last = events[events.length - 1]!;
    await prisma.webhookSubscription.update({
      where: { id: subscription.id },
      data: { cursorAt: last.occurredAt, cursorId: last.id },
    });
  }

  return queued;
}

/** The keyset `page.ts` uses, walked forwards: `(occurredAt, id)` is total. */
const afterCursor = (subscription: WebhookSubscription): Prisma.TwinEventWhereInput => ({
  OR: [
    { occurredAt: { gt: subscription.cursorAt } },
    { occurredAt: subscription.cursorAt, id: { gt: subscription.cursorId } },
  ],
});

/* ------------------------------------------------------------- delivering */

/** What a subscriber receives. `event` is the same shape `/v1/events` serves. */
export type WebhookBody = {
  workspaceId: string;
  deliveryId: string;
  event: { id: string; atIso: string; type: string; twin: string; payload: string };
};

/**
 * Posts every delivery that is due, oldest first.
 *
 * Each one stands alone: a failure pushes that delivery's own
 * `nextAttemptAt` out and the loop carries on, so one dead endpoint cannot
 * hold up another subscription's queue — or its own later events. The cost is
 * that ordering is not guaranteed once anything has been retried, which is
 * why the body carries a stable event id and an `atIso` rather than a
 * sequence number the subscriber would have to trust.
 */
export async function deliverDue(workspaceId: string, now = new Date()) {
  const due = await prisma.webhookDelivery.findMany({
    where: { workspaceId, status: "pending", nextAttemptAt: { lte: now } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: DELIVER_LIMIT,
    include: { subscription: true },
  });

  const summary = { delivered: 0, retrying: 0, dead: 0 };

  for (const delivery of due) {
    // Paused mid-queue: leave it owed rather than attempt or discard it, so
    // resuming the subscription resumes its backlog too.
    if (!delivery.subscription.active) continue;

    const outcome = await attempt(delivery, delivery.subscription);
    summary[outcome] += 1;
  }

  return summary;
}

type Outcome = "delivered" | "retrying" | "dead";

async function attempt(
  delivery: WebhookDelivery,
  subscription: WebhookSubscription,
): Promise<Outcome> {
  const event = await prisma.twinEvent.findUnique({ where: { id: delivery.eventId } });
  // The log is append-only, so this is only reachable if the workspace itself
  // is being torn down under us. Nothing to deliver and nothing to retry.
  if (!event) {
    await close(delivery, "dead", { lastError: "The event is no longer in the log" });
    return "dead";
  }

  const body = JSON.stringify({
    workspaceId: delivery.workspaceId,
    deliveryId: delivery.id,
    event: {
      id: event.id,
      atIso: event.occurredAt.toISOString(),
      type: event.type,
      twin: event.twin,
      payload: event.payload,
    },
  } satisfies WebhookBody);

  const attempts = delivery.attempts + 1;
  const secret = decrypt(subscription.secret);
  // Only an APP_SECRET rotation can do this, and it is the same answer that
  // rotation gives a channel credential: the secret has to be re-issued.
  if (!secret) {
    await close(delivery, "dead", { attempts, lastError: "The signing secret cannot be read" });
    return "dead";
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const result = await webhookPoster()({
    url: subscription.url,
    headers: {
      "content-type": "application/json",
      "user-agent": "Lipi-Webhooks/1",
      "X-Lipi-Workspace": delivery.workspaceId,
      "X-Lipi-Event-Id": event.id,
      "X-Lipi-Event-Type": event.type,
      "X-Lipi-Delivery-Id": delivery.id,
      "X-Lipi-Attempt": String(attempts),
      "X-Lipi-Timestamp": String(timestamp),
      "X-Lipi-Signature": signWebhookBody(secret, timestamp, body),
    },
    body,
  });

  const now = new Date();
  const accepted = ok(result.status);
  const common = {
    attempts,
    lastAttemptAt: now,
    lastStatus: result.status,
    lastError: result.error ?? (accepted ? null : `The endpoint answered ${result.status}`),
  };

  if (accepted) {
    await close(delivery, "delivered", { ...common, deliveredAt: now });
    return "delivered";
  }

  if (!retryable(result.status) || attempts >= MAX_ATTEMPTS) {
    await close(delivery, "dead", common);
    return "dead";
  }

  await prisma.webhookDelivery.update({
    where: { id: delivery.id },
    data: { ...common, status: "pending", nextAttemptAt: dueAfter(now, attempts) },
  });
  return "retrying";
}

const ok = (status: number | null) => status !== null && status >= 200 && status < 300;

/**
 * A 5xx, a timeout or a dropped connection is the endpoint having a bad
 * minute, so it is retried. Any other 4xx is the endpoint saying this request
 * is wrong — a wrong path, a revoked route, a body it will never accept — and
 * three hours of retries will not make it right. 408 and 429 are the two 4xx
 * that genuinely mean "later".
 */
const retryable = (status: number | null) =>
  status === null || status >= 500 || status === 408 || status === 429;

/** When a delivery whose *n*th attempt just failed becomes due again. */
const dueAfter = (failedAt: Date, attempts: number) => {
  const wait = BACKOFF_SECONDS[Math.min(attempts, BACKOFF_SECONDS.length) - 1]!;
  return new Date(failedAt.getTime() + wait * 1000);
};

const close = (
  delivery: WebhookDelivery,
  status: "delivered" | "dead",
  data: Prisma.WebhookDeliveryUpdateInput,
) => prisma.webhookDelivery.update({ where: { id: delivery.id }, data: { ...data, status } });

/* ---------------------------------------------------------------- the tick */

/**
 * One pass of both halves. Lipi has no scheduler, so this is what a cron, a
 * platform timer or the operator's button calls — the same arrangement the
 * Shopify poll has, and the reason `/v1` takes an API key at all.
 */
export async function dispatch(workspaceId: string): Promise<DispatchSummary> {
  const queued = await enqueue(workspaceId);
  return { queued, ...(await deliverDue(workspaceId)) };
}

/**
 * Hands a finished delivery back to the queue.
 *
 * `attempts` resets, because a dead delivery redelivered under its old count
 * would exhaust itself on the first try and the button would appear not to
 * work. `deliveredAt` clears with it: a row that has been handed back to the
 * queue has not been delivered until it is delivered again, and leaving the
 * old timestamp on a row that then dies would say the opposite. What the row
 * keeps is the outcome of the attempt before it, which is what an operator is
 * looking at when they press this.
 */
export async function redeliver(workspaceId: string, id: string) {
  const { count } = await prisma.webhookDelivery.updateMany({
    where: { id, workspaceId, status: { in: ["delivered", "dead"] } },
    data: { status: "pending", attempts: 0, nextAttemptAt: new Date(), deliveredAt: null },
  });
  return count > 0;
}
