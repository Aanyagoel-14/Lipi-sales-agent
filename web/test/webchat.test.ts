import { beforeEach, describe, expect, it } from "vitest";
import { agent, createUser, createWorkspace, resetDatabase } from "./helpers";
import { prisma } from "@/server/lib/prisma";
import { EMPTY_TOUCH } from "@/server/services/attribution";
import {
  listAgentMessagesSince, sendVisitorMessage, upsertSession,
} from "@/server/services/webchat";
import { _resetRateLimitsForTests } from "@/server/lib/rate-limit";

/**
 * The webchat channel: the one path where the visitor's own HTTP request is
 * the transport, so the reply comes back in the response rather than through
 * a provider. `visitorId` is client-minted and is the widget's entire access
 * boundary (see the module note in services/webchat.ts) — most of what is
 * worth testing here is what that boundary refuses.
 *
 * The routes are public and metered, so the rate-limit buckets are cleared
 * between cases: a case that spent the budget must not fail the next one.
 */

const VISITOR = "visitor-web-0001";

let workspaceId: string;

async function setup(policy: "everything" | "money_only" | "nothing" = "nothing", name = "Test Co") {
  const { user } = await createUser(`${name.toLowerCase().replace(/\W+/g, "")}@test.local`);
  const workspace = await createWorkspace({ userId: user.id, name, policy });
  return workspace.id;
}

beforeEach(async () => {
  _resetRateLimitsForTests();
  await resetDatabase();
  workspaceId = await setup();
});

describe("the visitor session", () => {
  it("creates one row on the first page load", async () => {
    const result = await upsertSession({ workspaceId, visitorId: VISITOR, touch: EMPTY_TOUCH });

    const sessions = await prisma.visitorSession.findMany({ where: { workspaceId } });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.visitorId).toBe(VISITOR);
    expect(sessions[0]!.customerId).toBeNull(); // a page load is not yet a customer
    expect(result.sessionId).toBe(sessions[0]!.id);
  });

  it("only bumps lastSeenAt on the second, rather than starting a new visit", async () => {
    const first = await upsertSession({ workspaceId, visitorId: VISITOR, touch: EMPTY_TOUCH });
    const before = await prisma.visitorSession.findFirstOrThrow({ where: { workspaceId, visitorId: VISITOR } });

    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await upsertSession({ workspaceId, visitorId: VISITOR, touch: EMPTY_TOUCH });
    const after = await prisma.visitorSession.findFirstOrThrow({ where: { workspaceId, visitorId: VISITOR } });

    expect(second.sessionId).toBe(first.sessionId);
    expect(await prisma.visitorSession.count({ where: { workspaceId } })).toBe(1);
    expect(after.createdAt).toEqual(before.createdAt);
    expect(after.lastSeenAt.getTime()).toBeGreaterThan(before.lastSeenAt.getTime());
  });

  it("greets with the workspace's own voice", async () => {
    const { greeting } = await upsertSession({ workspaceId, visitorId: VISITOR, touch: EMPTY_TOUCH });
    expect(greeting).toBe("Hi!");
  });

  // A workspace that has not been through onboarding has no voice row yet,
  // and the widget can still be embedded — it names the workspace rather
  // than returning nothing for the one string this call exists to give.
  it("names the workspace when it has no voice configured yet", async () => {
    const bare = await prisma.workspace.create({
      data: { name: "Bare Co", vertical: "apparel", channels: ["whatsapp"] },
    });

    const { greeting } = await upsertSession({ workspaceId: bare.id, visitorId: VISITOR, touch: EMPTY_TOUCH });
    expect(greeting).toBe("Hi! How can Bare Co help?");
  });

  it("keeps the same visitorId in two workspaces apart", async () => {
    const other = await setup("nothing", "Other Co");
    await upsertSession({ workspaceId, visitorId: VISITOR, touch: EMPTY_TOUCH });
    await upsertSession({ workspaceId: other, visitorId: VISITOR, touch: EMPTY_TOUCH });

    expect(await prisma.visitorSession.count({ where: { workspaceId } })).toBe(1);
    expect(await prisma.visitorSession.count({ where: { workspaceId: other } })).toBe(1);
  });
});

