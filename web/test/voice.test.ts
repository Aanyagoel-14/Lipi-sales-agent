import { describe, expect, it } from "vitest";
import { composeReply, DEFAULT_VOICE, findKnowledge, voiceViolations } from "@/server/services/voice";
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
