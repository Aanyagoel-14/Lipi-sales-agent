import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agent, createUser, createWorkspace, resetDatabase, signedIn } from "./helpers";
import { env } from "@/server/env";
import { prisma } from "@/server/lib/prisma";
import { checkModelBudget, modelSpend, startOfDayUtc } from "@/server/lib/metering";
import { sell } from "@/server/services/selling";
import { chatWithTwin } from "@/server/services/twin-chat";
import type { ModelPurpose } from "@/generated/prisma/client";

let workspaceId: string;

async function setup() {
  const { user } = await createUser();
  workspaceId = (await createWorkspace({ userId: user.id, policy: "nothing" })).id;
}

/** The defaults are far too high to reach in a test, so a test that needs a ceiling sets it. */
const ceilings = (data: { dailyModelCalls?: number; dailyModelTokens?: number; customerModelCalls?: number }) =>
  prisma.workspace.update({ where: { id: workspaceId }, data });

const buy = (text: string, handle = "+91 90 000 5555") =>
  sell({ workspaceId, channel: "webchat", handle, name: "Walk-in", text });

/** A model that answers, in the shape OpenRouter answers in. */
const answers = (content: string, usage?: { prompt: number; completion: number }) =>
  vi.stubGlobal("fetch", async () =>
    new Response(
      // An absent `usage` is dropped by JSON.stringify, which is the body a
      // provider that reports no tokens sends.
      JSON.stringify({
        choices: [{ message: { content } }],
        usage: usage && {
          prompt_tokens: usage.prompt,
          completion_tokens: usage.completion,
          total_tokens: usage.prompt + usage.completion,
        },
      }),
      { status: 200 },
    ));

/** Spend already on the clock, written the way `recordModelCall` writes it. */
async function alreadySpent(count: number, opts: { tokens?: number; customerId?: string; on?: Date } = {}) {
  await prisma.modelCall.createMany({
    data: Array.from({ length: count }, () => ({
      workspaceId,
      customerId: opts.customerId ?? null,
      purpose: "sell" as ModelPurpose,
      model: "test/model",
      totalTokens: opts.tokens ?? null,
      latencyMs: 10,
      ok: true,
      ...(opts.on ? { occurredAt: opts.on } : {}),
    })),
  });
}

const calls = () => prisma.modelCall.findMany({ where: { workspaceId }, orderBy: { occurredAt: "asc" } });

beforeEach(async () => {
  await resetDatabase();
  env.OPENROUTER_API_KEY = "test-key";
});
afterEach(() => { env.OPENROUTER_API_KEY = undefined; vi.unstubAllGlobals(); });

describe("metering every model call", () => {
  it("writes one row per call, named by what spent it", async () => {
    await setup();
    answers("Lovely, those are reserved for you.");

    const result = await buy("I need 2 blue XL polos");

    expect(result.voicedBy).toBe("openrouter");
    const rows = await calls();
    // One extraction, one voicing: the two calls a customer message costs.
    expect(rows.map((r) => r.purpose)).toEqual(["extract", "sell"]);
    expect(rows.every((r) => r.ok)).toBe(true);
    expect(rows.every((r) => r.workspaceId === workspaceId)).toBe(true);
    expect(rows.every((r) => r.latencyMs >= 0)).toBe(true);
  });

  it("records the model each call asked for, not one name for both", async () => {
    await setup();
    answers("Right you are.");

    await buy("do you have XL polos?");

    const rows = await calls();
    expect(rows.find((r) => r.purpose === "extract")!.model).toBe(env.OPENROUTER_MODEL);
    expect(rows.find((r) => r.purpose === "sell")!.model).toBe(env.OPENROUTER_CHAT_MODEL);
  });

  it("records the tokens the response reported", async () => {
    await setup();
    answers("Reserved.", { prompt: 900, completion: 60 });

    await buy("I need 2 blue XL polos");

    const voicing = (await calls()).find((r) => r.purpose === "sell")!;
    expect(voicing.promptTokens).toBe(900);
    expect(voicing.completionTokens).toBe(60);
    expect(voicing.totalTokens).toBe(960);
  });

  it("meters a call that failed, with the reason", async () => {
    await setup();
    vi.stubGlobal("fetch", async () => new Response("no credits", { status: 402 }));

    const result = await buy("I need 2 blue XL polos");

    expect(result.voicedBy).toBe("template");
    const rows = await calls();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.ok)).toBe(false);
    expect(rows.every((r) => r.error?.includes("402"))).toBe(true);
    // The sale is unaffected: only the words degraded.
    expect(result.order).not.toBeNull();
  });

  it("meters a timeout, which cost a call and reported no tokens", async () => {
    await setup();
    vi.stubGlobal("fetch", async () => { throw new Error("The operation was aborted due to timeout"); });

    await buy("I need 2 blue XL polos");

    const rows = await calls();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => !r.ok && r.totalTokens === null)).toBe(true);
    expect(rows[1]!.error).toContain("timeout");
  });

  it("charges a truncated reply for the tokens it burned", async () => {
    await setup();
    vi.stubGlobal("fetch", async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "Let me think about" }, finish_reason: "length" }],
          usage: { prompt_tokens: 1200, completion_tokens: 2000, total_tokens: 3200 },
        }),
        { status: 200 },
      ));

    const result = await buy("I need 2 blue XL polos");

    expect(result.voicedBy).toBe("template");
    const voicing = (await calls()).find((r) => r.purpose === "sell")!;
    expect(voicing.ok).toBe(false);
    // A failure that still cost money must still count against the budget.
    expect(voicing.totalTokens).toBe(3200);
  });
});

