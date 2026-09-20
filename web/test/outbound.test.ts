import { beforeEach, describe, expect, it } from "vitest";
import { agent, createUser, createWorkspace, resetDatabase, signedIn } from "./helpers";
import { fakeComposio } from "./fakes/composio";
import { classify, readable, sendReply, splitText } from "@/server/channels/outbound";
import { prisma } from "@/server/lib/prisma";
import { ingest } from "@/server/services/ingest";
import type { Channel, Prisma } from "@/generated/prisma/client";

/**
 * The send path, through Composio's fake.
 *
 * The question every test here asks is the same one: does the row say what
 * actually happened? A message is only `sent` when the provider took it, a
 * refusal keeps its reason, and the connection is only touched when the
 * credential is genuinely dead — which Composio, not the provider's error
 * string, gets the last word on.
 */

let workspaceId: string;

const ACCOUNT = "ca_outbound_test";

async function setup(policy: "everything" | "money_only" | "nothing" = "money_only") {
  const { user } = await createUser();
  const workspace = await createWorkspace({ userId: user.id, policy });
  workspaceId = workspace.id;
  return workspace;
}

/** A connected channel, with the Composio account the send path executes against. */
async function connect(channel: Channel, options: {
  config?: Record<string, unknown>;
  status?: "connected" | "needs_reconnect" | "pending";
  accountStatus?: "ACTIVE" | "EXPIRED" | "REVOKED";
  accountId?: string;
} = {}) {
  const accountId = options.accountId ?? `${ACCOUNT}_${channel}`;
  fakeComposio.accounts.set(accountId, {
    id: accountId,
    status: options.accountStatus ?? "ACTIVE",
    statusReason: null,
    userId: workspaceId,
    toolkit: channel === "email" ? "gmail" : channel,
  });
  return prisma.channelConnection.create({
    data: {
      workspaceId, channel,
      status: options.status ?? "connected",
      externalId: `ext_${channel}`,
      composioAccountId: accountId,
      config: (options.config ?? {}) as Prisma.InputJsonObject,
      connectedAt: new Date(),
    },
  });
}

/** A conversation with an agent reply in it, the way a real inbound message makes one. */
async function conversationWith(channel: Channel, handle: string, text = "do you have olive polos") {
  const result = await ingest({ workspaceId, channel, handle, text });
  const message = await prisma.message.findFirstOrThrow({
    where: { conversationId: result.conversationId, from: "agent" },
    orderBy: { sentAt: "desc" },
  });
  return { conversationId: result.conversationId, message, replySent: result.replySent };
}

const refuse = (slug: string, error: string) =>
  fakeComposio.execute.respond(slug, { successful: false, data: {}, error });

const events = (type: string) => prisma.twinEvent.findMany({ where: { workspaceId, type } });

const messageRow = (id: string) => prisma.message.findUniqueOrThrow({ where: { id } });

beforeEach(async () => { await resetDatabase(); });

