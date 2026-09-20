import { beforeEach, describe, expect, it } from "vitest";
import { createUser, createWorkspace, resetDatabase } from "./helpers";
import { prisma } from "@/server/lib/prisma";
import { ingest } from "@/server/services/ingest";
import { scoreLead, type LeadSignal, type LeadStage } from "@/server/services/leads";

/**
 * `scoreLead` is a pure function over one message's signals plus the score it
 * inherited, so most of it is tested directly rather than through `ingest()`
 * — these cover what it decides. The last describe covers the one thing it
 * cannot answer alone: which of those decisions reaches the customer row.
 */

const signal = (overrides: Partial<LeadSignal> = {}): LeadSignal => ({
  previousScore: 0,
  intent: "other",
  matchedProduct: false,
  quantity: null,
  justOrdered: false,
  orderCount: 0,
  ...overrides,
});

describe("lead score bounds", () => {
  it("never exceeds 100, however many signals fire at once", () => {
    const { score } = scoreLead(signal({
      previousScore: 98, intent: "purchase_order", matchedProduct: true,
      quantity: 500, justOrdered: true, orderCount: 3,
    }));

    expect(score).toBe(100);
  });

  it("never falls below 0, however negative the message", () => {
    const { score } = scoreLead(signal({ previousScore: 0, intent: "complaint" }));

    expect(score).toBe(0);
  });
});

describe("the customer stage is sticky", () => {
  it("pins the stage at customer the moment an order is placed", () => {
    const { stage } = scoreLead(signal({ previousScore: 10, intent: "buy", matchedProduct: true, justOrdered: true }));

    expect(stage).toBe("customer");
  });

  // The business relationship the stage describes is real and past: a
  // routine question a week after an order is not a demotion.
  it("does not demote a past buyer on a later low-signal message", () => {
    const { score, stage } = scoreLead(signal({ previousScore: 4, intent: "support", orderCount: 1 }));

    expect(stage).toBe("customer");
    expect(score).toBeLessThan(55); // and not because the score kept it there
  });

  it("qualifies on score alone only when nothing has been ordered", () => {
    const strong = signal({ previousScore: 50, intent: "buy", matchedProduct: true });

    expect(scoreLead(strong).stage).toBe("qualified");
    expect(scoreLead({ ...strong, previousScore: 0 }).stage).toBe("engaged");
  });

  // 55 is the line an operator's lead list is filtered on, so which side of
  // it a score exactly on the boundary falls is a business-visible answer,
  // not an implementation detail.
  it("qualifies at exactly 55, and not at 54", () => {
    const at = (previousScore: number) => scoreLead(signal({ previousScore, intent: "buy" }));

    expect(at(31)).toEqual({ score: 55, stage: "qualified" });
    expect(at(30)).toEqual({ score: 54, stage: "engaged" });
  });
});

describe("what a single message is worth", () => {
  // The bulk bonus is for a wholesale-sized ask; nine units is still retail.
  it("pays the bulk bonus from ten units up, not below", () => {
    const buying = (quantity: number | null) => scoreLead(signal({ intent: "buy", quantity })).score;

    expect(buying(null)).toBe(24);
    expect(buying(9)).toBe(24);
    expect(buying(10)).toBe(34);
  });

  // A recognised negative intent is a decision, not an undecided contact, so
  // it takes its own weight and not the unrecognised-intent drift as well.
  it("weighs a recognised complaint without also charging the drift", () => {
    expect(scoreLead(signal({ previousScore: 40, intent: "complaint" })).score).toBe(34);
    expect(scoreLead(signal({ previousScore: 40, intent: "return" })).score).toBe(39);
  });
});

/**
 * The module's own comment says an undecided lead should "drift back toward
 * neutral … so a lead who only ever says 'hi' does not creep toward
 * 'qualified' purely by messaging often". The arithmetic does not do that:
 * every message adds a flat +4 for engagement and an unrecognised intent
 * subtracts only 2, so each low-signal contact is worth a net **+2** and a
 * visitor who says nothing but "hi" reaches `qualified` on the 28th message.
 *
 * These tests pin what the code actually does rather than what it means to.
 * Issue #7 says not to reshape production code to make a test pass, so the
 * divergence is recorded here and reported on the issue instead of fixed —
 * changing the constants is a behavioural change to every operator's live
 * lead list, not a test concern.
 */
describe("drift on an unrecognised intent", () => {
  it("scores an unrecognised intent below a recognised buying one", () => {
    const base = { previousScore: 40, matchedProduct: true } as const;

    const unknown = scoreLead(signal({ ...base, intent: "support" })).score;
    const buying = scoreLead(signal({ ...base, intent: "buy" })).score;

    expect(unknown).toBeLessThan(buying);
  });

  // DIVERGENCE from the module comment and from issue #7's third bullet:
  // this should be a drift *down*. It is +2 a message.
  it("still gains 2 points a message, which the comment above says it must not", () => {
    expect(scoreLead(signal({ previousScore: 40, intent: "support" })).score).toBe(42);

    // Count the messages a visitor who only ever says "hi" needs to cross
    // the line. The 200 is a runaway guard, not an expectation.
    let score = 0;
    let stage: LeadStage = "engaged";
    let messages = 0;
    while (stage !== "qualified" && messages < 200) {
      ({ score, stage } = scoreLead(signal({ previousScore: score })));
      messages += 1;
    }
    expect(messages).toBe(28);
    expect(score).toBe(56);
  });
});

/**
 * The one branch the pure function cannot speak for on its own: `orderCount`
 * is not read off the customer row (nothing in the ingest loop increments
 * that field — see leads.ts's note), it is counted from `Order` inside the
 * same transaction. So stickiness is only really true if a *persisted* order
 * is what pins the stage.
 */
describe("the stage as ingest persists it", () => {
  let workspaceId: string;

  beforeEach(async () => {
    await resetDatabase();
    const { user } = await createUser();
    workspaceId = (await createWorkspace({ userId: user.id })).id;
  });

  const say = (text: string) =>
    ingest({ workspaceId, channel: "whatsapp", handle: "+91 90 000 0055", text });

  const twin = (id: string) => prisma.customer.findFirstOrThrow({ where: { workspaceId, id } });

  it("writes customer onto the twin the moment an order is placed, and keeps it there", async () => {
    const ordered = await say("I want 3 olive L polos");
    expect(ordered.order).not.toBeNull();

    const afterOrder = await twin(ordered.customer.id);
    expect(afterOrder.leadStage).toBe("customer");

    // A routine question a message later, with no buying signal in it at
    // all: the score moves, the stage does not.
    await say("hello");
    const afterChat = await twin(ordered.customer.id);
    expect(afterChat.leadStage).toBe("customer");
    expect(await prisma.order.count({ where: { workspaceId } })).toBe(1);
  });

  it("leaves a browsing visitor at engaged", async () => {
    const asked = await say("hello");

    const customer = await twin(asked.customer.id);
    expect(customer.leadStage).toBe("engaged");
    expect(customer.leadScore).toBeLessThan(55);
  });
});