describe("the per-workspace daily budget", () => {
  it("lets a workspace under its ceiling through", async () => {
    await setup();
    await alreadySpent(5);
    answers("Reserved.");

    const result = await buy("I need 2 blue XL polos");

    expect(result.voicedBy).toBe("openrouter");
    expect(result.degraded).toBeUndefined();
  });

  it("degrades at the call ceiling rather than erroring", async () => {
    await setup();
    await ceilings({ dailyModelCalls: 6 });
    await alreadySpent(6);
    vi.stubGlobal("fetch", async () => { throw new Error("the model must not be called"); });

    const result = await buy("I need 2 blue XL polos");

    expect(result.voicedBy).toBe("template");
    expect(result.degraded).toContain("Daily model call budget spent (6/6)");
    // Degraded, not broken: the order was still placed and priced.
    expect(result.order).not.toBeNull();
    expect(result.reply).toContain("Reserved");
    // And nothing was spent finding that out: still the six already on the clock.
    expect(await calls()).toHaveLength(6);
  });

  it("degrades at the token ceiling too", async () => {
    await setup();
    await ceilings({ dailyModelTokens: 1000 });
    await alreadySpent(2, { tokens: 500 });
    vi.stubGlobal("fetch", async () => { throw new Error("the model must not be called"); });

    const result = await buy("I need 2 blue XL polos");

    expect(result.degraded).toContain("Daily model token budget spent (1000/1000)");
  });

  it("turns the model off entirely at a ceiling of zero", async () => {
    await setup();
    await ceilings({ dailyModelCalls: 0 });
    vi.stubGlobal("fetch", async () => { throw new Error("the model must not be called"); });

    const result = await buy("do you have XL polos?");

    expect(result.voicedBy).toBe("template");
    expect(await calls()).toHaveLength(0);
  });

  it("does not charge one workspace for another's spend", async () => {
    await setup();
    await ceilings({ dailyModelCalls: 4 });

    const { user } = await createUser("other@test.local");
    const other = await createWorkspace({ userId: user.id, name: "Other Co" });
    await prisma.modelCall.createMany({
      data: Array.from({ length: 50 }, () => ({
        workspaceId: other.id, purpose: "sell" as ModelPurpose, model: "test/model", latencyMs: 1, ok: true,
      })),
    });
    answers("Reserved.");

    const result = await buy("I need 2 blue XL polos");

    expect(result.voicedBy).toBe("openrouter");
  });

  it("does not charge today for yesterday's spend", async () => {
    await setup();
    await ceilings({ dailyModelCalls: 4 });
    const yesterday = new Date(startOfDayUtc().getTime() - 60_000);
    await alreadySpent(40, { on: yesterday });
    answers("Reserved.");

    const result = await buy("I need 2 blue XL polos");

    expect(result.voicedBy).toBe("openrouter");
  });

  it("survives a restart, because it is a table and not a Map", async () => {
    await setup();
    answers("Reserved.");
    await buy("I need 2 blue XL polos");

    // Nothing in process memory is consulted: a fresh verdict reads the rows.
    const verdict = await checkModelBudget({ workspaceId, purpose: "sell" });
    expect(verdict.allowed).toBe(true);
    expect((await modelSpend(workspaceId)).today.calls).toBe(2);
  });
});

