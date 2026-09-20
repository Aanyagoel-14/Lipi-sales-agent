import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { agent, createUser, createWorkspace, resetDatabase } from "./helpers";
import { fakeComposio } from "./fakes/composio";
import { channelSpecs } from "@/server/channels/registry";
import { INBOUND_LIMIT } from "@/server/channels/inbound";
import { conversationVolume } from "@/server/services/analytics";
import { env } from "@/server/env";
import { prisma } from "@/server/lib/prisma";
import { _resetRateLimitsForTests } from "@/server/lib/rate-limit";

/**
 * Inbound, from the provider's bytes to the twins.
 *
 * Two tenants are seeded throughout, both with connections of the same
 * channels, because the property that matters most here is not that a
 * message arrives — it is that it arrives in exactly one workspace. There is
 * one Meta URL for every tenant now, and the only thing separating them is
 * the provider id in the payload.
 */

const APP_SECRET = env.META_APP_SECRET!;
const VERIFY_TOKEN = env.META_VERIFY_TOKEN!;

// One id per channel per tenant. `(channel, externalId)` is unique, so these
// are what the router has to tell apart.
const A = { phone: "phone_a", ig: "ig_a", page: "page_a" };
const B = { phone: "phone_b", ig: "ig_b", page: "page_b" };

let alpha: string;
let beta: string;
let telegramId: string;
let whatsappId: string;

type Connectable = "whatsapp" | "instagram" | "facebook" | "telegram";

/**
 * A connected row of `channel`, already answering as `externalId` — and
 * carrying the config its send builder needs, because several of these tests
 * follow an inbound message all the way back out again.
 */
const connect = (workspaceId: string, channel: Connectable, externalId: string, extra = {}) =>
  prisma.channelConnection.create({
    data: {
      workspaceId, channel, externalId, status: "connected",
      composioAccountId: `ca_${workspaceId}_${channel}`,
      config: channel === "whatsapp"
        ? { phoneNumbers: [{ id: externalId }], phoneNumberId: externalId }
        : channel === "facebook" ? { pages: [{ id: externalId }], pageId: externalId } : {},
      ...extra,
    },
  });

const TELEGRAM_SECRET = "telegram-secret-token-for-tests";

beforeEach(async () => {
  await resetDatabase();
  _resetRateLimitsForTests();

  const { user } = await createUser();
  // Policy `nothing` so a reply actually leaves: the point of several of
  // these tests is that the loop runs all the way out through `sendReply`.
  alpha = (await createWorkspace({ userId: user.id, policy: "nothing" })).id;

  const second = await createUser("second@test.local");
  beta = (await createWorkspace({ userId: second.user.id, name: "Second Co", withCatalogue: false })).id;

  whatsappId = (await connect(alpha, "whatsapp", A.phone)).id;
  await connect(alpha, "instagram", A.ig);
  await connect(alpha, "facebook", A.page);
  telegramId = (await connect(alpha, "telegram", "bot_a", { webhookSecret: TELEGRAM_SECRET })).id;

  await connect(beta, "whatsapp", B.phone);
  await connect(beta, "instagram", B.ig);
  await connect(beta, "facebook", B.page);
});

// ------------------------------------------------------------- fixtures --

const whatsappBody = (phoneNumberId: string, text: string, id = "wamid.1") => ({
  object: "whatsapp_business_account",
  entry: [{
    id: "waba_1",
    changes: [{
      value: {
        metadata: { phone_number_id: phoneNumberId },
        contacts: [{ profile: { name: "Imran" }, wa_id: "919812345678" }],
        messages: [{ id, from: "919812345678", type: "text", text: { body: text } }],
      },
    }],
  }],
});

const messagingBody = (object: "instagram" | "page", entryId: string, text: string, mid = "mid.1") => ({
  object,
  entry: [{
    id: entryId,
    messaging: [{ sender: { id: "psid_9001" }, recipient: { id: entryId }, message: { mid, text } }],
  }],
});

const telegramUpdate = (text: string, updateId = 1) => ({
  update_id: updateId,
  message: { message_id: 1, text, chat: { id: 555, first_name: "Deepa" }, from: { first_name: "Deepa" } },
});

const sign = (body: unknown, key = APP_SECRET) =>
  "sha256=" + createHmac("sha256", key).update(Buffer.from(JSON.stringify(body))).digest("hex");

