import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agent, createUser, createWorkspace, resetDatabase, signedIn } from "./helpers";
import { fakeComposio } from "./fakes/composio";
import { channelSpecs } from "@/server/channels/registry";
import { env } from "@/server/env";
import { prisma } from "@/server/lib/prisma";

/**
 * The connect flow, end to end through the route handlers, with Composio
 * replaced by the fake. What is being checked throughout is that "connected"
 * is earned: the account has to exist, belong to this workspace, be ACTIVE,
 * and answer a real read call before any row is allowed to claim it.
 */

const AUTH = {
  whatsapp: "ac_test_whatsapp",
  telegram: "ac_test_telegram",
  instagram: "ac_test_instagram",
  gmail: "ac_test_gmail",
} as const;

const original = {
  key: env.COMPOSIO_API_KEY,
  whatsapp: env.COMPOSIO_AUTH_CONFIG_WHATSAPP,
  telegram: env.COMPOSIO_AUTH_CONFIG_TELEGRAM,
  instagram: env.COMPOSIO_AUTH_CONFIG_INSTAGRAM,
  gmail: env.COMPOSIO_AUTH_CONFIG_GMAIL,
};

beforeAll(() => {
  env.COMPOSIO_API_KEY = "ck_test";
  env.COMPOSIO_AUTH_CONFIG_WHATSAPP = AUTH.whatsapp;
  env.COMPOSIO_AUTH_CONFIG_TELEGRAM = AUTH.telegram;
  env.COMPOSIO_AUTH_CONFIG_INSTAGRAM = AUTH.instagram;
  env.COMPOSIO_AUTH_CONFIG_GMAIL = AUTH.gmail;
});

afterAll(() => {
  env.COMPOSIO_API_KEY = original.key;
  env.COMPOSIO_AUTH_CONFIG_WHATSAPP = original.whatsapp;
  env.COMPOSIO_AUTH_CONFIG_TELEGRAM = original.telegram;
  env.COMPOSIO_AUTH_CONFIG_INSTAGRAM = original.instagram;
  env.COMPOSIO_AUTH_CONFIG_GMAIL = original.gmail;
});

let workspaceId: string;

const TELEGRAM_IDENTITY = { successful: true, data: { result: { id: 42, username: "lipibot" } }, error: null };
const GMAIL_IDENTITY = { successful: true, data: { emailAddress: "sales@acme.test" }, error: null };
const numbers = (...ids: string[]) => ({
  successful: true,
  error: null,
  data: { data: ids.map((id, i) => ({ id, display_phone_number: `+9199000000${i}`, verified_name: `Acme ${i}` })) },
});

beforeEach(async () => {
  await resetDatabase();
  const { user } = await createUser();
  const workspace = await createWorkspace({ userId: user.id });
  workspaceId = workspace.id;

  // The fake resets before every test, so the auth configs it maps to
  // toolkits are registered here rather than once.
  for (const [channel, id] of Object.entries(AUTH)) {
    fakeComposio.authConfigs.set(id, channel === "gmail" ? "gmail" : channel);
  }
  fakeComposio.execute.respond("TELEGRAM_GET_ME", TELEGRAM_IDENTITY);
  fakeComposio.execute.respond("GMAIL_GET_PROFILE", GMAIL_IDENTITY);
});

const connection = (channel: string) =>
  prisma.channelConnection.findUnique({
    where: { workspaceId_channel: { workspaceId, channel: channel as never } },
  });

