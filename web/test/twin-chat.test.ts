import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUser, createWorkspace, resetDatabase, signedIn } from "./helpers";
import { env } from "@/server/env";
import { prisma } from "@/server/lib/prisma";
import { buildBriefing, LOW_STOCK } from "@/server/services/briefing";
import { chatWithTwin } from "@/server/services/twin-chat";
import { ingest } from "@/server/services/ingest";

let workspaceId: string;

async function setup() {
  const { user } = await createUser();
  const workspace = await createWorkspace({ userId: user.id });
  workspaceId = workspace.id;
  return workspace;
}

beforeEach(async () => { await resetDatabase(); });

describe("the briefing", () => {
  it("reports stock net of reservations", async () => {
    await setup();
    const variant = await prisma.variant.findFirstOrThrow({
      where: { product: { workspaceId, name: "Polo Classic" } },
    });
    await prisma.variant.update({ where: { id: variant.id }, data: { stock: 40, reserved: 15 } });

    const briefing = await buildBriefing(workspaceId);
    expect(briefing.text).toContain(`${variant.optionA}/${variant.optionB}: 25, 15 reserved`);
  });

  it("flags a variant at the reorder point as low", async () => {
    await setup();
    const variant = await prisma.variant.findFirstOrThrow({ where: { product: { workspaceId } } });
    await prisma.variant.update({ where: { id: variant.id }, data: { stock: LOW_STOCK, reserved: 0 } });

    const briefing = await buildBriefing(workspaceId);
    expect(briefing.text).toContain("[LOW]");
    expect(briefing.facts.lowStock).toBeGreaterThan(0);
  });

  it("carries the orders a real message produced", async () => {
    await setup();
    await ingest({ workspaceId, channel: "whatsapp", handle: "+91 90 000 0001", text: "need 2 blue XL polos" });

    const order = await prisma.order.findFirstOrThrow({ where: { workspaceId } });
    const briefing = await buildBriefing(workspaceId);

    expect(briefing.text).toContain(order.id);
    expect(briefing.facts.openOrders).toBe(1);
    expect(briefing.facts.pipelineInr).toBeGreaterThan(0);
  });

  it("carries the policies the workspace taught, so the twin may assert them", async () => {
    await setup();
    const entry = await prisma.knowledgeEntry.findFirstOrThrow({ where: { workspaceId } });
    expect((await buildBriefing(workspaceId)).text).toContain(entry.title);
  });

  it("is scoped to one workspace", async () => {
    const mine = await setup();
    const { user } = await createUser("other@test.local");
    const theirs = await createWorkspace({ userId: user.id, name: "Other Co" });

    const briefing = await buildBriefing(mine.id);
    expect(briefing.text).toContain("Test Co");
    expect(briefing.text).not.toContain("Other Co");
    expect(theirs.id).not.toBe(mine.id);
  });
});

describe("chatting with the twin", () => {
  // `test/setup.ts` unsets the key, so this is the keyless path by default.
  // Nothing here touches the network.
  it("answers a stock question from the snapshot when no model is configured", async () => {
    await setup();
    const result = await chatWithTwin(workspaceId, [{ role: "user", content: "what is running low?" }]);

    expect(result.source).toBe("rules");
    expect(result.facts.products).toBeGreaterThan(0);
    expect(result.reply.length).toBeGreaterThan(0);
  });

  it("writes nothing: asking is not selling", async () => {
    await setup();
    const before = await prisma.variant.findMany({ where: { product: { workspaceId } }, orderBy: { id: "asc" } });

    await chatWithTwin(workspaceId, [{ role: "user", content: "I need 4 blue XL polos" }]);

    const after = await prisma.variant.findMany({ where: { product: { workspaceId } }, orderBy: { id: "asc" } });
    expect(after).toEqual(before);
    expect(await prisma.order.count({ where: { workspaceId } })).toBe(0);
    expect(await prisma.conversation.count({ where: { workspaceId } })).toBe(0);
    expect(await prisma.customer.count({ where: { workspaceId } })).toBe(0);
  });
});

describe("with a model configured", () => {
  // The key is read at call time, so setting it here exercises the model
  // branch; `fetch` is stubbed so no request ever leaves the process.
  beforeEach(() => { env.OPENROUTER_API_KEY = "test-key"; });
  afterEach(() => { env.OPENROUTER_API_KEY = undefined; vi.unstubAllGlobals(); });

  it("sends the briefing as the system prompt and returns the model's reply", async () => {
    await setup();
    let sent: { model: string; messages: { role: string; content: string }[] } | null = null;

    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      sent = JSON.parse(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: "9 left in XL/Cobalt." } }] }), { status: 200 });
    });

    const result = await chatWithTwin(workspaceId, [{ role: "user", content: "how many cobalt XL?" }]);

    expect(result.source).toBe("openrouter");
    expect(result.reply).toBe("9 left in XL/Cobalt.");
    expect(sent!.messages[0]!.role).toBe("system");
    // The grounding is the point: a prompt without live stock is a guess.
    expect(sent!.messages[0]!.content).toContain("INVENTORY");
    expect(sent!.messages[0]!.content).toContain("Polo Classic");
    expect(sent!.messages[1]).toEqual({ role: "user", content: "how many cobalt XL?" });
  });

  it("falls back to the snapshot and reports why when the model fails", async () => {
    await setup();
    vi.stubGlobal("fetch", async () => new Response("no credits", { status: 402 }));

    const result = await chatWithTwin(workspaceId, [{ role: "user", content: "what is running low?" }]);

    expect(result.source).toBe("rules");
    expect(result.degraded).toContain("402");
    expect(result.reply.length).toBeGreaterThan(0);
  });
});

