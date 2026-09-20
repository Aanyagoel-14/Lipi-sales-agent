import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agent, createUser, createWorkspace, resetDatabase } from "./helpers";
import { env } from "@/server/env";
import { prisma } from "@/server/lib/prisma";
import { EMPTY_TOUCH } from "@/server/services/attribution";
import { ingest } from "@/server/services/ingest";
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

/** A workspace with an owner of its own: the email is derived from the name
 *  so that a case building a second workspace does not collide on it. */
async function setup(policy: "everything" | "money_only" | "nothing" = "nothing", name = "Test Co") {
  const { user } = await createUser(`${name.toLowerCase().replace(/\W+/g, "")}@test.local`);
  const workspace = await createWorkspace({ userId: user.id, name, policy });
  return workspace.id;
}

const sessionOf = (visitorId = VISITOR) =>
  prisma.visitorSession.findFirstOrThrow({ where: { workspaceId, visitorId } });

/** Long enough for the next write's timestamp to be measurably later. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

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
    const before = await sessionOf();

    await tick();
    const second = await upsertSession({ workspaceId, visitorId: VISITOR, touch: EMPTY_TOUCH });
    const after = await sessionOf();

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

    const session = await sessionOf();
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

  // engagedAt is the moment this visitor stopped browsing and started
  // talking — a first-touch-shaped fact, so a later message must not move it.
  it("stamps engagedAt on the first message and leaves it where it landed", async () => {
    await upsertSession({ workspaceId, visitorId: VISITOR, touch: EMPTY_TOUCH });
    const browsing = await sessionOf();
    expect(browsing.engagedAt).toBeNull(); // a page load is not engagement

    await sendVisitorMessage({ workspaceId, visitorId: VISITOR, text: "hello" });
    const engaged = await sessionOf();
    expect(engaged.engagedAt).not.toBeNull();

    await tick();
    await sendVisitorMessage({ workspaceId, visitorId: VISITOR, text: "do you have olive polos" });
    const later = await sessionOf();

    expect(later.engagedAt).toEqual(engaged.engagedAt);
    expect(later.lastSeenAt.getTime()).toBeGreaterThan(engaged.lastSeenAt.getTime());
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

  // The other half of the same guard: a visitor who loaded the widget but
  // never typed has a session row and no customer, so there is no
  // conversation of theirs to match — and someone else's must not do.
  it("returns nothing to a visitor who has a session but has never messaged", async () => {
    const sent = await sendVisitorMessage({ workspaceId, visitorId: VISITOR, text: "hello" });
    await upsertSession({ workspaceId, visitorId: "visitor-web-0003", touch: EMPTY_TOUCH });

    expect(await listAgentMessagesSince(workspaceId, "visitor-web-0003", sent.conversationId, null)).toEqual([]);
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
  it("opens a session and answers with the greeting", async () => {
    const res = await agent().post(`/v1/webchat/${workspaceId}/session`)
      .send({ visitorId: VISITOR, touch: { utmSource: "google", utmMedium: "cpc" } })
      .expect(201);

    expect(res.body.greeting).toBe("Hi!");
    expect(res.headers["access-control-allow-origin"]).toBe("*");

    const session = await sessionOf();
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
    const res = await agent().post(`/v1/webchat/${workspaceId}/session`).expect(422);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  it("404s a workspace id that is not a workspace", async () => {
    await agent().post("/v1/webchat/ws_not_real/session").send({ visitorId: VISITOR }).expect(404);
  });

  it("hands the reply straight back in the response", async () => {
    const res = await agent().post(`/v1/webchat/${workspaceId}/message`)
      .send({ visitorId: VISITOR, text: "do you have olive polos" })
      .expect(201);

    expect(res.body.held).toBe(false);
    expect(res.body.reply).toBeTruthy();
    expect(res.body.conversationId).toBeTruthy();
  });

  it("rejects a visitorId too short to be one the widget minted", async () => {
    await agent().post(`/v1/webchat/${workspaceId}/message`).send({ visitorId: "short", text: "hi" }).expect(422);
  });

  it("needs both a visitorId and a conversationId to poll", async () => {
    await agent().get(`/v1/webchat/${workspaceId}/updates`).query({ visitorId: VISITOR }).expect(422);
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

/**
 * The website chat is the AI salesperson, not a form letter.
 *
 * `sendVisitorMessage` goes through `sell()`, so what the visitor reads is
 * the model's words over `ingest()`'s verified facts. These cases stub
 * `fetch` because the suite must never reach OpenRouter (see test/setup.ts).
 */