describe("the per-conversation cap", () => {
  it("stops one customer's thread taking the whole workspace's budget", async () => {
    await setup();
    await ceilings({ customerModelCalls: 4 });
    answers("Reserved.");

    // Two messages from the same handle: two calls each, so the third is over.
    await buy("do you have XL polos?");
    await buy("and in navy?");
    const third = await buy("what about a belt?");

    expect(third.voicedBy).toBe("template");
    expect(third.degraded).toContain("This conversation's daily model call budget is spent");
  });

  it("leaves every other customer served", async () => {
    await setup();
    await ceilings({ customerModelCalls: 2 });
    answers("Reserved.");

    await buy("do you have XL polos?", "+91 90 000 1111");
    const capped = await buy("and in navy?", "+91 90 000 1111");
    const other = await buy("do you have XL polos?", "+91 90 000 2222");

    expect(capped.voicedBy).toBe("template");
    expect(other.voicedBy).toBe("openrouter");
  });

  it("charges the extraction to the thread as well, once the twin exists", async () => {
    await setup();
    answers("Reserved.");
    await buy("do you have XL polos?");
    await buy("and in navy?");

    const customer = await prisma.customer.findFirstOrThrow({ where: { workspaceId } });
    const charged = await prisma.modelCall.findMany({ where: { workspaceId, customerId: customer.id } });
    // Four calls in all; the first extraction predates the twin, so three are
    // attributable to it.
    expect(await prisma.modelCall.count({ where: { workspaceId } })).toBe(4);
    expect(charged.map((r) => r.purpose).sort()).toEqual(["extract", "sell", "sell"]);
  });
});

describe("the operator's own twin chat", () => {
  it("is metered under its own purpose", async () => {
    await setup();
    answers("Nothing is low.");

    const result = await chatWithTwin(workspaceId, [{ role: "user", content: "what is running low?" }]);

    expect(result.source).toBe("openrouter");
    expect((await calls()).map((r) => r.purpose)).toEqual(["twin_chat"]);
  });

  it("answers from the snapshot when the workspace is over its ceiling", async () => {
    await setup();
    await ceilings({ dailyModelCalls: 1 });
    await alreadySpent(1);
    vi.stubGlobal("fetch", async () => { throw new Error("the model must not be called"); });

    const result = await chatWithTwin(workspaceId, [{ role: "user", content: "what is running low?" }]);

    expect(result.source).toBe("rules");
    expect(result.degraded).toContain("Daily model call budget spent");
    expect(result.reply.length).toBeGreaterThan(0);
  });
});

describe("reading the spend", () => {
  it("breaks today down by what spent it, against the ceilings", async () => {
    await setup();
    answers("Reserved.", { prompt: 100, completion: 20 });
    await buy("I need 2 blue XL polos");

    const spend = await modelSpend(workspaceId);

    expect(spend.day).toBe(new Date().toISOString().slice(0, 10));
    expect(spend.today).toEqual({ calls: 2, failed: 0, tokens: 240 });
    expect(spend.byPurpose.map((p) => p.purpose).sort()).toEqual(["extract", "sell"]);
    expect(spend.ceilings.dailyCalls).toBe(2000);
    expect(spend.exhausted).toBe(false);
  });

  it("counts the failures separately, and says when the budget is gone", async () => {
    await setup();
    await ceilings({ dailyModelCalls: 2 });
    vi.stubGlobal("fetch", async () => new Response("no credits", { status: 402 }));
    await buy("I need 2 blue XL polos");

    const spend = await modelSpend(workspaceId);

    expect(spend.today.failed).toBe(2);
    expect(spend.exhausted).toBe(true);
  });

  it("is served to the signed-in operator and nobody else", async () => {
    await setup();
    answers("Reserved.");
    await buy("I need 2 blue XL polos");

    await agent().get("/v1/usage/models").expect(401);

    const a = await signedIn();
    const res = await a.get("/v1/usage/models").expect(200);
    expect(res.body.today.calls).toBe(2);
    expect(res.body.ceilings.conversationCalls).toBe(60);
  });

  it("shows a workspace only its own spend", async () => {
    await setup();
    answers("Reserved.");
    await buy("I need 2 blue XL polos");

    const { user } = await createUser("other@test.local");
    await createWorkspace({ userId: user.id, name: "Other Co" });
    const other = await signedIn("other@test.local");

    const res = await other.get("/v1/usage/models").expect(200);
    expect(res.body.today.calls).toBe(0);
  });
});