describe("a message from a visitor", () => {
  it("still works when no session was ever opened, and opens one", async () => {
    const result = await sendVisitorMessage({ workspaceId, visitorId: VISITOR, text: "do you have olive polos" });

    expect(result.conversationId).toBeTruthy();
    expect(result.reply).toBeTruthy();

    const session = await prisma.visitorSession.findFirstOrThrow({ where: { workspaceId, visitorId: VISITOR } });
    expect(session.customerId).toBe(result.customer.id);
    expect(session.engagedAt).not.toBeNull();
  });

  it("files the customer under the visitor's own handle on the webchat channel", async () => {
    const result = await sendVisitorMessage({ workspaceId, visitorId: VISITOR, text: "hello", name: "Asha" });

    const customer = await prisma.customer.findFirstOrThrow({ where: { workspaceId, id: result.customer.id } });
    expect(customer.handle).toBe(`web:${VISITOR}`);
    expect(customer.channel).toBe("webchat");
    expect(customer.name).toBe("Asha");
  });

  it("keeps the one session row across a whole conversation", async () => {
    await upsertSession({ workspaceId, visitorId: VISITOR, touch: EMPTY_TOUCH });
    await sendVisitorMessage({ workspaceId, visitorId: VISITOR, text: "hello" });
    await sendVisitorMessage({ workspaceId, visitorId: VISITOR, text: "do you have olive polos" });

    expect(await prisma.visitorSession.count({ where: { workspaceId } })).toBe(1);
    expect(await prisma.conversation.count({ where: { workspaceId } })).toBe(2);
    expect(await prisma.customer.count({ where: { workspaceId } })).toBe(1);
  });
});

describe("what the widget is allowed to read back", () => {
  it("returns the agent's reply to the visitor who started the conversation", async () => {
    const sent = await sendVisitorMessage({ workspaceId, visitorId: VISITOR, text: "hello" });

    const messages = await listAgentMessagesSince(workspaceId, VISITOR, sent.conversationId, null);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.text).toBe(sent.reply);
  });

  // The whole access boundary: an id anyone can mint must not read a
  // conversation it did not start.
  it("returns nothing to a visitorId that does not own the conversation", async () => {
    const sent = await sendVisitorMessage({ workspaceId, visitorId: VISITOR, text: "hello" });
    await sendVisitorMessage({ workspaceId, visitorId: "visitor-web-0002", text: "hello too" });

    expect(await listAgentMessagesSince(workspaceId, "visitor-web-0002", sent.conversationId, null)).toEqual([]);
  });

  it("returns nothing to a visitorId with no session at all", async () => {
    const sent = await sendVisitorMessage({ workspaceId, visitorId: VISITOR, text: "hello" });

    expect(await listAgentMessagesSince(workspaceId, "visitor-web-9999", sent.conversationId, null)).toEqual([]);
  });

  // Invariant 5: the workspace in the URL scopes the read, so the same
  // visitorId in another tenant resolves to that tenant's rows or to none.
  it("returns nothing when the conversation belongs to another workspace", async () => {
    const other = await setup("nothing", "Other Co");
    const sent = await sendVisitorMessage({ workspaceId, visitorId: VISITOR, text: "hello" });
    await sendVisitorMessage({ workspaceId: other, visitorId: VISITOR, text: "hello" });

    expect(await listAgentMessagesSince(other, VISITOR, sent.conversationId, null)).toEqual([]);
  });

  it("returns only what landed after the timestamp the widget last saw", async () => {
    const sent = await sendVisitorMessage({ workspaceId, visitorId: VISITOR, text: "hello" });
    const [first] = await listAgentMessagesSince(workspaceId, VISITOR, sent.conversationId, null);

    expect(await listAgentMessagesSince(workspaceId, VISITOR, sent.conversationId, first!.sentIso)).toEqual([]);
  });
});