/** A signed Meta delivery, exactly as Meta would send it. */
const deliver = (body: unknown, signature = sign(body)) =>
  agent().post("/webhooks/meta")
    .set("x-hub-signature-256", signature)
    .set("Content-Type", "application/json")
    .send(body);

/** `after()` is not awaited in production and is not awaited here either. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

const conversationsIn = (workspaceId: string) =>
  prisma.conversation.findMany({ where: { workspaceId }, include: { messages: true } });

// -------------------------------------------------------- meta: the door --

describe("Meta's subscription challenge", () => {
  it("echoes the challenge for the deployment's verify token", async () => {
    await agent().get("/webhooks/meta")
      .query({ "hub.mode": "subscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "challenge-123" })
      .expect(200, "challenge-123");
  });

  it("refuses any other token", async () => {
    await agent().get("/webhooks/meta")
      .query({ "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "challenge-123" })
      .expect(403);
  });
});

describe("Meta's signature", () => {
  it("refuses a body with no signature at all", async () => {
    await agent().post("/webhooks/meta")
      .set("Content-Type", "application/json")
      .send(whatsappBody(A.phone, "hello")).expect(401);
  });

  it("refuses a signature made with the wrong key", async () => {
    const body = whatsappBody(A.phone, "hello");
    await deliver(body, sign(body, "not-the-app-secret")).expect(401);
  });

  it("accepts a genuine signature", async () => {
    await deliver(whatsappBody(A.phone, "hello")).expect(200);
  });

  it("refuses a well-signed body that is not JSON", async () => {
    const raw = "{not json";
    await agent().post("/webhooks/meta")
      .set("x-hub-signature-256", "sha256=" + createHmac("sha256", APP_SECRET).update(Buffer.from(raw)).digest("hex"))
      .set("Content-Type", "application/json")
      .send(raw).expect(400);
  });
});

// ------------------------------------------------------------- routing --

describe("routing one URL to many tenants", () => {
  it("delivers a WhatsApp message to the workspace that owns the number", async () => {
    await deliver(whatsappBody(A.phone, "do you have 2 olive L polos")).expect(200);
    await settle();

    const mine = await conversationsIn(alpha);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.channel).toBe("whatsapp");
    expect(await conversationsIn(beta)).toHaveLength(0);
  });

  it("delivers an Instagram DM by professional account id", async () => {
    await deliver(messagingBody("instagram", B.ig, "is the linen shirt in stock")).expect(200);
    await settle();

    expect(await conversationsIn(alpha)).toHaveLength(0);
    const theirs = await conversationsIn(beta);
    expect(theirs).toHaveLength(1);
    expect(theirs[0]!.channel).toBe("instagram");
  });

  it("delivers a Messenger thread by Page id", async () => {
    await deliver(messagingBody("page", A.page, "hello")).expect(200);
    await settle();

    const mine = await conversationsIn(alpha);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.channel).toBe("facebook");
  });

  it("splits one delivery that carries both tenants' entries", async () => {
    const body = {
      object: "whatsapp_business_account",
      entry: [
        whatsappBody(A.phone, "for alpha", "wamid.alpha").entry[0],
        whatsappBody(B.phone, "for beta", "wamid.beta").entry[0],
      ],
    };
    await deliver(body).expect(200);
    await settle();

    const mine = await conversationsIn(alpha);
    const theirs = await conversationsIn(beta);
    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(1);
    expect(mine[0]!.messages.some((m) => m.text === "for alpha")).toBe(true);
    expect(theirs[0]!.messages.some((m) => m.text === "for beta")).toBe(true);
  });

  it("accepts and drops a number no workspace has connected", async () => {
    await deliver(whatsappBody("phone_nobody", "hello")).expect(200);
    await settle();

    expect(await prisma.processedMessage.count()).toBe(0);
    expect(await prisma.conversation.count()).toBe(0);
  });

  it("accepts and drops a product this deployment does not serve", async () => {
    await deliver({ object: "threads", entry: [{ id: A.page }] }).expect(200);
    await settle();
    expect(await prisma.conversation.count()).toBe(0);
  });
});

// -------------------------------------------------- what is not a message --

describe("everything Meta sends that is not a customer message", () => {
  it("ignores a WhatsApp body carrying only delivery statuses", async () => {
    await deliver({
      object: "whatsapp_business_account",
      entry: [{ id: "waba_1", changes: [{ value: {
        metadata: { phone_number_id: A.phone },
        statuses: [{ id: "wamid.1", status: "delivered", recipient_id: "919812345678" }],
      } }] }],
    }).expect(200);
    await settle();

    expect(await prisma.processedMessage.count()).toBe(0);
    expect(await prisma.conversation.count()).toBe(0);
  });

  it("ignores our own Instagram reply coming back as an echo", async () => {
    await deliver({
      object: "instagram",
      entry: [{ id: A.ig, messaging: [{
        sender: { id: A.ig }, recipient: { id: "psid_9001" },
        message: { mid: "mid.echo", text: "thanks for your order", is_echo: true },
      }] }],
    }).expect(200);
    await settle();

    expect(await prisma.conversation.count()).toBe(0);
  });

  it("ignores Messenger reads, deliveries and postbacks", async () => {
    await deliver({
      object: "page",
      entry: [{ id: A.page, messaging: [
        { sender: { id: "psid_9001" }, recipient: { id: A.page }, read: { watermark: 1 } },
        { sender: { id: "psid_9001" }, recipient: { id: A.page }, delivery: { mids: ["mid.1"] } },
        { sender: { id: "psid_9001" }, recipient: { id: A.page }, postback: { payload: "GET_STARTED" } },
      ] }],
    }).expect(200);
    await settle();

    expect(await prisma.conversation.count()).toBe(0);
  });
});

// ------------------------------------------------------------ retries --

describe("a provider retrying a delivery it already made", () => {
  it("runs the loop once for a repeated wamid", async () => {
    const body = whatsappBody(A.phone, "do you have 2 olive L polos");
    for (let i = 0; i < 2; i++) await deliver(body).expect(200);
    await settle();

    const mine = await conversationsIn(alpha);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.messages.filter((m) => m.from === "agent")).toHaveLength(1);
    expect(await prisma.processedMessage.count({ where: { connectionId: whatsappId } })).toBe(1);
  });

  it("runs the loop once for a repeated mid", async () => {
    const body = messagingBody("instagram", A.ig, "do you have 2 olive L polos");
    for (let i = 0; i < 2; i++) await deliver(body).expect(200);
    await settle();

    expect(await conversationsIn(alpha)).toHaveLength(1);
  });

  it("runs the loop once for a repeated Telegram update id", async () => {
    const update = telegramUpdate("do you have 2 olive L polos");
    for (let i = 0; i < 2; i++) {
      await agent().post(`/webhooks/telegram/${telegramId}`)
        .set("x-telegram-bot-api-secret-token", TELEGRAM_SECRET).send(update).expect(200);
    }
    await settle();

    const mine = await conversationsIn(alpha);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.messages.filter((m) => m.from === "agent")).toHaveLength(1);
  });
});

// --------------------------------------------------------- rate limiting --

describe("the rate limit", () => {
  // Status callbacks cost a connection the same budget a message does and
  // start no work, which is what makes them the right shape to flood with:
  // the limit is about how many deliveries a connection may cause us to look
  // at, not how many of them turn out to be worth something.
  const statusOnly = (phoneNumberId: string) => ({
    object: "whatsapp_business_account",
    entry: [{ id: "waba_1", changes: [{ value: {
      metadata: { phone_number_id: phoneNumberId },
      statuses: [{ id: "wamid.s", status: "delivered", recipient_id: "919812345678" }],
    } }] }],
  });

  it("is spent per connection, and one tenant's flood does not close another's door", async () => {
    for (let i = 0; i < INBOUND_LIMIT; i++) await deliver(statusOnly(A.phone)).expect(200);

    await deliver(statusOnly(A.phone)).expect(429);
    await deliver(statusOnly(B.phone)).expect(200);
  });

  it("is not spent by requests that never authenticated", async () => {
    const body = statusOnly(A.phone);
    for (let i = 0; i < 200; i++) await deliver(body, sign(body, "forged")).expect(401);

    for (let i = 0; i < INBOUND_LIMIT; i++) await deliver(body).expect(200);
  });
});

// ------------------------------------------------------------- telegram --

describe("the Telegram route", () => {
  it("refuses a delivery with the wrong secret header", async () => {
    await agent().post(`/webhooks/telegram/${telegramId}`)
      .set("x-telegram-bot-api-secret-token", "wrong").send(telegramUpdate("hi")).expect(401);
  });

  it("refuses a delivery with no secret header at all", async () => {
    await agent().post(`/webhooks/telegram/${telegramId}`).send(telegramUpdate("hi")).expect(401);
  });

  it("accepts the right secret and runs the loop", async () => {
    await agent().post(`/webhooks/telegram/${telegramId}`)
      .set("x-telegram-bot-api-secret-token", TELEGRAM_SECRET)
      .send(telegramUpdate("do you have 2 olive L polos")).expect(200);
    await settle();

    const customer = await prisma.customer.findFirst({ where: { workspaceId: alpha, handle: "555" } });
    expect(customer?.name).toBe("Deepa");
  });

  it("404s a connection id that is not a Telegram connection", async () => {
    await agent().post(`/webhooks/telegram/${whatsappId}`)
      .set("x-telegram-bot-api-secret-token", TELEGRAM_SECRET).send(telegramUpdate("hi")).expect(404);
  });

  it("404s a connection id that does not exist", async () => {
    await agent().post("/webhooks/telegram/no-such-connection")
      .set("x-telegram-bot-api-secret-token", TELEGRAM_SECRET).send(telegramUpdate("hi")).expect(404);
  });

  it("refuses everything once the channel has been disconnected", async () => {
    await prisma.channelConnection.update({ where: { id: telegramId }, data: { webhookSecret: null } });
    await agent().post(`/webhooks/telegram/${telegramId}`)
      .set("x-telegram-bot-api-secret-token", TELEGRAM_SECRET).send(telegramUpdate("hi")).expect(401);
  });
});

// ----------------------------------------------------- the loop, intact --

describe("the loop an inbound message sets off", () => {
  it("builds the twins, reserves the stock, quotes the order and sends the reply", async () => {
    const before = await prisma.variant.findFirstOrThrow({
      where: { optionA: "L", optionB: "Olive", product: { workspaceId: alpha, name: "Polo Classic" } },
    });

    await deliver(whatsappBody(A.phone, "I want 2 olive L polos")).expect(200);
    await settle();

    const customer = await prisma.customer.findFirstOrThrow({ where: { workspaceId: alpha } });
    expect(customer.handle).toBe("919812345678");
    expect(customer.name).toBe("Imran");
    expect(customer.leadScore).toBeGreaterThan(0);

    const [conversation] = await conversationsIn(alpha);
    expect(conversation!.messages.map((m) => m.from)).toEqual(["customer", "agent"]);

    const order = await prisma.order.findFirstOrThrow({ where: { workspaceId: alpha } });
    expect(order.stage).toBe("Quoted");
    expect(order.value).toBe(1196 * 2 * 100);

    const after = await prisma.variant.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.reserved).toBe(before.reserved + 2);

    expect(await prisma.agentRun.count({ where: { workspaceId: alpha } })).toBeGreaterThan(0);
    expect(await prisma.twinEvent.count({ where: { workspaceId: alpha } })).toBeGreaterThan(0);

    // The reply the twin composed is the reply Composio was asked to send,
    // character for character, with the price it computed rather than one
    // the model wrote.
    const reply = conversation!.messages.find((m) => m.from === "agent")!;
    expect(reply.text).toContain("2,392");
    expect(reply.deliveryStatus).toBe("sent");

    const sent = fakeComposio.calls.execute.filter((call) => call.slug === "WHATSAPP_SEND_MESSAGE");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.arguments).toMatchObject({ to_number: "919812345678", phone_number_id: A.phone, text: reply.text });
  });

  it("records the delivery but never promotes the connection's status", async () => {
    await prisma.channelConnection.update({
      where: { id: whatsappId },
      data: { status: "needs_reconnect", lastError: "401: Unauthorized" },
    });

    await deliver(whatsappBody(A.phone, "hello")).expect(200);
    await settle();

    const row = await prisma.channelConnection.findUniqueOrThrow({ where: { id: whatsappId } });
    expect(row.status).toBe("needs_reconnect");
    expect(row.lastEventAt).not.toBeNull();
    expect(row.lastError).toBeNull();
  });
});

// ------------------------------------------------- lists from the registry --

describe("the channel lists", () => {
  it("are the registry's channels plus webchat, everywhere they are enumerated", async () => {
    const expected = [...channelSpecs.map((spec) => spec.channel), "webchat"];
    const volume = await conversationVolume(alpha);
    expect(volume.series.map((s) => s.id)).toEqual(expected);
    expect(expected).toContain("facebook");
  });
});
