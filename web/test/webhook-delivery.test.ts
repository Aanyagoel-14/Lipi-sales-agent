import { beforeEach, describe, expect, it } from "vitest";
import { agent, createUser, createWorkspace, resetDatabase, signedIn } from "./helpers";
import { fakeEndpoint } from "./fakes/webhook-endpoint";
import { responses } from "@/app/v1/contract";
import { decrypt } from "@/server/lib/crypto";
import { prisma } from "@/server/lib/prisma";
import { recordEvent } from "@/server/lib/events";
import { ingest } from "@/server/services/ingest";
import {
  BACKOFF_SECONDS,
  MAX_ATTEMPTS,
  dispatch,
  enqueue,
  redeliver,
  subscribe,
} from "@/server/services/webhooks";

/**
 * Twin events, delivered to somebody else's server.
 *
 * The question under every test here is the same: can a subscriber trust what
 * arrived, and can it trust that nothing did not. So the assertions are about
 * the signature, about what the queue still owes after a failure, and — twice
 * over, because it is the invariant most easily broken by accident — about the
 * event log being exactly as long and exactly as unchanged afterwards as it
 * was before.
 */

const URL_A = "https://buyer.example.com/hooks/lipi";
const URL_B = "https://other.example.com/hooks/lipi";

let workspaceId: string;

async function setup() {
  const { user } = await createUser();
  const workspace = await createWorkspace({ userId: user.id });
  workspaceId = workspace.id;
  return workspace;
}

/** A second tenant, with its own catalogue, for the scoping tests. */
async function otherWorkspace() {
  const { user } = await createUser("second@test.local");
  return createWorkspace({ userId: user.id, name: "Other Co" });
}

/** The message that makes an order: the seeded catalogue has olive polos. */
const buy = (id = workspaceId, handle = "+91 90 000 0001") =>
  ingest({ workspaceId: id, channel: "whatsapp", handle, text: "I want 2 olive L polos" });

/** A snapshot of the whole event log, to prove nothing mutated it. */
const eventLog = () =>
  prisma.twinEvent.findMany({ orderBy: [{ occurredAt: "asc" }, { id: "asc" }] });