describe("what reaches the provider", () => {
  it("sends WhatsApp with the documented slug and a bare number", async () => {
    await setup();
    await connect("whatsapp", { config: { phoneNumberId: "pn_123" } });
    const { conversationId, message } = await conversationWith("whatsapp", "+91 98123 45678");

    const outcome = await sendReply({ workspaceId, conversationId, messageId: message.id });

    expect(outcome.delivered).toBe(true);
    expect(fakeComposio.calls.execute).toEqual([{
      slug: "WHATSAPP_SEND_MESSAGE",
      userId: workspaceId,
      connectedAccountId: `${ACCOUNT}_whatsapp`,
      arguments: { text: message.text, to_number: "919812345678", phone_number_id: "pn_123" },
    }]);
  });

  it("sends Telegram with the chat id as a string", async () => {
    await setup();
    await connect("telegram");
    const { conversationId, message } = await conversationWith("telegram", "555");

    await sendReply({ workspaceId, conversationId, messageId: message.id });

    expect(fakeComposio.calls.execute[0]).toMatchObject({
      slug: "TELEGRAM_SEND_MESSAGE",
      arguments: { chat_id: "555", text: message.text },
    });
  });

  it("sends Instagram to the recipient id", async () => {
    await setup();
    await connect("instagram");
    const { conversationId, message } = await conversationWith("instagram", "igsid_900");

    await sendReply({ workspaceId, conversationId, messageId: message.id });

    expect(fakeComposio.calls.execute[0]).toMatchObject({
      slug: "INSTAGRAM_SEND_TEXT_MESSAGE",
      arguments: { recipient_id: "igsid_900", text: message.text },
    });
  });

  it("refuses to send WhatsApp before a number has been chosen", async () => {
    await setup();
    await connect("whatsapp", { config: { phoneNumbers: [{ id: "a" }, { id: "b" }] } });
    const { conversationId, message } = await conversationWith("whatsapp", "919812345678");

    const outcome = await sendReply({ workspaceId, conversationId, messageId: message.id });

    expect(outcome.delivered).toBe(false);
    expect(outcome.reason).toMatch(/phone number/i);
    expect(fakeComposio.calls.execute).toEqual([]);
    expect((await messageRow(message.id)).deliveryStatus).toBe("failed");
  });
});

describe("what the message row says afterwards", () => {
  it("is sent only once the provider has accepted it", async () => {
    await setup();
    await connect("telegram");
    const { conversationId, message } = await conversationWith("telegram", "555");

    expect((await messageRow(message.id)).deliveryStatus).toBe("not_applicable");
    await sendReply({ workspaceId, conversationId, messageId: message.id });

    const row = await messageRow(message.id);
    expect(row.deliveryStatus).toBe("sent");
    expect(row.deliveryError).toBeNull();
    expect(await events("reply.sent")).toHaveLength(1);
  });

  it("fails with the channel's own reason when nothing is connected", async () => {
    await setup();
    const { conversationId, message } = await conversationWith("telegram", "555");

    const outcome = await sendReply({ workspaceId, conversationId, messageId: message.id });

    expect(outcome).toEqual({ delivered: false, reason: "Channel not connected" });
    expect((await messageRow(message.id)).deliveryError).toBe("Channel not connected");
    // Not an incident: nothing is broken, the workspace simply has not connected.
    expect(await events("reply.failed")).toHaveLength(0);
    expect(await events("channel.expired")).toHaveLength(0);
  });
});

