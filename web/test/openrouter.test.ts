import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatCompletion, stripReasoning, tidyMarkdownLists, unglueTrailingSentence } from "@/server/lib/openrouter";
import { createUser, createWorkspace, resetDatabase } from "./helpers";
import { env } from "@/server/env";
import { prisma } from "@/server/lib/prisma";

describe("tidying run-together lists", () => {
  // The bug: asked for JSON, the model writes its list with spaces instead of
  // newlines, and markdown renders one paragraph full of stray dashes.
  it("puts each bullet on its own line", () => {
    const run = "Here's what we have:  - **Leather Belt** — ₹1,450  - **Linen Shirt** — ₹2,240  - **Polo Classic** — ₹1,196";
    expect(tidyMarkdownLists(run)).toBe(
      "Here's what we have:\n- **Leather Belt** — ₹1,450\n- **Linen Shirt** — ₹2,240\n- **Polo Classic** — ₹1,196",
    );
  });

  it("leaves a reply that already has line breaks alone", () => {
    const good = "Here's what we have:\n- **Belt** — ₹1,450\n- **Shirt** — ₹2,240";
    expect(tidyMarkdownLists(good)).toBe(good);
  });

  // A single dash is punctuation far more often than it is a list.
  it("leaves ordinary prose with a dash alone", () => {
    const prose = "We have 9 in stock - shall I reserve two for you?";
    expect(tidyMarkdownLists(prose)).toBe(prose);
  });

  it("leaves hyphenated words and em dashes alone", () => {
    const prose = "Metro delivery is 2-3 days — and it ships today.";
    expect(tidyMarkdownLists(prose)).toBe(prose);
  });
});

describe("stripping reasoning", () => {
  it("removes a closed think block", () => {
    expect(stripReasoning("<think>hmm, stock is 9</think>\n\n9 left.")).toBe("9 left.");
  });

  it("removes an unclosed one, which has no answer after it", () => {
    expect(stripReasoning("9 left.<think>wait, let me reconsider")).toBe("9 left.");
  });

  it("leaves an ordinary reply untouched", () => {
    expect(stripReasoning("9 left in XL/Cobalt.")).toBe("9 left in XL/Cobalt.");
  });
});

describe("ungluing a trailing sentence", () => {
  it("splits a question that ran onto the last list item", () => {
    const glued = "Here you go:\n- **Belt** — ₹1,450\n- **Chino** — ₹1,890  Which size would you like?";
    expect(unglueTrailingSentence(glued)).toBe(
      "Here you go:\n- **Belt** — ₹1,450\n- **Chino** — ₹1,890\n\nWhich size would you like?",
    );
  });

  it("leaves a bullet whose spacing is just spacing", () => {
    const fine = "- **Belt** — ₹1,450  in Black and Tan";
    expect(unglueTrailingSentence(fine)).toBe(fine);
  });

  it("leaves ordinary paragraphs alone", () => {
    const prose = "We have 9 in stock.  Would you like two?";
    expect(unglueTrailingSentence(prose)).toBe(prose);
  });
});

/**
 * The meter lives in the transport, not in the three services, so these are
 * the cases that only the transport can be asked about: that a caller which
 * knows nothing about budgets is metered anyway, and that the meter cannot
 * take down the call it is measuring.
 */
describe("metering at the transport", () => {
  let workspaceId: string;

  beforeEach(async () => {
    await resetDatabase();
    const { user } = await createUser();
    workspaceId = (await createWorkspace({ userId: user.id, withCatalogue: false })).id;
    env.OPENROUTER_API_KEY = "test-key";
  });
  afterEach(() => { env.OPENROUTER_API_KEY = undefined; vi.unstubAllGlobals(); });

  const ask = (meter: { workspaceId: string }) =>
    chatCompletion({ meter: { ...meter, purpose: "twin_chat" }, messages: [{ role: "user", content: "hi" }] });

  it("writes the row itself, so a caller cannot be unmetered by forgetting to", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({
        choices: [{ message: { content: "hello" } }],
        usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
      }), { status: 200 }));

    expect(await ask({ workspaceId })).toBe("hello");

    const row = await prisma.modelCall.findFirstOrThrow({ where: { workspaceId } });
    expect(row).toMatchObject({ purpose: "twin_chat", ok: true, promptTokens: 11, totalTokens: 14, error: null });
  });

  it("does not fail the call it is measuring when the row cannot be written", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "hello" } }] }), { status: 200 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // No such workspace, so the insert violates its foreign key. The spend has
    // already happened by then; refusing the reply would only lose it twice.
    expect(await ask({ workspaceId: "wsp_gone" })).toBe("hello");
    expect(warn.mock.calls.flat().join(" ")).toContain("[metering]");
  });

  it("still raises the provider's own failure after metering it", async () => {
    vi.stubGlobal("fetch", async () => new Response("no credits", { status: 402 }));

    await expect(ask({ workspaceId })).rejects.toThrow("OpenRouter 402");
    expect(await prisma.modelCall.count({ where: { workspaceId, ok: false } })).toBe(1);
  });
});