describe("outbound webhooks", () => {
  beforeEach(async () => {
    await resetDatabase();
    await setup();
  });

  describe("delivery", () => {
    it("delivers an order event to a subscribed URL, signed and verifiable", async () => {
      const { secret } = await subscribe(workspaceId, { url: URL_A });

      await buy();
      const summary = await dispatch(workspaceId);

      expect(summary.delivered).toBeGreaterThan(0);
      expect(summary.dead).toBe(0);

      const orderPost = fakeEndpoint.posts.find(
        (p) => p.headers["X-Lipi-Event-Type"] === "order_twin.created",
      );
      expect(orderPost, "no order_twin.created was delivered").toBeDefined();
      expect(orderPost!.url).toBe(URL_A);
      expect(fakeEndpoint.verify(orderPost!, secret)).toBe(true);

      const body = JSON.parse(orderPost!.body);
      expect(body.workspaceId).toBe(workspaceId);
      expect(body.event.type).toBe("order_twin.created");
      expect(body.event.id).toBe(orderPost!.headers["X-Lipi-Event-Id"]);
      expect(body.event.payload).toContain("status=quoted");
    });

    it("signs over the timestamp as well as the body, so a delivery cannot be replayed at a new time", async () => {
      const { secret } = await subscribe(workspaceId, { url: URL_A });
      await recordEvent(workspaceId, "order_twin.created", "order", "ord_1 status=quoted");
      await dispatch(workspaceId);

      const post = fakeEndpoint.posts[0]!;
      expect(fakeEndpoint.verify(post, secret)).toBe(true);

      // The same bytes, re-presented an hour later.
      const moved = { ...post, headers: { ...post.headers, "X-Lipi-Timestamp": "1" } };
      expect(fakeEndpoint.verify(moved, secret)).toBe(false);
    });

    it("never sends the signing secret, in the body or in a header", async () => {
      const { secret } = await subscribe(workspaceId, { url: URL_A });
      await recordEvent(workspaceId, "order_twin.created", "order", "ord_1");
      await dispatch(workspaceId);

      const post = fakeEndpoint.posts[0]!;
      expect(post.body).not.toContain(secret);
      expect(JSON.stringify(post.headers)).not.toContain(secret);
    });

    it("stores the secret encrypted rather than as a column anyone can read", async () => {
      const { secret, subscription } = await subscribe(workspaceId, { url: URL_A });
      const row = await prisma.webhookSubscription.findUniqueOrThrow({ where: { id: subscription.id } });

      expect(row.secret).not.toBe(secret);
      expect(decrypt(row.secret)).toBe(secret);
    });
  });

  describe("retries", () => {
    it("retries a 500 with backoff and dead-letters it after the configured attempts", async () => {
      await subscribe(workspaceId, { url: URL_A });
      await recordEvent(workspaceId, "order_twin.created", "order", "ord_1");
      fakeEndpoint.answer = 500;

      const first = await dispatch(workspaceId);
      expect(first.retrying).toBe(1);

      let row = await prisma.webhookDelivery.findFirstOrThrow({});
      expect(row.status).toBe("pending");
      expect(row.attempts).toBe(1);
      expect(row.lastStatus).toBe(500);
      // Not due again for the first backoff, so a tick right now does nothing.
      expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + (BACKOFF_SECONDS[0]! - 5) * 1000);

      await dispatch(workspaceId);
      expect(fakeEndpoint.posts).toHaveLength(1);

      // Walk the backoff by making each attempt due, rather than by waiting.
      for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt += 1) {
        await prisma.webhookDelivery.updateMany({ data: { nextAttemptAt: new Date(0) } });
        await dispatch(workspaceId);
        row = await prisma.webhookDelivery.findFirstOrThrow({});
        expect(row.attempts).toBe(attempt);
      }

      expect(fakeEndpoint.posts).toHaveLength(MAX_ATTEMPTS);
      expect(row.status).toBe("dead");
      expect(row.lastError).toContain("500");
      expect(row.deliveredAt).toBeNull();
    });

    it("backs off further on each attempt rather than hammering a downed endpoint", async () => {
      await subscribe(workspaceId, { url: URL_A });
      await recordEvent(workspaceId, "order_twin.created", "order", "ord_1");
      fakeEndpoint.answer = 503;

      const waits: number[] = [];
      for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
        await prisma.webhookDelivery.updateMany({ data: { nextAttemptAt: new Date(0) } });
        const before = Date.now();
        await dispatch(workspaceId);
        const row = await prisma.webhookDelivery.findFirstOrThrow({});
        waits.push(Math.round((row.nextAttemptAt.getTime() - before) / 1000));
      }

      expect(waits).toEqual(BACKOFF_SECONDS);
    });

    it("recovers: an endpoint that comes back gets the event it missed", async () => {
      await subscribe(workspaceId, { url: URL_A });
      await recordEvent(workspaceId, "order_twin.created", "order", "ord_1");

      fakeEndpoint.answer = 500;
      await dispatch(workspaceId);
      fakeEndpoint.answer = 200;
      await prisma.webhookDelivery.updateMany({ data: { nextAttemptAt: new Date(0) } });
      await dispatch(workspaceId);

      const row = await prisma.webhookDelivery.findFirstOrThrow({});
      expect(row.status).toBe("delivered");
      expect(row.deliveredAt).not.toBeNull();
      expect(row.attempts).toBe(2);
    });

    it("treats no answer at all as retryable, the way a 500 is", async () => {
      await subscribe(workspaceId, { url: URL_A });
      await recordEvent(workspaceId, "order_twin.created", "order", "ord_1");
      fakeEndpoint.fail = "No answer within 10s";

      const summary = await dispatch(workspaceId);

      expect(summary.retrying).toBe(1);
      const row = await prisma.webhookDelivery.findFirstOrThrow({});
      expect(row.lastStatus).toBeNull();
      expect(row.lastError).toBe("No answer within 10s");
    });

    it("does not retry a 404 — a wrong URL does not become right in three hours", async () => {
      await subscribe(workspaceId, { url: URL_A });
      await recordEvent(workspaceId, "order_twin.created", "order", "ord_1");
      fakeEndpoint.answer = 404;

      const summary = await dispatch(workspaceId);

      expect(summary.dead).toBe(1);
      expect(fakeEndpoint.posts).toHaveLength(1);
    });

    it("does retry a 429, which is the endpoint asking for later rather than refusing", async () => {
      await subscribe(workspaceId, { url: URL_A });
      await recordEvent(workspaceId, "order_twin.created", "order", "ord_1");
      fakeEndpoint.answer = 429;

      expect((await dispatch(workspaceId)).retrying).toBe(1);
    });

    it("keeps one dead endpoint from wedging another subscription's queue", async () => {
      await subscribe(workspaceId, { url: URL_A });
      await recordEvent(workspaceId, "order_twin.created", "order", "ord_1");
      fakeEndpoint.answer = 500;
      await dispatch(workspaceId);

      // A second endpoint, registered after the failure, still gets what
      // happens next while the first is waiting out its backoff.
      const { secret } = await subscribe(workspaceId, { url: URL_B });
      fakeEndpoint.answer = 200;
      await recordEvent(workspaceId, "order_twin.updated", "order", "ord_1 stage=paid");
      const summary = await dispatch(workspaceId);

      // Both endpoints got the new event. The first one's *older* delivery is
      // still waiting out its backoff, which is the point: a failure holds up
      // that delivery and nothing else.
      expect(summary.delivered).toBe(2);
      const post = fakeEndpoint.posts.find((p) => p.url === URL_B)!;
      expect(post).toBeDefined();
      expect(fakeEndpoint.verify(post, secret)).toBe(true);
      expect(await prisma.webhookDelivery.count({ where: { status: "pending", attempts: 1 } })).toBe(1);
    });
  });

  describe("the queue", () => {
    it("is at-least-once with a stable event id, and never owes the same event twice", async () => {
      await subscribe(workspaceId, { url: URL_A });
      await buy();

      await dispatch(workspaceId);
      const first = fakeEndpoint.posts.length;
      await dispatch(workspaceId);

      expect(fakeEndpoint.posts).toHaveLength(first);
      const rows = await prisma.webhookDelivery.findMany();
      expect(new Set(rows.map((r) => r.eventId)).size).toBe(rows.length);
      // Every delivery names the event it carries, which is what the
      // subscriber de-duplicates on.
      const events = await prisma.twinEvent.findMany({ select: { id: true } });
      const known = new Set(events.map((e) => e.id));
      expect(rows.every((r) => known.has(r.eventId))).toBe(true);
    });

    it("enqueues nothing twice even when the cursor is replayed", async () => {
      const { subscription } = await subscribe(workspaceId, { url: URL_A });
      await recordEvent(workspaceId, "order_twin.created", "order", "ord_1");

      expect(await enqueue(workspaceId)).toBe(1);
      // A cursor that failed to save is a repeated window, not a duplicate.
      await prisma.webhookSubscription.update({
        where: { id: subscription.id },
        data: { cursorAt: subscription.cursorAt, cursorId: subscription.cursorId },
      });
      expect(await enqueue(workspaceId)).toBe(0);
      expect(await prisma.webhookDelivery.count()).toBe(1);
    });

    it("starts at the moment of subscription, not at the beginning of the log", async () => {
      await recordEvent(workspaceId, "order_twin.created", "order", "before");
      await subscribe(workspaceId, { url: URL_A });
      await recordEvent(workspaceId, "order_twin.created", "order", "after");

      await dispatch(workspaceId);

      const payloads = fakeEndpoint.posts.map((p) => JSON.parse(p.body).event.payload);
      expect(payloads).toContain("after");
      expect(payloads).not.toContain("before");
    });

    it("sends only the types a subscription asked for", async () => {
      await subscribe(workspaceId, { url: URL_A, eventTypes: ["order_twin.created"] });
      await buy();

      await dispatch(workspaceId);

      const types = fakeEndpoint.posts.map((p) => p.headers["X-Lipi-Event-Type"]);
      expect(types).toEqual(["order_twin.created"]);
    });

    it("moves the cursor past events it filtered out, so the log is not rescanned for ever", async () => {
      const { subscription } = await subscribe(workspaceId, { url: URL_A, eventTypes: ["never.happens"] });
      await recordEvent(workspaceId, "order_twin.created", "order", "ord_1");

      await enqueue(workspaceId);

      const moved = await prisma.webhookSubscription.findUniqueOrThrow({ where: { id: subscription.id } });
      expect(moved.cursorAt.getTime()).toBeGreaterThan(subscription.cursorAt.getTime());
      expect(await prisma.webhookDelivery.count()).toBe(0);
    });

    it("owes a paused subscription nothing, and hands back its backlog when it resumes", async () => {
      const { subscription } = await subscribe(workspaceId, { url: URL_A });
      await recordEvent(workspaceId, "order_twin.created", "order", "queued");
      await enqueue(workspaceId);

      await prisma.webhookSubscription.update({ where: { id: subscription.id }, data: { active: false } });
      await recordEvent(workspaceId, "order_twin.updated", "order", "while paused");
      await dispatch(workspaceId);
      expect(fakeEndpoint.posts).toHaveLength(0);

      await prisma.webhookSubscription.update({ where: { id: subscription.id }, data: { active: true } });
      await dispatch(workspaceId);

      const payloads = fakeEndpoint.posts.map((p) => JSON.parse(p.body).event.payload);
      expect(payloads).toContain("queued");
      expect(payloads).toContain("while paused");
    });

    it("redelivers a dead delivery on request, and only a finished one", async () => {
      await subscribe(workspaceId, { url: URL_A });
      await recordEvent(workspaceId, "order_twin.created", "order", "ord_1");
      fakeEndpoint.answer = 404;
      await dispatch(workspaceId);

      const dead = await prisma.webhookDelivery.findFirstOrThrow({});
      fakeEndpoint.answer = 200;
      expect(await redeliver(workspaceId, dead.id)).toBe(true);
      // Pending already: redelivering it would double-send, not re-send.
      expect(await redeliver(workspaceId, dead.id)).toBe(false);

      await dispatch(workspaceId);
      const row = await prisma.webhookDelivery.findFirstOrThrow({});
      expect(row.status).toBe("delivered");
      expect(row.attempts).toBe(1);
    });
  });

  describe("the invariants", () => {
    it("never updates or deletes a twin event", async () => {
      await subscribe(workspaceId, { url: URL_A });
      await buy();
      const before = await eventLog();

      fakeEndpoint.answer = 500;
      await dispatch(workspaceId);
      await prisma.webhookDelivery.updateMany({ data: { nextAttemptAt: new Date(0) } });
      fakeEndpoint.answer = 200;
      await dispatch(workspaceId);

      const after = await eventLog();
      expect(after).toEqual(before);
    });

    it("does not deliver from inside ingest's transaction", async () => {
      await subscribe(workspaceId, { url: URL_A });

      await buy();

      // `ingest()` has committed and the order exists, but nothing has been
      // posted: the debt is not even recorded until something ticks.
      expect(await prisma.order.count()).toBe(1);
      expect(fakeEndpoint.posts).toHaveLength(0);
      expect(await prisma.webhookDelivery.count()).toBe(0);
    });

    it("cannot deliver another tenant's events", async () => {
      const other = await otherWorkspace();
      await subscribe(workspaceId, { url: URL_A });
      await subscribe(other.id, { url: URL_B });

      await buy(other.id, "+919800000001");
      await dispatch(workspaceId);

      expect(fakeEndpoint.posts).toHaveLength(0);
      expect(await prisma.webhookDelivery.count({ where: { workspaceId } })).toBe(0);

      await dispatch(other.id);
      expect(fakeEndpoint.posts.length).toBeGreaterThan(0);
      for (const post of fakeEndpoint.posts) {
        expect(post.url).toBe(URL_B);
        expect(post.headers["X-Lipi-Workspace"]).toBe(other.id);
      }
    });

    it("will not redeliver another tenant's delivery", async () => {
      const other = await otherWorkspace();
      await subscribe(other.id, { url: URL_B });
      await recordEvent(other.id, "order_twin.created", "order", "ord_1");
      fakeEndpoint.answer = 404;
      await dispatch(other.id);

      const theirs = await prisma.webhookDelivery.findFirstOrThrow({});
      expect(await redeliver(workspaceId, theirs.id)).toBe(false);
    });
  });

  describe("the endpoints", () => {
    let api: Awaited<ReturnType<typeof signedIn>>;

    beforeEach(async () => {
      api = await signedIn();
    });

    it("creates a subscription and shows its secret exactly once", async () => {
      const created = await api
        .post("/v1/webhooks")
        .send({ url: URL_A, eventTypes: ["order_twin.created"] })
        .expect(201);

      expect(created.body.secret).toMatch(/.{20,}/);
      expect(created.body.subscription.url).toBe(URL_A);
      expect(created.body.subscription.eventTypes).toEqual(["order_twin.created"]);
      expect(created.body.subscription.secret).toBeUndefined();

      expect(responses.webhookCreated.safeParse(created.body).success).toBe(true);

      const listed = await api.get("/v1/webhooks").expect(200);
      expect(listed.body.subscriptions).toHaveLength(1);
      expect(JSON.stringify(listed.body)).not.toContain(created.body.secret);
      expect(responses.webhookList.safeParse(listed.body).success).toBe(true);
    });

    it("refuses a URL a signed body has no business going to", async () => {
      await api.post("/v1/webhooks").send({ url: "http://buyer.example.com/hooks" }).expect(422);
      await api.post("/v1/webhooks").send({ url: "https://10.0.0.5/hooks" }).expect(422);
      await api.post("/v1/webhooks").send({ url: "not a url" }).expect(422);
    });

    it("pauses, repoints and deletes a subscription", async () => {
      const { body } = await api.post("/v1/webhooks").send({ url: URL_A }).expect(201);
      const id = body.subscription.id;

      const paused = await api.patch(`/v1/webhooks/${id}`).send({ active: false }).expect(200);
      expect(paused.body.subscription.active).toBe(false);

      const moved = await api.patch(`/v1/webhooks/${id}`).send({ url: URL_B }).expect(200);
      expect(moved.body.subscription.url).toBe(URL_B);

      await api.delete(`/v1/webhooks/${id}`).expect(200);
      expect(await prisma.webhookSubscription.count()).toBe(0);
    });

    it("ticks, lists deliveries and redelivers one", async () => {
      await api.post("/v1/webhooks").send({ url: URL_A }).expect(201);
      await recordEvent(workspaceId, "order_twin.created", "order", "ord_1");
      fakeEndpoint.answer = 500;

      const ticked = await api.post("/v1/webhooks/dispatch").expect(200);
      expect(ticked.body).toMatchObject({ queued: 2, retrying: 2 });
      expect(responses.webhookDispatch.safeParse(ticked.body).success).toBe(true);

      const listed = await api.get("/v1/webhooks/deliveries").expect(200);
      expect(responses.webhookDeliveryList.safeParse(listed.body).success).toBe(true);
      expect(listed.body.deliveries).toHaveLength(2);
      expect(listed.body.deliveries[0].status).toBe("pending");
      expect(listed.body.deliveries[0].lastStatus).toBe(500);

      fakeEndpoint.answer = 200;
      const id = listed.body.deliveries[0].id;
      // Pending, not finished: there is nothing to re-send yet.
      await api.post(`/v1/webhooks/deliveries/${id}/redeliver`).expect(409);

      await prisma.webhookDelivery.updateMany({ data: { status: "dead" } });
      await api.post(`/v1/webhooks/deliveries/${id}/redeliver`).expect(200);
      await api.post("/v1/webhooks/dispatch").expect(200);

      const row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe("delivered");
    });

    it("scopes every endpoint to the caller's workspace", async () => {
      const other = await otherWorkspace();
      const { subscription } = await subscribe(other.id, { url: URL_B });

      await api.get(`/v1/webhooks/${subscription.id}`).expect(404);
      await api.patch(`/v1/webhooks/${subscription.id}`).send({ active: false }).expect(404);
      await api.delete(`/v1/webhooks/${subscription.id}`).expect(404);

      const listed = await api.get("/v1/webhooks").expect(200);
      expect(listed.body.subscriptions).toHaveLength(0);
    });

    it("needs a credential", async () => {
      const anonymous = agent();
      await anonymous.get("/v1/webhooks").expect(401);
      await anonymous.post("/v1/webhooks").send({ url: URL_A }).expect(401);
      await anonymous.post("/v1/webhooks/dispatch").expect(401);
    });
  });
});
