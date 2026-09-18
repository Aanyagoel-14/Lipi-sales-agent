import { beforeEach, describe, expect, it } from "vitest";
import { agent, createUser, createWorkspace, resetDatabase } from "./helpers";
import { fakeComposio } from "./fakes/composio";
import { prisma } from "@/server/lib/prisma";

/**
 * The project-level webhook. One URL for every workspace, so the only thing
 * standing between a stranger and a tenant's connection state is the
 * signature — which is why the rejections are tested as hard as the
 * successes, and why everything that verifies is answered 2xx even when
 * there is nothing to do with it.
 */

const ACCOUNT = "ca_live_account";
const TRIGGER = "ti_live_trigger";

let workspaceId: string;

beforeEach(async () => {
  await resetDatabase();
  const { user } = await createUser();
  const workspace = await createWorkspace({ userId: user.id });
  workspaceId = workspace.id;

  await prisma.channelConnection.create({
    data: {
      workspaceId, channel: "email", status: "connected",
      externalId: "sales@acme.test", displayName: "sales@acme.test",
      composioAccountId: ACCOUNT, composioAuthConfigId: "ac_test_gmail",
      composioTriggerIds: [TRIGGER], connectedAt: new Date(),
    },
  });
});

const post = (delivery: { body: string; headers: Record<string, string> }) => {
  const request = agent().post("/webhooks/composio").send(delivery.body);
  for (const [key, value] of Object.entries(delivery.headers)) request.set(key, value);
  return request;
};

const expired = (id = ACCOUNT) => ({
  type: "composio.connected_account.expired",
  data: { id, status: "EXPIRED", status_reason: "The refresh token was revoked", user_id: "ws" },
});

const emailRow = () => prisma.channelConnection.findFirst({ where: { workspaceId, channel: "email" } });
const events = (type: string) => prisma.twinEvent.findMany({ where: { workspaceId, type } });

describe("delivery authentication", () => {
  it("accepts a correctly signed delivery", async () => {
    await post(fakeComposio.sign(expired())).expect(200);
  });

  it("rejects a tampered body", async () => {
    const delivery = fakeComposio.sign(expired());
    await post({ ...delivery, body: delivery.body.replace("EXPIRED", "ACTIVE") }).expect(401);
  });

  it("rejects a delivery signed with another secret", async () => {
    const delivery = fakeComposio.sign(expired());
    fakeComposio.webhookSecret = "a-different-secret-entirely";
    await post(delivery).expect(401);
  });

  it("rejects a delivery with no signature header", async () => {
    const delivery = fakeComposio.sign(expired());
    const headers: Record<string, string> = { ...delivery.headers };
    delete headers["webhook-signature"];
    await post({ ...delivery, headers }).expect(401);
  });

  it("rejects a replay from outside the tolerance window", async () => {
    await post(fakeComposio.sign(expired(), { at: new Date(Date.now() - 20 * 60_000) })).expect(401);
  });

  it("writes nothing when the signature fails", async () => {
    const delivery = fakeComposio.sign(expired());
    await post({ ...delivery, headers: { ...delivery.headers, "webhook-signature": "v1,nope" } }).expect(401);
    expect(await emailRow()).toMatchObject({ status: "connected" });
  });
});

describe("an account expiring", () => {
  it("flips the connection and says so on the card", async () => {
    await post(fakeComposio.sign(expired())).expect(200);

    expect(await emailRow()).toMatchObject({
      status: "needs_reconnect", lastError: "The refresh token was revoked",
    });
    expect(await events("channel.expired")).toHaveLength(1);
  });

  it("is harmless when Composio retries it", async () => {
    const delivery = fakeComposio.sign(expired(), { webhookId: "msg_retried" });
    await post(delivery).expect(200);
    await post(delivery).expect(200);

    expect(await emailRow()).toMatchObject({ status: "needs_reconnect" });
    expect(await events("channel.expired")).toHaveLength(1);
  });

  it("acknowledges an account no workspace here owns", async () => {
    await post(fakeComposio.sign(expired("ca_someone_elses"))).expect(200);

    expect(await emailRow()).toMatchObject({ status: "connected" });
    expect(await events("channel.expired")).toEqual([]);
  });
});

describe("a trigger being disabled", () => {
  it("is treated the same as an expiry, routed by trigger id", async () => {
    await post(fakeComposio.sign({
      type: "composio.trigger.disabled",
      data: { id: TRIGGER, connected_account_id: ACCOUNT, disabled_reason: "Auth expired" },
    })).expect(200);

    expect(await emailRow()).toMatchObject({ status: "needs_reconnect", lastError: "Auth expired" });
    expect(await events("channel.expired")).toHaveLength(1);
  });

  it("acknowledges a trigger nothing here created", async () => {
    await post(fakeComposio.sign({
      type: "composio.trigger.disabled",
      data: { id: "ti_not_ours", disabled_reason: "Auth expired" },
    })).expect(200);
    expect(await emailRow()).toMatchObject({ status: "connected" });
  });
});

describe("a trigger message", () => {
  it("is acknowledged and, until the trigger-channels phase, changes nothing", async () => {
    await post(fakeComposio.sign({
      type: "composio.trigger.message",
      metadata: { trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE", connected_account_id: ACCOUNT },
      data: { message_id: "m1", thread_id: "t1", sender: "Deepa <deepa@example.com>", message_text: "hello" },
    })).expect(200);

    expect(await emailRow()).toMatchObject({ status: "connected" });
    expect(await prisma.conversation.count()).toBe(0);
    expect(await prisma.message.count()).toBe(0);
  });
});

describe("an event type nothing handles", () => {
  it("is acknowledged rather than retried for ever", async () => {
    await post(fakeComposio.sign({ type: "composio.connected_account.created", data: { id: ACCOUNT } })).expect(200);
    expect(await emailRow()).toMatchObject({ status: "connected" });
  });
});