describe("the routes the widget calls", () => {
  const widget = () => agent();

  it("opens a session and answers with the greeting", async () => {
    const res = await widget().post(`/v1/webchat/${workspaceId}/session`)
      .send({ visitorId: VISITOR, touch: { utmSource: "google", utmMedium: "cpc" } })
      .expect(201);

    expect(res.body.greeting).toBe("Hi!");
    expect(res.headers["access-control-allow-origin"]).toBe("*");

    const session = await prisma.visitorSession.findFirstOrThrow({ where: { workspaceId, visitorId: VISITOR } });
    expect(session.utmSource).toBe("google");
    expect(session.utmCampaign).toBeNull();
  });

  // The dispatcher has no `.options()`, so the exported handler is called
  // directly — a widget on the operator's own site never gets past this.
  it("answers the browser's preflight on all three routes", async () => {
    const routes = await Promise.all([
      import("@/app/v1/webchat/[workspaceId]/session/route"),
      import("@/app/v1/webchat/[workspaceId]/message/route"),
      import("@/app/v1/webchat/[workspaceId]/updates/route"),
    ]);

    for (const route of routes) {
      const res = route.OPTIONS();
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("access-control-allow-headers")).toBe("Content-Type");
    }
  });

  it("carries the CORS headers on a rejection too, or the widget cannot read why", async () => {
    const res = await widget().post(`/v1/webchat/${workspaceId}/session`).expect(422);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  it("404s a workspace id that is not a workspace", async () => {
    await widget().post("/v1/webchat/ws_not_real/session").send({ visitorId: VISITOR }).expect(404);
  });

  it("hands the reply straight back in the response", async () => {
    const res = await widget().post(`/v1/webchat/${workspaceId}/message`)
      .send({ visitorId: VISITOR, text: "do you have olive polos" })
      .expect(201);

    expect(res.body.held).toBe(false);
    expect(res.body.reply).toBeTruthy();
    expect(res.body.conversationId).toBeTruthy();
  });

  it("rejects a visitorId too short to be one the widget minted", async () => {
    await widget().post(`/v1/webchat/${workspaceId}/message`).send({ visitorId: "short", text: "hi" }).expect(422);
  });

  it("needs both a visitorId and a conversationId to poll", async () => {
    await widget().get(`/v1/webchat/${workspaceId}/updates`).query({ visitorId: VISITOR }).expect(422);
  });
});

describe("a reply the approval policy held", () => {
  beforeEach(async () => {
    workspaceId = await setup("everything", "Strict Co");
  });

  it("comes back as held with no text, and is polled for afterwards", async () => {
    const posted = await agent().post(`/v1/webchat/${workspaceId}/message`)
      .send({ visitorId: VISITOR, text: "do you have olive polos" })
      .expect(201);

    expect(posted.body.held).toBe(true);
    expect(posted.body.reply).toBeNull();

    // Held or not, the drafted reply is persisted — that is what the
    // approval queue later releases.
    const conversationId = posted.body.conversationId;
    const stored = await prisma.message.findFirstOrThrow({
      where: { from: "agent", conversation: { id: conversationId, workspaceId } },
    });
    expect(stored.deliveryStatus).toBe("held");

    const polled = await agent().get(`/v1/webchat/${workspaceId}/updates`)
      .query({ visitorId: VISITOR, conversationId })
      .expect(200);

    expect(polled.body.messages).toHaveLength(1);
    expect(polled.body.messages[0].text).toBe(stored.text);
  });

  it("does not leak that reply to another visitor polling the same conversation", async () => {
    const posted = await agent().post(`/v1/webchat/${workspaceId}/message`)
      .send({ visitorId: VISITOR, text: "do you have olive polos" })
      .expect(201);

    const polled = await agent().get(`/v1/webchat/${workspaceId}/updates`)
      .query({ visitorId: "visitor-web-0002", conversationId: posted.body.conversationId })
      .expect(200);

    expect(polled.body.messages).toEqual([]);
  });
});