describe("starting a connection", () => {
  it("issues a Connect Link and leaves the row pending", async () => {
    const app = await signedIn();
    const res = await app.post("/v1/channels/email/connect").expect(201);

    expect(res.body.redirectUrl).toMatch(/^https:\/\/connect\.composio\.test\/link\//);
    expect(res.body.channel).toMatchObject({ channel: "email", status: "pending" });

    const [call] = fakeComposio.calls.link;
    expect(call).toMatchObject({ userId: workspaceId, authConfigId: AUTH.gmail, alias: "email" });
    expect(call?.callbackUrl).toBe(`${env.PUBLIC_URL}/v1/channels/callback`);

    const row = await connection("email");
    expect(row).toMatchObject({ status: "pending", composioAuthConfigId: AUTH.gmail, connectedAt: null });
    expect(row?.composioAccountId).toBeTruthy();
  });

  it("never returns the connected account id in full", async () => {
    const app = await signedIn();
    const res = await app.post("/v1/channels/email/connect").expect(201);
    const row = await connection("email");

    expect(res.text).not.toContain(row!.composioAccountId!);
    expect(res.body.channel.accountRef).toBe(`…${row!.composioAccountId!.slice(-4)}`);
  });

  it("refuses a channel this deployment has no auth config for, naming the key", async () => {
    env.COMPOSIO_AUTH_CONFIG_INSTAGRAM = undefined;
    try {
      const app = await signedIn();
      const res = await app.post("/v1/channels/instagram/connect").expect(400);
      expect(res.body.error).toContain("COMPOSIO_AUTH_CONFIG_INSTAGRAM");
    } finally {
      env.COMPOSIO_AUTH_CONFIG_INSTAGRAM = AUTH.instagram;
    }
  });

  it("refuses a channel with no spec", async () => {
    const app = await signedIn();
    const res = await app.post("/v1/channels/webchat/connect").expect(400);
    expect(res.body.error).toContain("webchat");
  });

  it("turns a Composio failure into a 502 the operator can read", async () => {
    const app = await signedIn();
    const boom = new Error("auth config ac_test_gmail was deleted");
    const link = fakeComposio.link.bind(fakeComposio);
    fakeComposio.link = async () => { throw boom; };
    try {
      const res = await app.post("/v1/channels/email/connect").expect(502);
      expect(res.body.error).toContain("was deleted");
    } finally {
      fakeComposio.link = link;
    }
  });
});

describe("an API-key channel", () => {
  const token = "1234567890:AAH-this-looks-like-a-bot-token";

  it("hands the key to Composio, stores none of it, and finishes inline", async () => {
    const app = await signedIn();
    const res = await app.post("/v1/channels/telegram/connect").send({ token }).expect(201);

    expect(res.body.redirectUrl).toBeNull();
    expect(res.body.channel).toMatchObject({ status: "connected", displayName: "@lipibot" });

    expect(fakeComposio.calls.initiateApiKey).toEqual([
      { userId: workspaceId, authConfigId: AUTH.telegram, apiKey: token, field: "generic_api_key" },
    ]);

    const row = await connection("telegram");
    expect(row).toMatchObject({ status: "connected", externalId: "42", displayName: "@lipibot" });
    expect(row?.connectedAt).toBeInstanceOf(Date);
    // The token is the one thing that must not survive this request. There is
    // no longer a column it could survive in, so the whole row is the check.
    expect(JSON.stringify(row)).not.toContain(token);
    expect(res.text).not.toContain(token);
  });

  it("rejects a token that is obviously not one, without touching Composio", async () => {
    const app = await signedIn();
    await app.post("/v1/channels/telegram/connect").send({ token: "short" }).expect(422);
    expect(fakeComposio.calls.initiateApiKey).toEqual([]);
  });

  it("reports the failure when the account cannot answer", async () => {
    fakeComposio.execute.respond("TELEGRAM_GET_ME", { successful: false, data: {}, error: "Unauthorized" });
    const app = await signedIn();
    const res = await app.post("/v1/channels/telegram/connect").send({ token }).expect(400);

    expect(res.body.error).toContain("Unauthorized");
    expect(await connection("telegram")).toMatchObject({ status: "error", lastError: "Unauthorized" });
  });
});

describe("the callback", () => {
  const start = async (channel: string) => {
    const app = await signedIn();
    await app.post(`/v1/channels/${channel}/connect`).expect(201);
    const row = await connection(channel);
    return { app, row: row!, accountId: row!.composioAccountId! };
  };

  it("does not believe status=success when the account is not active", async () => {
    const { app, accountId } = await start("email");
    // The fake's link() leaves the account INITIATED, which is exactly the
    // state an abandoned consent screen leaves behind.
    await app.get(`/v1/channels/callback?status=success&connected_account_id=${accountId}`).expect(303);

    expect(await connection("email")).toMatchObject({ status: "disconnected", connectedAt: null });
    expect(fakeComposio.calls.execute).toEqual([]);
  });

  it("promotes an active account, runs identity, and records the event", async () => {
    const { app, accountId } = await start("email");
    fakeComposio.accounts.set(accountId, {
      id: accountId, status: "ACTIVE", statusReason: null, userId: workspaceId, toolkit: "gmail",
    });

    const res = await app.get(`/v1/channels/callback?connected_account_id=${accountId}`).expect(303);
    expect(res.headers.location).toBe("/dashboard/channels?channel=email");

    const row = await connection("email");
    expect(row).toMatchObject({
      status: "connected", externalId: "sales@acme.test", displayName: "sales@acme.test", lastError: null,
    });
    expect(row?.connectedAt).toBeInstanceOf(Date);

    expect(fakeComposio.calls.execute).toMatchObject([
      { slug: "GMAIL_GET_PROFILE", userId: workspaceId, connectedAccountId: accountId },
    ]);
    const events = await prisma.twinEvent.findMany({ where: { workspaceId, type: "channel.connected" } });
    expect(events).toHaveLength(1);

    const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
    expect(workspace?.channels).toContain("email");
  });

  it("refuses an account Composio says belongs to another workspace", async () => {
    const { app, accountId } = await start("email");
    fakeComposio.accounts.set(accountId, {
      id: accountId, status: "ACTIVE", statusReason: null, userId: "ws_someone_else", toolkit: "gmail",
    });

    await app.get(`/v1/channels/callback?connected_account_id=${accountId}`).expect(404);
    expect(await connection("email")).toMatchObject({ status: "pending" });
  });

  it("404s on an account this workspace never started", async () => {
    const app = await signedIn();
    await app.get("/v1/channels/callback?connected_account_id=ca_nothing").expect(404);
  });

  it("leaves the row in error when a post-connect hook throws", async () => {
    const whatsapp = channelSpecs.find((spec) => spec.channel === "whatsapp")!;
    const hook = whatsapp.afterConnect;
    whatsapp.afterConnect = async () => { throw new Error("WABA is not subscribed"); };
    try {
      fakeComposio.execute.respond("WHATSAPP_GET_PHONE_NUMBERS", numbers("111"));
      const { app, accountId } = await start("whatsapp");
      fakeComposio.accounts.set(accountId, {
        id: accountId, status: "ACTIVE", statusReason: null, userId: workspaceId, toolkit: "whatsapp",
      });

      await app.get(`/v1/channels/callback?connected_account_id=${accountId}`).expect(303);
      expect(await connection("whatsapp")).toMatchObject({
        status: "error", lastError: "WABA is not subscribed", connectedAt: null,
      });
    } finally {
      whatsapp.afterConnect = hook;
    }
  });
});

describe("choosing a WhatsApp number", () => {
  const connectWhatsApp = async (...ids: string[]) => {
    fakeComposio.execute.respond("WHATSAPP_GET_PHONE_NUMBERS", numbers(...ids));
    const app = await signedIn();
    await app.post("/v1/channels/whatsapp/connect").expect(201);
    const pending = await connection("whatsapp");
    fakeComposio.accounts.set(pending!.composioAccountId!, {
      id: pending!.composioAccountId!, status: "ACTIVE", statusReason: null,
      userId: workspaceId, toolkit: "whatsapp",
    });
    await app.get(`/v1/channels/callback?connected_account_id=${pending!.composioAccountId}`).expect(303);
    return app;
  };

  it("picks the only number by itself", async () => {
    await connectWhatsApp("555");
    expect(await connection("whatsapp")).toMatchObject({
      status: "connected", externalId: "555", config: { phoneNumberId: "555" },
    });
  });

  it("leaves the choice open when there are several, and PATCH settles it", async () => {
    const app = await connectWhatsApp("111", "222");

    const before = await connection("whatsapp");
    expect(before?.status).toBe("connected");
    expect(before?.externalId).toBeNull();
    expect((before?.config as { phoneNumbers: { id: string }[] }).phoneNumbers).toHaveLength(2);

    await app.patch("/v1/channels/whatsapp").send({ phoneNumberId: "222" }).expect(200);
    expect(await connection("whatsapp")).toMatchObject({
      externalId: "222", config: { phoneNumberId: "222" },
    });
  });

  it("refuses a number that is not on the account", async () => {
    const app = await connectWhatsApp("111", "222");
    await app.patch("/v1/channels/whatsapp").send({ phoneNumberId: "999" }).expect(422);
    expect((await connection("whatsapp"))?.externalId).toBeNull();
  });

  it("refuses a number another workspace already sends from", async () => {
    const app = await connectWhatsApp("111", "222");
    await app.patch("/v1/channels/whatsapp").send({ phoneNumberId: "222" }).expect(200);

    const { user } = await createUser("second@test.local");
    const other = await createWorkspace({ userId: user.id, name: "Second Co", withCatalogue: false });
    await prisma.channelConnection.create({
      data: {
        workspaceId: other.id, channel: "whatsapp", status: "connected",
        config: { phoneNumbers: [{ id: "222", display: "+919900000001", verifiedName: "Acme 1" }] },
      },
    });

    const rival = await signedIn("second@test.local");
    const res = await rival.patch("/v1/channels/whatsapp")
      .set("x-workspace-id", other.id)
      .send({ phoneNumberId: "222" })
      .expect(409);
    expect(res.body.error).toContain("already connected");
  });
});

describe("the list", () => {
  it("carries the catalog, the webchat snippet and no webhook URL", async () => {
    const app = await signedIn();
    const res = await app.get("/v1/channels").expect(200);

    const byChannel: Record<string, { installSnippet: string | null }> = Object.fromEntries(
      (res.body.channels as { channel: string; installSnippet: string | null }[])
        .map((row) => [row.channel, row]),
    );
    expect(Object.keys(byChannel).sort()).toEqual(
      ["email", "instagram", "telegram", "webchat", "whatsapp"],
    );
    expect(byChannel.telegram).toMatchObject({
      label: "Telegram", connectKind: "api_key", available: true, status: "disconnected",
    });
    expect(byChannel.email).toMatchObject({ inbound: { kind: "composio_trigger" } });
    expect(byChannel.webchat).toMatchObject({ status: "connected", connectKind: "none" });
    expect(byChannel.webchat.installSnippet).toContain(workspaceId);
    expect(res.text).not.toContain("webhookUrl");
    expect(res.text).not.toContain("verifyToken");
  });

  it("marks a channel unavailable when this deployment has no auth config for it", async () => {
    env.COMPOSIO_AUTH_CONFIG_WHATSAPP = undefined;
    try {
      const app = await signedIn();
      const res = await app.get("/v1/channels").expect(200);
      const whatsapp = (res.body.channels as { channel: string; available: boolean }[])
        .find((row) => row.channel === "whatsapp");
      expect(whatsapp).toMatchObject({ available: false });
    } finally {
      env.COMPOSIO_AUTH_CONFIG_WHATSAPP = AUTH.whatsapp;
    }
  });

  it("gives up on a pending row once its Connect Link has expired", async () => {
    const app = await signedIn();
    await app.post("/v1/channels/email/connect").expect(201);
    const pending = await connection("email");
    fakeComposio.accounts.set(pending!.composioAccountId!, {
      id: pending!.composioAccountId!, status: "EXPIRED", statusReason: "Link expired",
      userId: workspaceId, toolkit: "gmail",
    });

    // Still inside the ten minutes Composio allows: nothing is touched.
    await app.get("/v1/channels").expect(200);
    expect(await connection("email")).toMatchObject({ status: "pending" });
    expect(fakeComposio.calls.getAccount).toEqual([]);

    // Bound as a JS Date rather than Postgres `now()`: the column is a naive
    // TIMESTAMP and `now()` renders in the session's time zone, which puts
    // the row in the future on any machine that is not on UTC.
    await prisma.$executeRawUnsafe(
      `UPDATE channel_connections SET "updatedAt" = $2 WHERE id = $1`,
      pending!.id,
      new Date(Date.now() - 20 * 60_000),
    );

    await app.get("/v1/channels").expect(200);
    expect(await connection("email")).toMatchObject({
      status: "disconnected", lastError: "Link expired", composioAccountId: null,
    });
  });
});

describe("test and disconnect", () => {
  const connectTelegram = async () => {
    const app = await signedIn();
    await app.post("/v1/channels/telegram/connect")
      .send({ token: "1234567890:AAH-this-looks-like-a-bot-token" }).expect(201);
    return app;
  };

  it("reports a live connection", async () => {
    const app = await connectTelegram();
    const res = await app.post("/v1/channels/telegram/test").expect(200);
    expect(res.body).toEqual({ ok: true, displayName: "@lipibot" });
  });

  it("reports a broken one, and says so on the row", async () => {
    const app = await connectTelegram();
    fakeComposio.execute.respond("TELEGRAM_GET_ME", { successful: false, data: {}, error: "Bot was blocked" });

    const res = await app.post("/v1/channels/telegram/test").expect(400);
    expect(res.body).toMatchObject({ ok: false, error: "Bot was blocked" });
    expect(await connection("telegram")).toMatchObject({ status: "error", lastError: "Bot was blocked" });
  });

  it("removes the triggers and the account, and clears the row", async () => {
    const app = await connectTelegram();
    const row = await connection("telegram");
    const accountId = row!.composioAccountId!;
    await prisma.channelConnection.update({
      where: { id: row!.id }, data: { composioTriggerIds: ["ti_one", "ti_two"] },
    });

    await app.delete("/v1/channels/telegram").expect(204);

    expect(fakeComposio.calls.deleteTrigger).toEqual(["ti_one", "ti_two"]);
    expect(fakeComposio.calls.deleteAccount).toEqual([accountId]);
    expect(await connection("telegram")).toMatchObject({
      status: "disconnected", externalId: null, displayName: null,
      composioAccountId: null, composioAuthConfigId: null, composioTriggerIds: [], connectedAt: null,
    });
    const events = await prisma.twinEvent.findMany({ where: { workspaceId, type: "channel.disconnected" } });
    expect(events).toHaveLength(1);
  });

  it("retires the old account before linking a new one", async () => {
    const app = await connectTelegram();
    const first = (await connection("telegram"))!.composioAccountId!;

    await app.post("/v1/channels/telegram/connect")
      .send({ token: "1234567890:AAH-a-second-bot-token-entirely" }).expect(201);

    expect(fakeComposio.calls.deleteAccount).toEqual([first]);
    expect((await connection("telegram"))?.composioAccountId).not.toBe(first);
  });

  it("404s on a channel that was never connected", async () => {
    const app = await signedIn();
    await app.delete("/v1/channels/instagram").expect(404);
    await app.post("/v1/channels/instagram/test").expect(404);
  });
});

describe("tenancy", () => {
  it("never lets one workspace act on another's connection", async () => {
    const app = await signedIn();
    await app.post("/v1/channels/telegram/connect")
      .send({ token: "1234567890:AAH-this-looks-like-a-bot-token" }).expect(201);
    const mine = (await connection("telegram"))!;

    const { user } = await createUser("outsider@test.local");
    await createWorkspace({ userId: user.id, name: "Outsider", withCatalogue: false });
    const outsider = await signedIn("outsider@test.local");

    await outsider.get(`/v1/channels/callback?connected_account_id=${mine.composioAccountId}`).expect(404);
    await outsider.delete("/v1/channels/telegram").expect(404);

    expect(await connection("telegram")).toMatchObject({ status: "connected" });
  });

  it("keeps the whole flow behind the session", async () => {
    await agent().get("/v1/channels").expect(401);
    await agent().post("/v1/channels/email/connect").expect(401);
    await agent().get("/v1/channels/callback?connected_account_id=ca_1").expect(401);
    await agent().get("/v1/channels/catalog").expect(401);
  });
});
