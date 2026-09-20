import { describe, expect, it } from "vitest";
import { composeReply, DEFAULT_VOICE, findKnowledge, rankKnowledge, voiceViolations } from "@/server/services/voice";
import type { KnowledgeEntry } from "@/generated/prisma/client";

const parts = { core: "Reserved 2 for you.", detail: "₹1,196 each.", question: "Want the invoice?" };

describe("composeReply", () => {
  it("keeps only the core when terse", () => {
    const out = composeReply(parts, { ...DEFAULT_VOICE, length: "terse" });
    expect(out).toContain("Reserved 2 for you.");
    expect(out).not.toContain("₹1,196 each.");
  });

  it("includes detail when balanced", () => {
    expect(composeReply(parts, { ...DEFAULT_VOICE, length: "balanced" })).toContain("₹1,196 each.");
  });

  it("drops the greeting when formal", () => {
    const voice = { ...DEFAULT_VOICE, greeting: "Hi!", formality: "formal" as const };
    expect(composeReply(parts, voice)).not.toContain("Hi!");
  });

  it("expands contractions when formal", () => {
    const out = composeReply(parts, { ...DEFAULT_VOICE, formality: "formal" });
    expect(out).toContain("Would you like the invoice?");
  });

  it("appends the sign-off on its own line", () => {
    const out = composeReply(parts, { ...DEFAULT_VOICE, signOff: "— Acme" });
    expect(out.endsWith("\n— Acme")).toBe(true);
  });

  it("adds an emoji only when allowed", () => {
    expect(composeReply(parts, { ...DEFAULT_VOICE, useEmoji: true })).toContain("👍");
    expect(composeReply(parts, DEFAULT_VOICE)).not.toContain("👍");
  });
});

describe("voiceViolations", () => {
  it("reports a banned phrase rather than silently stripping it", () => {
    const found = voiceViolations("This is guaranteed to arrive", { ...DEFAULT_VOICE, neverSay: ["guaranteed"] });
    expect(found).toEqual(["guaranteed"]);
  });

  it("is case insensitive", () => {
    expect(voiceViolations("GUARANTEED", { ...DEFAULT_VOICE, neverSay: ["guaranteed"] })).toHaveLength(1);
  });
});

const entry = (kind: KnowledgeEntry["kind"], title: string, body: string): KnowledgeEntry => ({
  id: title, kind, title, body, createdAt: new Date(), workspaceId: "w",
});

describe("findKnowledge", () => {
  const entries = [
    entry("policy", "Returns window", "Unworn items can be returned within 14 days of delivery."),
    entry("shipping", "Dispatch times", "Orders confirmed before 2pm dispatch the same working day."),
  ];

  it("finds the entry that answers the question", () => {
    expect(findKnowledge("what is your returns policy for unworn items", "return", entries)?.title)
      .toBe("Returns window");
  });

  it("returns nothing rather than guessing", () => {
    expect(findKnowledge("what colour is the sky", "other", entries)).toBeNull();
  });

  it("returns nothing when the twin has been taught nothing", () => {
    expect(findKnowledge("returns policy", "return", [])).toBeNull();
  });
});

describe("rankKnowledge", () => {
  const entries = [
    entry("policy", "Returns window", "Unworn items can be returned within 14 days of delivery."),
    entry("pricing", "Volume discounts", "Orders above 100 units qualify for tiered pricing."),
    entry("shipping", "Dispatch times", "Orders confirmed before 2pm dispatch the same working day."),
  ];

  it("returns every policy the message asks about, not just the first", () => {
    const ranked = rankKnowledge("do you do bulk pricing for 200 units and what is your returns window", "other", entries);
    expect(ranked.map((r) => r.entry.title).sort()).toEqual(["Returns window", "Volume discounts"]);
  });

  it("puts the better match first", () => {
    const ranked = rankKnowledge("returns window for unworn items", "return", entries);
    expect(ranked[0]?.entry.title).toBe("Returns window");
  });

  it("is deterministic whatever order the rows arrive in", () => {
    const text = "bulk pricing units and returns of unworn items";
    const forwards = rankKnowledge(text, "other", entries);
    const backwards = rankKnowledge(text, "other", [...entries].reverse());
    expect(backwards.map((r) => [r.entry.title, r.score])).toEqual(forwards.map((r) => [r.entry.title, r.score]));
  });

  it("returns nothing rather than guessing", () => {
    expect(rankKnowledge("what colour is the sky", "other", entries)).toEqual([]);
  });

  it("never returns more than it was asked for", () => {
    expect(rankKnowledge("returns of unworn items and bulk pricing units", "other", entries, 1)).toHaveLength(1);
  });

  it("is what findKnowledge picks from", () => {
    const text = "what is your returns policy for unworn items";
    expect(findKnowledge(text, "return", entries)?.title).toBe(rankKnowledge(text, "return", entries)[0]?.entry.title);
  });
});