describe("classifying a refusal", () => {
  it("keeps the connection when WhatsApp closes the 24-hour window", async () => {
    await setup();
    const row = await connect("whatsapp", { config: { phoneNumberId: "pn_123" } });
    refuse("WHATSAPP_SEND_MESSAGE", "(#131047) Message failed to send because more than 24 hours have passed");
    const { conversationId, message } = await conversationWith("whatsapp", "919812345678");

    const outcome = await sendReply({ workspaceId, conversationId, messageId: message.id });

    expect(outcome.delivered).toBe(false);
    expect((await messageRow(message.id)).deliveryStatus).toBe("failed");
    expect((await messageRow(message.id)).deliveryError).toContain("131047");
    expect((await prisma.channelConnection.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("connected");
    expect(await events("reply.failed")).toHaveLength(1);
    // One attempt: a closed window will be just as closed in 500ms.
    expect(fakeComposio.calls.execute).toHaveLength(1);
  });

  it("takes the channel offline when Meta says 190 and the account really is expired", async () => {
    await setup();
    const row = await connect("whatsapp", { config: { phoneNumberId: "pn_123" }, accountStatus: "EXPIRED" });
    refuse("WHATSAPP_SEND_MESSAGE", "OAuthException code 190: Error validating access token");
    const { conversationId, message } = await conversationWith("whatsapp", "919812345678");

    await sendReply({ workspaceId, conversationId, messageId: message.id });

    const connection = await prisma.channelConnection.findUniqueOrThrow({ where: { id: row.id } });
    expect(connection.status).toBe("needs_reconnect");
    expect(connection.lastError).toContain("190");
    expect((await messageRow(message.id)).deliveryStatus).toBe("failed");
    expect(await events("channel.expired")).toHaveLength(1);
    expect(await events("reply.failed")).toHaveLength(0);
  });

  it("leaves a healthy channel alone when Meta says 190 but the account is ACTIVE", async () => {
    await setup();
    const row = await connect("whatsapp", { config: { phoneNumberId: "pn_123" } });
    refuse("WHATSAPP_SEND_MESSAGE", "OAuthException code 190: Error validating access token");
    const { conversationId, message } = await conversationWith("whatsapp", "919812345678");

    await sendReply({ workspaceId, conversationId, messageId: message.id });

    // The confirmation step: a 401 caused by a bad argument must not
    // disconnect a channel every other conversation is still using.
    expect((await prisma.channelConnection.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("connected");
    expect(fakeComposio.calls.getAccount).toEqual([`${ACCOUNT}_whatsapp`]);
    expect((await messageRow(message.id)).deliveryStatus).toBe("failed");
    expect(await events("reply.failed")).toHaveLength(1);
    expect(await events("channel.expired")).toHaveLength(0);
  });

  it("does not retry a Telegram block", async () => {
    await setup();
    const row = await connect("telegram");
    refuse("TELEGRAM_SEND_MESSAGE", "403 Forbidden: bot was blocked by the user");
    const { conversationId, message } = await conversationWith("telegram", "555");

    await sendReply({ workspaceId, conversationId, messageId: message.id });

    expect(fakeComposio.calls.execute).toHaveLength(1);
    expect((await prisma.channelConnection.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("connected");
    expect((await messageRow(message.id)).deliveryStatus).toBe("failed");
  });

  it("retries a rate limit once and keeps the message when the retry lands", async () => {
    await setup();
    await connect("telegram");
    let calls = 0;
    fakeComposio.execute.respond("TELEGRAM_SEND_MESSAGE", () => {
      calls += 1;
      return calls === 1
        ? { successful: false, data: {}, error: "429 Too Many Requests: retry after 1" }
        : { successful: true, data: { message_id: 7 }, error: null };
    });
    const { conversationId, message } = await conversationWith("telegram", "555");

    const outcome = await sendReply({ workspaceId, conversationId, messageId: message.id });

    expect(outcome.delivered).toBe(true);
    expect(fakeComposio.calls.execute).toHaveLength(2);
    expect((await messageRow(message.id)).deliveryStatus).toBe("sent");
  });

  it("gives up after one retry", async () => {
    await setup();
    await connect("telegram");
    refuse("TELEGRAM_SEND_MESSAGE", "429 Too Many Requests: retry after 1");
    const { conversationId, message } = await conversationWith("telegram", "555");

    await sendReply({ workspaceId, conversationId, messageId: message.id });

    expect(fakeComposio.calls.execute).toHaveLength(2);
    expect((await messageRow(message.id)).deliveryStatus).toBe("failed");
    expect(await events("reply.failed")).toHaveLength(1);
  });

  it("treats Composio being unreachable as transient", async () => {
    await setup();
    const row = await connect("telegram");
    fakeComposio.execute.respond("TELEGRAM_SEND_MESSAGE", () => { throw new Error("fetch failed"); });
    const { conversationId, message } = await conversationWith("telegram", "555");

    await sendReply({ workspaceId, conversationId, messageId: message.id });

    expect(fakeComposio.calls.execute).toHaveLength(2);
    expect((await messageRow(message.id)).deliveryError).toContain("fetch failed");
    // Composio being down says nothing about the workspace's credential.
    expect((await prisma.channelConnection.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("connected");
  });

  it("maps each provider's vocabulary to one of three outcomes", () => {
    expect(classify("whatsapp", "(#131047) outside the window")).toBe("policy");
    expect(classify("whatsapp", "(#131026) message undeliverable")).toBe("policy");
    expect(classify("whatsapp", "(#130429) rate limit hit")).toBe("transient");
    expect(classify("whatsapp", "OAuthException 190")).toBe("auth");
    expect(classify("telegram", "401 Unauthorized")).toBe("auth");
    expect(classify("telegram", "400 Bad Request: chat not found")).toBe("policy");
    expect(classify("instagram", "code 10 subcode 2534022")).toBe("policy");
    expect(classify("telegram", "something nobody has seen before")).toBe("transient");
  });
});

describe("confirming a dead credential", () => {
  it("takes Telegram offline when the token was revoked and Composio still says ACTIVE", async () => {
    await setup();
    const row = await connect("telegram");
    const refusal = '{"ok":false,"error_code":401,"description":"Unauthorized"}';
    refuse("TELEGRAM_SEND_MESSAGE", refusal);
    refuse("TELEGRAM_GET_ME", refusal);
    const { conversationId, message } = await conversationWith("telegram", "555");

    await sendReply({ workspaceId, conversationId, messageId: message.id });

    // The case the account status cannot see: an API key revoked at the
    // provider leaves Composio's record untouched, so the identity call is
    // the only thing that can answer.
    expect(fakeComposio.accounts.get(`${ACCOUNT}_telegram`)!.status).toBe("ACTIVE");
    expect(fakeComposio.calls.execute.map((call) => call.slug))
      .toEqual(["TELEGRAM_SEND_MESSAGE", "TELEGRAM_GET_ME"]);

    const connection = await prisma.channelConnection.findUniqueOrThrow({ where: { id: row.id } });
    expect(connection.status).toBe("needs_reconnect");
    expect(connection.lastError).toBe("401: Unauthorized");
    // Classified from the provider's original envelope, stored as the
    // sentence inside it.
    expect((await messageRow(message.id)).deliveryError).toBe("401: Unauthorized");
    expect(await events("channel.expired")).toHaveLength(1);
    expect(await events("reply.failed")).toHaveLength(0);
  });

  it("keeps the channel when the credential still answers a read", async () => {
    await setup();
    const row = await connect("telegram");
    refuse("TELEGRAM_SEND_MESSAGE", "401 Unauthorized: chat_id is empty");
    const { conversationId, message } = await conversationWith("telegram", "555");

    await sendReply({ workspaceId, conversationId, messageId: message.id });

    // A 401 the message itself caused. The probe carries no message, so its
    // success is what separates the two.
    expect(fakeComposio.calls.execute.map((call) => call.slug))
      .toEqual(["TELEGRAM_SEND_MESSAGE", "TELEGRAM_GET_ME"]);
    expect((await prisma.channelConnection.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("connected");
    expect(await events("reply.failed")).toHaveLength(1);
    expect(await events("channel.expired")).toHaveLength(0);
  });

  it("leaves the channel alone when the probe itself cannot be made", async () => {
    await setup();
    const row = await connect("telegram");
    refuse("TELEGRAM_SEND_MESSAGE", "401 Unauthorized");
    fakeComposio.execute.respond("TELEGRAM_GET_ME", () => { throw new Error("connect ECONNREFUSED"); });
    const { conversationId, message } = await conversationWith("telegram", "555");

    await sendReply({ workspaceId, conversationId, messageId: message.id });

    expect((await prisma.channelConnection.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("connected");
    expect(await events("channel.expired")).toHaveLength(0);
    expect(await events("reply.failed")).toHaveLength(1);
  });

  it("does not probe at all when the refusal was not about auth", async () => {
    await setup();
    await connect("telegram");
    refuse("TELEGRAM_SEND_MESSAGE", "403 Forbidden: bot was blocked by the user");
    const { conversationId, message } = await conversationWith("telegram", "555");

    await sendReply({ workspaceId, conversationId, messageId: message.id });

    expect(fakeComposio.calls.execute.map((call) => call.slug)).toEqual(["TELEGRAM_SEND_MESSAGE"]);
    expect(fakeComposio.calls.getAccount).toEqual([]);
  });
});

describe("an error an operator can read", () => {
  it("unwraps a provider's JSON envelope and keeps the code in front", () => {
    expect(readable('{"ok":false,"error_code":401,"description":"Unauthorized"}')).toBe("401: Unauthorized");
  });

  it("reaches the sentence inside a nested error object", () => {
    expect(readable('{"error":{"message":"Error validating access token","code":190,"type":"OAuthException"}}'))
      .toBe("190: Error validating access token");
  });

  it("leaves prose alone", () => {
    const meta = "(#131047) Message failed to send because more than 24 hours have passed";
    expect(readable(meta)).toBe(meta);
  });

  it("keeps the original when the braces are not JSON, or hold no sentence", () => {
    expect(readable("Request failed {not json")).toBe("Request failed {not json");
    expect(readable('{"ok":false}')).toBe('{"ok":false}');
  });

  it("does not repeat a code the sentence already carries", () => {
    expect(readable('{"code":190,"message":"OAuthException code 190"}')).toBe("OAuthException code 190");
  });
});

describe("splitting a long reply", () => {
  it("leaves anything within the limit alone", () => {
    expect(splitText("short", 4096)).toEqual(["short"]);
    expect(splitText("x".repeat(9000), null)).toHaveLength(1);
  });

  it("breaks at a sentence boundary", () => {
    const sentence = `${"a".repeat(80)}. `;
    const parts = splitText(sentence.repeat(20).trim(), 500);

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(500);
    // Nothing is lost and no part starts mid-sentence.
    for (const part of parts.slice(1)) expect(part.startsWith("a")).toBe(true);
    expect(parts.join(" ").replace(/\s+/g, "")).toBe(sentence.repeat(20).trim().replace(/\s+/g, ""));
  });

  it("breaks at a space when one sentence is longer than the whole limit", () => {
    const parts = splitText(`${"word ".repeat(300)}end.`, 200);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(200);
    expect(parts.some((part) => part.endsWith("word"))).toBe(true);
  });

  it("sends a reply over the channel limit as successive messages", async () => {
    await setup();
    await connect("telegram");
    const { conversationId, message } = await conversationWith("telegram", "555");
    const long = `${"Olive polos are in stock. ".repeat(400)}`.trim();
    await prisma.message.update({ where: { id: message.id }, data: { text: long } });

    const outcome = await sendReply({ workspaceId, conversationId, messageId: message.id });

    expect(outcome.delivered).toBe(true);
    expect(fakeComposio.calls.execute.length).toBeGreaterThan(1);
    const texts = fakeComposio.calls.execute.map((call) => call.arguments.text as string);
    for (const text of texts) expect(text.length).toBeLessThanOrEqual(4096);
    expect(texts[1]!.startsWith("Olive")).toBe(true);
  });
});

describe("through the routes", () => {
  it("tells the operator a manual reply was not delivered", async () => {
    await setup();
    await connect("telegram", { status: "needs_reconnect" });
    const { conversationId } = await conversationWith("telegram", "555");

    const app = await signedIn();
    const res = await app.post(`/v1/conversations/${conversationId}/reply`)
      .send({ text: "we have those in olive" }).expect(201);

    expect(res.body).toMatchObject({ ok: true, delivered: false, reason: "Channel not connected" });
    const written = await prisma.message.findFirstOrThrow({
      where: { conversationId, text: "we have those in olive" },
    });
    expect(written.deliveryStatus).toBe("failed");
  });

  it("delivers a manual reply when the channel is live", async () => {
    await setup();
    await connect("telegram");
    const { conversationId } = await conversationWith("telegram", "555");

    const app = await signedIn();
    const res = await app.post(`/v1/conversations/${conversationId}/reply`)
      .send({ text: "we have those in olive" }).expect(201);

    expect(res.body.delivered).toBe(true);
    const written = await prisma.message.findFirstOrThrow({
      where: { conversationId, text: "we have those in olive" },
    });
    expect(written.deliveryStatus).toBe("sent");
    expect(fakeComposio.calls.execute).toHaveLength(1);
    // The operator is named in the trail; the send path writes the event now.
    expect((await events("reply.sent"))[0]?.payload).toContain("owner@test.local");
  });

  it("sends the held reply when an approval is granted", async () => {
    await setup("everything");
    await connect("telegram");
    const { conversationId, replySent } = await conversationWith("telegram", "555", "I want 2 olive L polos");
    expect(replySent).toBe(false);

    const held = await prisma.message.findFirstOrThrow({ where: { conversationId, from: "agent" } });
    expect(held.deliveryStatus).toBe("held");

    const approval = await prisma.approval.findFirstOrThrow({ where: { workspaceId } });
    const app = await signedIn();
    const res = await app.post(`/v1/approvals/${approval.id}/approve`).expect(200);

    expect(res.body.delivered).toBe(true);
    expect((await messageRow(held.id)).deliveryStatus).toBe("sent");
    expect(await events("reply.sent")).toHaveLength(1);
  });

  it("never sends a rejected reply", async () => {
    await setup("everything");
    await connect("telegram");
    const { conversationId } = await conversationWith("telegram", "555", "I want 2 olive L polos");
    const held = await prisma.message.findFirstOrThrow({ where: { conversationId, from: "agent" } });

    const approval = await prisma.approval.findFirstOrThrow({ where: { workspaceId } });
    const app = await signedIn();
    const res = await app.post(`/v1/approvals/${approval.id}/reject`).expect(200);

    expect(res.body.delivered).toBe(false);
    expect((await messageRow(held.id)).deliveryStatus).toBe("held");
    expect(fakeComposio.calls.execute).toEqual([]);
  });

  it("does not re-send a message a previous decision already delivered", async () => {
    await setup("everything");
    await connect("telegram");
    const { conversationId } = await conversationWith("telegram", "555", "I want 2 olive L polos");
    const held = await prisma.message.findFirstOrThrow({ where: { conversationId, from: "agent" } });
    await prisma.message.update({ where: { id: held.id }, data: { deliveryStatus: "sent" } });

    const approval = await prisma.approval.findFirstOrThrow({ where: { workspaceId } });
    const app = await signedIn();
    await app.post(`/v1/approvals/${approval.id}/approve`).expect(200);

    expect(fakeComposio.calls.execute).toEqual([]);
  });

  it("answers a customer end to end, from the webhook to the provider", async () => {
    await setup();
    const row = await connect("telegram");
    await prisma.channelConnection.update({
      where: { id: row.id },
      data: { webhookSecret: "telegram-secret-for-tests" },
    });

    await agent().post(`/webhooks/telegram/${row.id}`)
      .set("x-telegram-bot-api-secret-token", "telegram-secret-for-tests")
      .send({
        update_id: 1,
        message: { message_id: 1, text: "do you have 2 olive L polos", chat: { id: 555, first_name: "Deepa" } },
      })
      .expect(200);

    await new Promise((resolve) => setTimeout(resolve, 600));

    const sent = fakeComposio.calls.execute.find((call) => call.slug === "TELEGRAM_SEND_MESSAGE");
    expect(sent).toBeDefined();
    expect(sent!.arguments.chat_id).toBe("555");

    const reply = await prisma.message.findFirstOrThrow({
      where: { conversation: { workspaceId }, from: "agent" },
      orderBy: { sentAt: "desc" },
    });
    expect(sent!.arguments.text).toBe(reply.text);
    expect(reply.deliveryStatus).toBe("sent");
  });
});

describe("tenancy", () => {
  it("will not send a message belonging to another workspace", async () => {
    await setup();
    await connect("telegram");
    const { conversationId, message } = await conversationWith("telegram", "555");

    const { user } = await createUser("other@test.local");
    const other = await createWorkspace({ userId: user.id, name: "Other Co" });

    await expect(
      sendReply({ workspaceId: other.id, conversationId, messageId: message.id }),
    ).rejects.toThrow(/not found/i);
    expect(fakeComposio.calls.execute).toEqual([]);
  });
});
