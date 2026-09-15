import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { agent, createUser, createWorkspace, resetDatabase } from "./helpers";
import { encrypt } from "@/server/lib/crypto";
import { prisma } from "@/server/lib/prisma";

// H-3: the verify token (used for Telegram's secret header and for Meta's
// GET subscription challenge) and the Meta App Secret (used to HMAC-sign
// every Meta webhook POST body) are deliberately different credentials now,
// so tests exercise both rather than reusing one value for everything.
const VERIFY_TOKEN = "webhook-secret-for-tests";
const META_APP_SECRET = "meta-app-secret-distinct-from-verify-token";
let workspaceId: string;
let whatsappConnectionId: string;

beforeEach(async () => {
  await resetDatabase();
  const { user } = await createUser();
  const workspace = await createWorkspace({ userId: user.id });
  workspaceId = workspace.id;

  await prisma.channelConnection.create({
    data: { workspaceId, channel: "telegram", status: "connected", webhookSecret: VERIFY_TOKEN, config: {} },
  });
  const whatsapp = await prisma.channelConnection.create({
    data: {
      workspaceId, channel: "whatsapp", status: "connected", webhookSecret: VERIFY_TOKEN,
      metaAppSecretCipher: encrypt(META_APP_SECRET), config: {},
    },
  });
  whatsappConnectionId = whatsapp.id;
});

const telegramUpdate = (text: string) => ({
  update_id: 1,
  message: { message_id: 1, text, chat: { id: 555, first_name: "Deepa" }, from: { first_name: "Deepa" } },
});

const whatsappPayload = (text: string) => ({
  entry: [{ changes: [{ value: {
    contacts: [{ profile: { name: "Imran" }, wa_id: "919812345678" }],
    messages: [{ id: "wamid.1", from: "919812345678", type: "text", text: { body: text } }],
  } }] }],
});

describe("telegram webhook", () => {
  it("rejects a request with no secret", async () => {
    await agent().post(`/webhooks/telegram/${workspaceId}`).send(telegramUpdate("hi")).expect(401);
  });

  it("rejects the wrong secret", async () => {
    await agent().post(`/webhooks/telegram/${workspaceId}`)
      .set("x-telegram-bot-api-secret-token", "wrong").send(telegramUpdate("hi")).expect(401);
  });

  it("accepts the right secret and runs the loop", async () => {
    await agent().post(`/webhooks/telegram/${workspaceId}`)
      .set("x-telegram-bot-api-secret-token", VERIFY_TOKEN)
      .send(telegramUpdate("do you have 2 olive L polos")).expect(200);

    // The response is sent before the work, so wait for the write to land.
    await new Promise((r) => setTimeout(r, 400));
    const customer = await prisma.customer.findFirst({ where: { workspaceId, handle: "555" } });
    expect(customer?.name).toBe("Deepa");
  });

  it("does not run the loop twice for a retried update id (H-3 idempotency)", async () => {
    const update = telegramUpdate("do you have 2 olive L polos");
    for (let i = 0; i < 2; i++) {
      await agent().post(`/webhooks/telegram/${workspaceId}`)
        .set("x-telegram-bot-api-secret-token", VERIFY_TOKEN)
        .send(update).expect(200);
    }
    await new Promise((r) => setTimeout(r, 400));
    const conversations = await prisma.conversation.count({ where: { workspaceId } });
    expect(conversations).toBe(1);
  });

  it("404s an unknown workspace", async () => {
    await agent().post("/webhooks/telegram/no-such-workspace")
      .set("x-telegram-bot-api-secret-token", VERIFY_TOKEN).send(telegramUpdate("hi")).expect(404);
  });
});

describe("whatsapp webhook", () => {
  // H-3: signed with the Meta App Secret, never with the verify token — a
  // signature built from the verify token must be rejected even though it
  // is a real credential on this connection, because it is the wrong one.
  const signed = (body: unknown, key = META_APP_SECRET) =>
    "sha256=" + createHmac("sha256", key).update(Buffer.from(JSON.stringify(body))).digest("hex");

  it("rejects a forged signature", async () => {
    const body = whatsappPayload("hello");
    await agent().post(`/webhooks/whatsapp/${workspaceId}`)
      .set("x-hub-signature-256", "sha256=" + "0".repeat(64))
      .set("Content-Type", "application/json").send(body).expect(401);
  });

  // H-3 regression: the pre-fix code verified against `webhookSecret` (the
  // operator's verify token), so signing with that value used to succeed —
  // the exact bug the audit reproduced. It must now be rejected: only the
  // Meta App Secret is a valid signing key.
  it("rejects a signature built from the verify token instead of the App Secret", async () => {
    const body = whatsappPayload("hello");
    await agent().post(`/webhooks/whatsapp/${workspaceId}`)
      .set("x-hub-signature-256", signed(body, VERIFY_TOKEN))
      .set("Content-Type", "application/json").send(body).expect(401);
  });

  it("rejects every Meta webhook when no App Secret has been configured yet", async () => {
    await prisma.channelConnection.update({
      where: { id: whatsappConnectionId },
      data: { metaAppSecretCipher: null },
    });
    const body = whatsappPayload("hello");
    await agent().post(`/webhooks/whatsapp/${workspaceId}`)
      .set("x-hub-signature-256", signed(body))
      .set("Content-Type", "application/json").send(body).expect(401);
  });

  it("accepts a genuine signature", async () => {
    const body = whatsappPayload("is the linen shirt in stock");
    await agent().post(`/webhooks/whatsapp/${workspaceId}`)
      .set("x-hub-signature-256", signed(body))
      .set("Content-Type", "application/json").send(body).expect(200);
  });

  it("does not run the loop twice for a retried message id (H-3 idempotency)", async () => {
    const body = whatsappPayload("is the linen shirt in stock");
    for (let i = 0; i < 2; i++) {
      await agent().post(`/webhooks/whatsapp/${workspaceId}`)
        .set("x-hub-signature-256", signed(body))
        .set("Content-Type", "application/json").send(body).expect(200);
    }
    await new Promise((r) => setTimeout(r, 400));
    const conversations = await prisma.conversation.count({ where: { workspaceId } });
    expect(conversations).toBe(1);
    expect(await prisma.processedMessage.count({ where: { connectionId: whatsappConnectionId } })).toBe(1);
  });

  it("answers Meta's verification challenge only with the right token", async () => {
    await agent()
      .get(`/webhooks/whatsapp/${workspaceId}`)
      .query({ "hub.mode": "subscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "challenge-123" })
      .expect(200, "challenge-123");

    await agent()
      .get(`/webhooks/whatsapp/${workspaceId}`)
      .query({ "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "challenge-123" })
      .expect(403);
  });
});