describe("the chat endpoint", () => {
  it("refuses an anonymous caller", async () => {
    await setup();
    const { agent } = await import("./helpers");
    await agent().post("/v1/twin/chat").send({ messages: [{ role: "user", content: "hi" }] }).expect(401);
  });

  it("rejects a malformed thread", async () => {
    await setup();
    const a = await signedIn();
    await a.post("/v1/twin/chat").send({ messages: [] }).expect(422);
  });

  it("answers a signed-in operator", async () => {
    await setup();
    const a = await signedIn();
    const res = await a.post("/v1/twin/chat").send({ messages: [{ role: "user", content: "how many open orders?" }] }).expect(200);

    expect(res.body.reply).toBeTypeOf("string");
    expect(res.body.facts).toHaveProperty("openOrders");
  });
});

describe("reasoning models", () => {
  beforeEach(() => { env.OPENROUTER_API_KEY = "test-key"; });
  afterEach(() => { env.OPENROUTER_API_KEY = undefined; vi.unstubAllGlobals(); });

  it("asks the provider not to send the scratchpad", async () => {
    await setup();
    let body: { reasoning?: { exclude?: boolean } } = {};
    vi.stubGlobal("fetch", async (_u: string, init: { body: string }) => {
      body = JSON.parse(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: "9 left." } }] }), { status: 200 });
    });

    await chatWithTwin(workspaceId, [{ role: "user", content: "stock?" }]);
    expect(body.reasoning).toEqual({ exclude: true });
  });

  // Belt and braces: a model that inlines its thinking anyway must not have it
  // shown to the operator as if it were the answer.
  it("strips inline think tags from the reply", async () => {
    await setup();
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({
        choices: [{ message: { content: "<think>The user wants stock. Let me check.</think>\n\n9 left in XL/Cobalt." } }],
      }), { status: 200 }));

    const result = await chatWithTwin(workspaceId, [{ role: "user", content: "stock?" }]);
    expect(result.reply).toBe("9 left in XL/Cobalt.");
    expect(result.reply).not.toContain("<think>");
  });

  it("asks for the reply inside a JSON field, so deliberation cannot leak", async () => {
    await setup();
    let body: { response_format?: { json_schema?: { name?: string } } } = {};
    vi.stubGlobal("fetch", async (_u: string, init: { body: string }) => {
      body = JSON.parse(init.body);
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ reply: "**9** left in XL/Cobalt." }) } }],
      }), { status: 200 });
    });

    const result = await chatWithTwin(workspaceId, [{ role: "user", content: "stock?" }]);
    expect(body.response_format?.json_schema?.name).toBe("reply");
    expect(result.reply).toBe("**9** left in XL/Cobalt.");
  });

  // A model that ignores the schema still answers; its prose is the reply.
  it("uses raw content when the model does not return the shape", async () => {
    await setup();
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "9 left." } }] }), { status: 200 }));

    const result = await chatWithTwin(workspaceId, [{ role: "user", content: "stock?" }]);
    expect(result.reply).toBe("9 left.");
  });

  it("treats a reply that is only an unclosed thought as no content", async () => {
    await setup();
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "<think>Hmm, let me work through" } }] }), { status: 200 }));

    const result = await chatWithTwin(workspaceId, [{ role: "user", content: "what is low?" }]);
    expect(result.source).toBe("rules");
    expect(result.reply).not.toContain("Hmm");
  });
});

describe("truncated replies", () => {
  beforeEach(() => { env.OPENROUTER_API_KEY = "test-key"; });
  afterEach(() => { env.OPENROUTER_API_KEY = undefined; vi.unstubAllGlobals(); });

  // The failure this guards against: a reasoning model deliberates past the
  // token limit, the JSON never closes, and the half-finished train of
  // thought gets handed to the user as if it were the answer.
  it("refuses a reply cut off at the token limit", async () => {
    await setup();
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({
        choices: [{
          message: { content: 'We need to follow instructions. The user asks about stock. We should probably {"reply": "9 le' },
          finish_reason: "length",
        }],
      }), { status: 200 }));

    const result = await chatWithTwin(workspaceId, [{ role: "user", content: "what is low?" }]);

    expect(result.source).toBe("rules");
    expect(result.degraded).toContain("token limit");
    expect(result.reply).not.toContain("We need to follow instructions");
  });
});