describe("the salesperson's own voice", () => {
  /**
   * One canned reply per turn, and the requests that asked for them, in
   * order. The last reply stands in for any turn beyond the ones named.
   *
   * Two model calls go out per message: `extract()` asks for the intent
   * first, and `sell()` then asks for the words. Only the second is this
   * describe's subject, so the first is refused and falls back to its own
   * rules — deterministically, exactly as it does with no key set.
   */
  const answers = (...replies: string[]) => {
    const asked: { messages: { role: string; content: string }[] }[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body);
      if (request.response_format?.json_schema?.name !== "reply") {
        return new Response("not the call this case is about", { status: 400 });
      }
      asked.push(request);
      const reply = replies[asked.length - 1] ?? replies.at(-1)!;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reply }) } }] }),
        { status: 200 },
      );
    });
    return asked;
  };

  /** Everything but the system briefing: the conversation the model was given. */
  const turnsOf = (request: { messages: { role: string; content: string }[] }) => request.messages.slice(1);

  beforeEach(() => { env.OPENROUTER_API_KEY = "test-key"; });
  afterEach(() => { env.OPENROUTER_API_KEY = undefined; vi.unstubAllGlobals(); });

  it("sends the model's words to the visitor, not the composed reply", async () => {
    answers("We have those in olive — shall I show you the sizes?");

    const result = await sendVisitorMessage({ workspaceId, visitorId: VISITOR, text: "do you have olive polos" });

    expect(result.voicedBy).toBe("openrouter");
    expect(result.reply).toBe("We have those in olive — shall I show you the sizes?");
    // The conversation must show what the visitor was actually sent.
    const message = await prisma.message.findFirstOrThrow({
      where: { conversationId: result.conversationId, from: "agent" },
    });
    expect(message.text).toBe(result.reply);
  });

  it("falls back to the template when the model fails, and still answers correctly", async () => {
    vi.stubGlobal("fetch", async () => new Response("no credits", { status: 402 }));

    const result = await sendVisitorMessage({ workspaceId, visitorId: VISITOR, text: "do you have olive polos" });

    expect(result.voicedBy).toBe("template");
    expect(result.degraded).toContain("402");
    // Less warm, still the twin's own verified answer.
    expect(result.reply).toMatch(/left in .*Olive/);
  });

  it("falls back to the template when the workspace has no key at all", async () => {
    env.OPENROUTER_API_KEY = undefined;
    vi.stubGlobal("fetch", async () => { throw new Error("the model must not be called"); });

    const result = await sendVisitorMessage({ workspaceId, visitorId: VISITOR, text: "do you have olive polos" });

    expect(result.voicedBy).toBe("template");
    expect(result.reply).toMatch(/left in .*Olive/);
  });

  it("replays the earlier turns, so the third message sees the first two", async () => {
    const asked = answers(
      "We stock polos in four colours.",
      "Olive is in, in every size.",
      "Two XL olive polos, reserved.",
    );

    await sendVisitorMessage({ workspaceId, visitorId: VISITOR, text: "what do you sell?" });
    await sendVisitorMessage({ workspaceId, visitorId: VISITOR, text: "do you have olive polos" });
    await sendVisitorMessage({ workspaceId, visitorId: VISITOR, text: "I need 2 olive XL polos" });

    // The first message has nothing behind it, so the model gets that turn alone.
    expect(turnsOf(asked[0]!)).toEqual([{ role: "user", content: "what do you sell?" }]);
    expect(turnsOf(asked[2]!)).toEqual([
      { role: "user", content: "what do you sell?" },
      { role: "assistant", content: "We stock polos in four colours." },
      { role: "user", content: "do you have olive polos" },
      { role: "assistant", content: "Olive is in, in every size." },
      { role: "user", content: "I need 2 olive XL polos" },
    ]);
  });

  it("replays nothing a different visitor said", async () => {
    const asked = answers("Hello Asha.", "Hello Ben.", "Olive is in.");

    await sendVisitorMessage({ workspaceId, visitorId: VISITOR, text: "my name is Asha" });
    await sendVisitorMessage({ workspaceId, visitorId: "visitor-web-0002", text: "my name is Ben" });
    await sendVisitorMessage({ workspaceId, visitorId: "visitor-web-0002", text: "do you have olive polos" });

    expect(turnsOf(asked[2]!)).toEqual([
      { role: "user", content: "my name is Ben" },
      { role: "assistant", content: "Hello Ben." },
      { role: "user", content: "do you have olive polos" },
    ]);
  });

  // Invariant 5: the same visitorId in two tenants is two visitors, so one
  // tenant's conversation can never be replayed into the other's prompt.
  it("replays nothing the same visitorId said in another workspace", async () => {
    const other = await setup("nothing", "Other Co");
    const asked = answers("Hello Asha.", "Hello again.", "Olive is in.");

    await sendVisitorMessage({ workspaceId, visitorId: VISITOR, text: "my name is Asha" });
    await sendVisitorMessage({ workspaceId: other, visitorId: VISITOR, text: "hello" });
    await sendVisitorMessage({ workspaceId: other, visitorId: VISITOR, text: "do you have olive polos" });

    expect(turnsOf(asked[2]!)).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "Hello again." },
      { role: "user", content: "do you have olive polos" },
    ]);
  });

  // Pinned, not endorsed. `sell()` only rewrites the stored reply when the
  // policy let it go out, so on a workspace that holds everything the model
  // is paid for words the operator never sees: the approval queue releases
  // the composed draft. Fixing it changes what an operator approves, so it
  // is a human's call, not this issue's.
  it("leaves the composed draft in the queue when the policy holds the reply", async () => {
    workspaceId = await setup("everything", "Strict Co");
    answers("Lovely — those are yours.");

    const result = await sendVisitorMessage({ workspaceId, visitorId: VISITOR, text: "do you have olive polos" });

    expect(result.held).toBe(true);
    expect(result.voicedBy).toBe("openrouter");

    const stored = await prisma.message.findFirstOrThrow({
      where: { conversationId: result.conversationId, from: "agent" },
    });
    expect(stored.deliveryStatus).toBe("held");
    expect(stored.text).not.toBe(result.reply); // DIVERGENCE: the voiced reply is dropped
  });
});

/**
 * The fact path underneath the voice. `sell()` runs `ingest()` itself, so the
 * twins must end up exactly where the old direct call left them — plus the
 * invoice `sell()` has always raised against an order it created.
 */
describe("what a webchat message still does to the twins", () => {
  /** The event types one action appended to a workspace's trail. */
  async function newEvents(workspace: string, action: () => Promise<unknown>) {
    const before = new Set(
      (await prisma.twinEvent.findMany({ where: { workspaceId: workspace }, select: { id: true } })).map((e) => e.id),
    );
    await action();
    const after = await prisma.twinEvent.findMany({
      where: { workspaceId: workspace },
      orderBy: { occurredAt: "asc" },
    });
    return after.filter((e) => !before.has(e.id)).map((e) => e.type);
  }

  // Invariant 6: the event trail is the evidence, so routing the words
  // through the model must not cost the order path a single row.
  it("writes every event ingest wrote on its own, plus the invoice", async () => {
    const BUY = "I need 2 blue XL polos";
    const direct = await setup("nothing", "Ingest Co");

    const viaIngest = await newEvents(direct, () =>
      ingest({ workspaceId: direct, channel: "webchat", handle: `web:${VISITOR}`, text: BUY }));
    const viaWebchat = await newEvents(workspaceId, () =>
      sendVisitorMessage({ workspaceId, visitorId: VISITOR, text: BUY }));

    // If the baseline ever comes back empty the comparison above is vacuous.
    expect(viaIngest).toContain("order_twin.created");
    expect(viaWebchat.filter((type) => type !== "invoice.issued")).toEqual(viaIngest);
    expect(viaWebchat).toContain("invoice.issued");
  });

  it("still reserves the stock and creates the order", async () => {
    const before = await prisma.variant.findFirstOrThrow({
      where: { optionA: "XL", optionB: "Cobalt", product: { workspaceId, name: "Polo Classic" } },
    });

    const result = await sendVisitorMessage({ workspaceId, visitorId: VISITOR, text: "I need 2 blue XL polos" });

    const after = await prisma.variant.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.reserved).toBe(before.reserved + 2);
    expect(result.order!.valueInr).toBeGreaterThan(0);
    expect(await prisma.order.count({ where: { workspaceId } })).toBe(1);
  });
});
