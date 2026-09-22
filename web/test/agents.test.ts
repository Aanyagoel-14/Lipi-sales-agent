import { beforeEach, describe, expect, it } from "vitest";
import { createUser, createWorkspace, resetDatabase } from "./helpers";
import { prisma } from "@/server/lib/prisma";
import { executeSkill } from "@/server/agents/execute";
import { DEFAULT_GUARDRAILS, parseGuardrails, trippedTrigger } from "@/server/agents/guardrails";
import { skillCatalogue, skillFor, skillSpecs, unknownSkills } from "@/server/agents/registry";
import { agentTemplates } from "@/server/agents/templates";
import { setPaymentProvider, type PaymentProvider } from "@/server/lib/payments";

/**
 * Agents, skills, and the boundary between a model's suggestion and a real
 * mutation.
 *
 * The question under most of these is the same one: a language model has
 * chosen a function name and a bag of arguments, and something has to decide
 * whether that may touch the business. Everything that decides lives in
 * `server/agents/execute.ts`, so that is what is hammered here — the skills
 * themselves are tested for what they compute, and the executor is tested for
 * what it refuses.
 */

let workspaceId: string;
let customerId: string;

async function setup(policy: "everything" | "money_only" | "nothing" = "nothing") {
  const { user } = await createUser();
  const workspace = await createWorkspace({ userId: user.id, policy });
  workspaceId = workspace.id;

  const customer = await prisma.customer.create({
    data: {
      id: "cus_test", workspaceId, name: "Test Buyer", handle: "+91 90 000 0001",
      channel: "whatsapp", segment: "Retail", lifetimeValue: 0, orderCount: 0,
      avgOrderValue: 0, returnRatePct: 0, priceSensitivity: "Medium",
      negotiationStyle: "Unknown", sizeProfile: [], predictedNext: "Unknown",
      riskScore: 20, lastSeenAt: new Date(),
    },
  });
  customerId = customer.id;
  return workspace;
}

/** A deployed agent holding exactly the skills named. */
async function deployAgent(skills: string[], guardrails: Record<string, unknown> = {}, name = "Test Agent") {
  return prisma.agent.create({
    data: {
      workspaceId, name, template: "custom", status: "deployed",
      channels: ["whatsapp"], guardrails: parseGuardrails(guardrails) as object,
      deployedAt: new Date(),
      skills: { create: skills.map((skill) => ({ skill })) },
    },
  });
}

beforeEach(async () => {
  await resetDatabase();
  setPaymentProvider(null);
});

describe("the registry", () => {
  it("holds the five skills the PRD names, each exactly once", () => {
    const slugs = skillSpecs.map((s) => s.slug);
    expect(slugs).toEqual([
      "Inventory_Lookup", "Discount_Calculator", "Stripe_Invoice", "Lead_Scoring", "Calendar_Negotiation",
    ]);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  // The slug travels through a model, a JSON body and a form field before it
  // arrives, and a lookup that is case-sensitive fails for a reason no caller
  // can see.
  it("resolves a slug whatever case it arrives in, and reports the canonical spelling", () => {
    expect(skillFor("inventory_lookup")?.slug).toBe("Inventory_Lookup");
    expect(skillFor("  INVENTORY_LOOKUP  ")?.slug).toBe("Inventory_Lookup");
    expect(skillFor("Inventory Lookup")).toBeUndefined();
  });

  it("names the skills it does not know", () => {
    expect(unknownSkills(["Inventory_Lookup", "Teleportation"])).toEqual(["Teleportation"]);
  });

  // A template that names a skill nobody implemented is a template that
  // cannot be deployed, and the operator finds out at the last step.
  it("every template names only skills that exist", () => {
    for (const template of agentTemplates) {
      expect(unknownSkills(template.skills), template.key).toEqual([]);
    }
  });

  it("offers the builder a catalogue with no executable parts in it", () => {
    const catalogue = skillCatalogue();
    expect(catalogue).toHaveLength(skillSpecs.length);
    for (const entry of catalogue) {
      expect(entry).not.toHaveProperty("run");
      expect(entry).not.toHaveProperty("parameters");
    }
  });
});

describe("guardrails", () => {
  it("defaults to the cautious reading, not the permissive one", () => {
    expect(DEFAULT_GUARDRAILS.maxAutonomousDiscountPct).toBe(0);
    expect(DEFAULT_GUARDRAILS.escalateIfMaterialUnknown).toBe(true);
    expect(DEFAULT_GUARDRAILS.escalateOnPastDueInvoices).toBe(true);
    // The PRD's Customer Twin rule (§5): quotes authorised above 18% margin.
    expect(DEFAULT_GUARDRAILS.minMarginPct).toBe(18);
  });

  // The PRD writes guardrails in snake_case in the deploy contract (§8.1) and
  // camelCase in the SDK example (§4.1). Both are the same object.
  it("accepts the PRD's snake_case wire spelling", () => {
    const parsed = parseGuardrails({
      max_autonomous_discount_pct: 0.12,
      human_escalation_triggers: ["DISPUTE", "REFUND_OVER_500"],
    });
    expect(parsed.maxAutonomousDiscountPct).toBe(0.12);
    expect(parsed.humanEscalationTriggers).toEqual(["DISPUTE", "REFUND_OVER_500"]);
  });

  // Storing a malformed guardrail and ignoring it at execution time is worse
  // than having none: the operator believes they set a ceiling.
  it("refuses a guardrail object it cannot parse", () => {
    expect(() => parseGuardrails({ max_autonomous_discount_pct: 4 })).toThrow();
    expect(() => parseGuardrails({ maxSingleQuoteValue: -1 })).toThrow();
  });

  it("matches a trigger however the customer punctuated it", () => {
    const rails = parseGuardrails({ human_escalation_triggers: ["REFUND_OVER_500"] });
    expect(trippedTrigger("I want a refund over 500 please", rails)).toBe("REFUND_OVER_500");
    expect(trippedTrigger("REFUND-OVER-500", rails)).toBe("REFUND_OVER_500");
    expect(trippedTrigger("just browsing", rails)).toBeNull();
  });
});

describe("the execution boundary", () => {
  it("refuses a skill that does not exist, without touching anything", async () => {
    await setup();
    const outcome = await executeSkill({ workspaceId, skill: "Teleportation", args: {} });

    expect(outcome).toMatchObject({ status: "refused", reason: 'Unknown skill "Teleportation"' });
    expect(await prisma.agentRun.count()).toBe(0);
    expect(await prisma.twinEvent.count()).toBe(0);
  });

  it("refuses arguments that do not satisfy the skill's schema, and says which field", async () => {
    await setup();
    const outcome = await executeSkill({ workspaceId, skill: "Inventory_Lookup", args: { product: "" } });

    expect(outcome.status).toBe("refused");
    if (outcome.status !== "refused") throw new Error("unreachable");
    expect(outcome.reason).toBe("Invalid arguments for Inventory_Lookup");
    expect(outcome.details).toHaveProperty("product");
    expect(await prisma.agentRun.count()).toBe(0);
  });

  // The allowed-tool list. A model that names a skill its agent does not hold
  // is refused before its arguments are even parsed.
  it("refuses a skill the agent does not hold", async () => {
    await setup();
    const agent = await deployAgent(["Inventory_Lookup"]);

    const outcome = await executeSkill({
      workspaceId, agentId: agent.id, skill: "Discount_Calculator",
      args: { product: "Polo Classic", quantity: 1, requestedUnitPrice: 1 },
    });

    expect(outcome).toMatchObject({ status: "refused" });
    if (outcome.status !== "refused") throw new Error("unreachable");
    expect(outcome.reason).toContain("does not hold the skill Discount_Calculator");
  });

  it("refuses a skill that is held but switched off", async () => {
    await setup();
    const agent = await deployAgent(["Inventory_Lookup"]);
    await prisma.agentSkill.updateMany({ where: { agentId: agent.id }, data: { enabled: false } });

    const outcome = await executeSkill({
      workspaceId, agentId: agent.id, skill: "Inventory_Lookup", args: { product: "Polo Classic" },
    });
    expect(outcome).toMatchObject({ status: "refused" });
    if (outcome.status !== "refused") throw new Error("unreachable");
    expect(outcome.reason).toContain("is disabled");
  });

  it("refuses an agent that has not been deployed", async () => {
    await setup();
    const agent = await deployAgent(["Inventory_Lookup"]);
    await prisma.agent.update({ where: { id: agent.id }, data: { status: "paused" } });

    const outcome = await executeSkill({
      workspaceId, agentId: agent.id, skill: "Inventory_Lookup", args: { product: "Polo Classic" },
    });
    expect(outcome).toMatchObject({ status: "refused" });
    if (outcome.status !== "refused") throw new Error("unreachable");
    expect(outcome.reason).toContain("is paused, not deployed");
  });

  // Tenant isolation at the tool boundary (invariant 5). The refusal is the
  // same one an id that does not exist gets, so the shape of the answer is
  // not an oracle for another tenant's agent ids.
  it("refuses another tenant's agent, and says no more than it would for one that does not exist", async () => {
    await setup();
    const mine = await deployAgent(["Inventory_Lookup"]);

    const { user: other } = await createUser("other@test.local");
    const theirWorkspace = await createWorkspace({ userId: other.id, name: "Other Co" });
    const theirs = await prisma.agent.create({
      data: {
        workspaceId: theirWorkspace.id, name: "Theirs", status: "deployed",
        skills: { create: [{ skill: "Inventory_Lookup" }] },
      },
    });

    const crossTenant = await executeSkill({
      workspaceId, agentId: theirs.id, skill: "Inventory_Lookup", args: { product: "Polo Classic" },
    });
    const nonexistent = await executeSkill({
      workspaceId, agentId: "agent_does_not_exist", skill: "Inventory_Lookup", args: { product: "Polo Classic" },
    });

    expect(crossTenant).toMatchObject({ status: "refused", reason: "Unknown agent" });
    expect(nonexistent).toMatchObject({ status: "refused", reason: "Unknown agent" });
    // And the agent that *is* mine still works, so the refusal is about the
    // tenant rather than about the arguments.
    const ok = await executeSkill({
      workspaceId, agentId: mine.id, skill: "Inventory_Lookup", args: { product: "Polo Classic" },
    });
    expect(ok.status).toBe("done");
  });

  it("writes one run and its events when a skill succeeds", async () => {
    await setup();
    const agent = await deployAgent(["Inventory_Lookup"]);

    const outcome = await executeSkill({
      workspaceId, agentId: agent.id, skill: "Inventory_Lookup",
      args: { product: "Polo Classic", optionA: "L", optionB: "Olive" },
    });

    expect(outcome.status).toBe("done");
    const runs = await prisma.agentRun.findMany();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ agentId: agent.id, skill: "Inventory_Lookup", status: "done" });

    const events = await prisma.twinEvent.findMany({ orderBy: { occurredAt: "asc" } });
    expect(events.map((e) => e.type)).toEqual(["inventory_twin.checked", "skill.executed"]);
  });

  // A skill that throws must leave nothing behind, including no event
  // claiming it did something (invariants 1 and 6).
  it("rolls back everything when a skill throws, and reports the reason rather than a stack", async () => {
    await setup();

    const outcome = await executeSkill({
      workspaceId, skill: "Stripe_Invoice", args: { orderId: "ord_nope" },
    });

    expect(outcome).toMatchObject({ status: "refused", reason: "Unknown order ord_nope" });
    if (outcome.status !== "refused") throw new Error("unreachable");
    expect(outcome.reason).not.toContain("at ");
    expect(await prisma.agentRun.count()).toBe(0);
    expect(await prisma.twinEvent.count()).toBe(0);
    expect(await prisma.invoice.count()).toBe(0);
  });
});

describe("guardrails at execution time", () => {
  it("holds a quote that exceeds maxSingleQuoteValue and raises an approval", async () => {
    await setup();
    // Polo Classic is 119600 paise; ten of them is well past this ceiling.
    const agent = await deployAgent(["Discount_Calculator"], { maxSingleQuoteValue: 500_00 });

    const outcome = await executeSkill({
      workspaceId, agentId: agent.id, customerId, skill: "Discount_Calculator",
      args: { product: "Polo Classic", quantity: 10, requestedDiscountPct: 0 },
    });

    expect(outcome.status).toBe("needs_approval");
    if (outcome.status === "refused") throw new Error("unreachable");
    expect(outcome.escalationReason).toContain("exceeds maxSingleQuoteValue");

    const approvals = await prisma.approval.findMany();
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.severity).toBe("policy");
    expect(await prisma.agentRun.count({ where: { status: "needs_approval" } })).toBe(1);
  });

  it("holds anything a customer said that trips an escalation trigger", async () => {
    await setup();
    const agent = await deployAgent(["Inventory_Lookup"], { human_escalation_triggers: ["DISPUTE"] });

    const outcome = await executeSkill({
      workspaceId, agentId: agent.id, customerId, skill: "Inventory_Lookup",
      args: { product: "Polo Classic" },
      requestText: "I want to raise a dispute about my last order",
    });

    expect(outcome.status).toBe("needs_approval");
    if (outcome.status === "refused") throw new Error("unreachable");
    expect(outcome.escalationReason).toContain('escalation trigger "DISPUTE"');
  });

  // PRD §5, Customer Twin: "flags credit risk if past-due invoices > 0".
  it("holds a money skill when the customer has a past-due invoice", async () => {
    await setup();
    const agent = await deployAgent(["Discount_Calculator"]);

    await prisma.invoice.create({
      data: {
        number: "INV-2026-0001-test", workspaceId, source: "manual",
        issuedOn: new Date("2026-08-01"), dueOn: new Date("2026-08-10"),
        amount: 250_00, customerId,
      },
    });

    const outcome = await executeSkill({
      workspaceId, agentId: agent.id, customerId, skill: "Discount_Calculator",
      args: { product: "Polo Classic", quantity: 1, requestedDiscountPct: 0 },
      now: new Date("2026-09-23T10:00:00Z"),
    });

    expect(outcome.status).toBe("needs_approval");
    if (outcome.status === "refused") throw new Error("unreachable");
    expect(outcome.escalationReason).toContain("1 past-due invoice");
  });

  it("does not hold when the past-due invoice has since been paid in full", async () => {
    await setup();
    const agent = await deployAgent(["Discount_Calculator"]);

    await prisma.invoice.create({
      data: {
        number: "INV-2026-0002-test", workspaceId, source: "manual",
        issuedOn: new Date("2026-08-01"), dueOn: new Date("2026-08-10"),
        amount: 250_00, customerId,
        payments: {
          create: {
            id: "pay_1", workspaceId, customerId, amount: 250_00,
            method: "upi", receivedAt: new Date("2026-08-09"), loggedBy: "test",
          },
        },
      },
    });

    const outcome = await executeSkill({
      workspaceId, agentId: agent.id, customerId, skill: "Discount_Calculator",
      args: { product: "Polo Classic", quantity: 1, requestedDiscountPct: 0 },
      now: new Date("2026-09-23T10:00:00Z"),
    });

    expect(outcome.status).toBe("done");
  });

  it("honours the workspace's own approval policy", async () => {
    await setup("money_only");
    const agent = await deployAgent(["Inventory_Lookup", "Discount_Calculator"]);

    const free = await executeSkill({
      workspaceId, agentId: agent.id, customerId, skill: "Inventory_Lookup",
      args: { product: "Polo Classic" },
    });
    const money = await executeSkill({
      workspaceId, agentId: agent.id, customerId, skill: "Discount_Calculator",
      args: { product: "Polo Classic", quantity: 1, requestedDiscountPct: 0 },
    });

    expect(free.status).toBe("done");
    expect(money.status).toBe("needs_approval");
  });

  // A caller must not be able to widen a deployed agent's ceilings by passing
  // looser ones alongside its id.
  it("ignores guardrails passed by the caller when an agent is named", async () => {
    await setup();
    const agent = await deployAgent(["Discount_Calculator"], { maxSingleQuoteValue: 100_00 });

    const outcome = await executeSkill({
      workspaceId, agentId: agent.id, customerId, skill: "Discount_Calculator",
      args: { product: "Polo Classic", quantity: 1, requestedDiscountPct: 0 },
      guardrails: { ...DEFAULT_GUARDRAILS, maxSingleQuoteValue: 10_000_00 },
    });

    expect(outcome.status).toBe("needs_approval");
  });
});

describe("Inventory_Lookup", () => {
  it("reports available stock as stock minus what is already reserved", async () => {
    await setup();
    const variant = await prisma.variant.findFirstOrThrow({
      where: { optionA: "L", optionB: "Olive", product: { workspaceId, name: "Polo Classic" } },
    });
    await prisma.variant.update({ where: { id: variant.id }, data: { reserved: 5 } });

    const outcome = await executeSkill({
      workspaceId, skill: "Inventory_Lookup",
      args: { product: "Polo Classic", optionA: "L", optionB: "Olive" },
    });

    if (outcome.status === "refused") throw new Error(outcome.reason);
    expect(outcome.data.available).toBe(variant.stock - 5);
  });

  // "There is no such variant" and "that variant is empty" are different
  // answers and a customer is owed the difference.
  it("tells a variant that does not exist apart from one that is empty", async () => {
    await setup();

    const missing = await executeSkill({
      workspaceId, skill: "Inventory_Lookup",
      args: { product: "Polo Classic", optionA: "L", optionB: "Puce" },
    });
    const empty = await executeSkill({
      workspaceId, skill: "Inventory_Lookup",
      args: { product: "Polo Classic", optionA: "XXL", optionB: "Cobalt" },
    });

    if (missing.status === "refused" || empty.status === "refused") throw new Error("unreachable");
    expect(missing.data.variantExists).toBe(false);
    expect(empty.data.variantExists).toBe(true);
    expect(empty.data.available).toBe(0);
  });

  it("finds a product by SKU as well as by name", async () => {
    await setup();
    const variant = await prisma.variant.findFirstOrThrow({
      where: { product: { workspaceId, name: "Polo Classic" } },
    });

    const outcome = await executeSkill({ workspaceId, skill: "Inventory_Lookup", args: { product: variant.sku } });
    if (outcome.status === "refused") throw new Error(outcome.reason);
    expect(outcome.data.product).toBe("Polo Classic");
  });
});

describe("Discount_Calculator", () => {
  // Polo Classic: list 119600 paise, margin 41%.
  it("authorises a discount inside the allowance", async () => {
    await setup();
    const agent = await deployAgent(["Discount_Calculator"], { max_autonomous_discount_pct: 0.12 });

    const outcome = await executeSkill({
      workspaceId, agentId: agent.id, skill: "Discount_Calculator",
      args: { product: "Polo Classic", quantity: 2, requestedDiscountPct: 0.1 },
    });

    if (outcome.status === "refused") throw new Error(outcome.reason);
    expect(outcome.data.authorised).toBe(true);
    expect(outcome.data.authorisedUnitPrice).toBe(107_640); // 119600 × 0.9
    expect(outcome.data.totalMinorUnits).toBe(215_280);
  });

  // The floor is not a suggestion, and it is not silently applied either: the
  // skill reports what it *could* authorise so the approver has a
  // counter-offer rather than only a refusal.
  it("refuses a discount past the allowance and escalates with the floor it can reach", async () => {
    await setup();
    const agent = await deployAgent(["Discount_Calculator"], { max_autonomous_discount_pct: 0.12 });

    const outcome = await executeSkill({
      workspaceId, agentId: agent.id, skill: "Discount_Calculator",
      args: { product: "Polo Classic", quantity: 1, requestedDiscountPct: 0.4 },
    });

    expect(outcome.status).toBe("needs_approval");
    if (outcome.status === "refused") throw new Error("unreachable");
    expect(outcome.data.authorised).toBe(false);
    expect(outcome.data.bindingConstraint).toBe("maxAutonomousDiscountPct");
    expect(outcome.data.floorUnitPrice).toBe(105_248); // ceil(119600 × 0.88)
  });

  // PRD §5: quotes are authorised above an 18% margin. At 41% list margin the
  // implied cost is 70564, and the price that still leaves 18% is 86054.
  it("lets the margin floor bind when it is tighter than the discount allowance", async () => {
    await setup();
    const agent = await deployAgent(["Discount_Calculator"], {
      max_autonomous_discount_pct: 0.9,
      min_margin_pct: 18,
    });

    const outcome = await executeSkill({
      workspaceId, agentId: agent.id, skill: "Discount_Calculator",
      args: { product: "Polo Classic", quantity: 1, requestedDiscountPct: 0.5 },
    });

    if (outcome.status === "refused") throw new Error(outcome.reason);
    expect(outcome.data.bindingConstraint).toBe("minMarginPct");
    expect(outcome.data.floorUnitPrice).toBe(86_054);
    expect(outcome.data.authorised).toBe(false);
  });

  it("needs one of a requested price or a requested discount", async () => {
    await setup();
    const outcome = await executeSkill({
      workspaceId, skill: "Discount_Calculator", args: { product: "Polo Classic", quantity: 1 },
    });
    expect(outcome.status).toBe("refused");
  });
});

describe("Stripe_Invoice", () => {
  async function anOrder() {
    const variant = await prisma.variant.findFirstOrThrow({
      where: { optionA: "L", optionB: "Olive", product: { workspaceId, name: "Polo Classic" } },
      include: { product: true },
    });
    return prisma.order.create({
      data: {
        id: "ord_test", workspaceId, customerId, productId: variant.productId, variantId: variant.id,
        variant: "L / Olive", qty: 2, value: variant.product.price * 2, stage: "Quoted",
        channel: "whatsapp", createdAt: new Date(),
      },
    });
  }

  // The honest half of the seam: no provider means no link, and the reason is
  // recorded where an operator will find it. An invented URL would be the
  // worst kind of fake success — the customer only discovers it at the moment
  // they try to pay.
  it("raises a real invoice and reports that no checkout link could be made", async () => {
    await setup();
    const order = await anOrder();

    const outcome = await executeSkill({
      workspaceId, customerId, skill: "Stripe_Invoice", args: { orderId: order.id },
    });

    if (outcome.status === "refused") throw new Error(outcome.reason);
    expect(outcome.data.checkoutUrl).toBeNull();
    expect(outcome.data.paymentProvider).toBe("none");
    expect(outcome.data.checkoutUnavailableReason).toContain("STRIPE_SECRET_KEY");

    const invoice = await prisma.invoice.findFirstOrThrow({ where: { workspaceId } });
    expect(invoice.amount).toBe(order.value);
    expect(outcome.data.invoiceUrl).toBe(`/v1/invoices/${encodeURIComponent(invoice.number)}/pdf`);

    const events = await prisma.twinEvent.findMany();
    expect(events.map((e) => e.type)).toContain("checkout.link_unavailable");
  });

  it("returns a checkout link when a provider is configured", async () => {
    await setup();
    const order = await anOrder();

    const provider: PaymentProvider = {
      name: "stripe",
      configured: () => true,
      async createCheckoutLink(request) {
        return {
          ok: true, provider: "stripe",
          link: { url: `https://pay.example/${request.reference}`, providerRef: "cs_test_1", expiresAt: null },
        };
      },
    };
    setPaymentProvider(provider);

    const outcome = await executeSkill({
      workspaceId, customerId, skill: "Stripe_Invoice", args: { orderId: order.id },
    });

    if (outcome.status === "refused") throw new Error(outcome.reason);
    expect(outcome.data.checkoutUrl).toBe(`https://pay.example/${outcome.data.invoiceNumber}`);
    const events = await prisma.twinEvent.findMany();
    expect(events.map((e) => e.type)).toContain("checkout.link_created");
  });

  // A retried tool call, or a customer asking twice, must not produce two
  // demands for the same money.
  it("is idempotent: asking twice returns the same invoice", async () => {
    await setup();
    const order = await anOrder();

    const first = await executeSkill({ workspaceId, customerId, skill: "Stripe_Invoice", args: { orderId: order.id } });
    const second = await executeSkill({ workspaceId, customerId, skill: "Stripe_Invoice", args: { orderId: order.id } });

    if (first.status === "refused" || second.status === "refused") throw new Error("unreachable");
    expect(second.data.invoiceNumber).toBe(first.data.invoiceNumber);
    expect(first.data.newlyCreated).toBe(true);
    expect(second.data.newlyCreated).toBe(false);
    expect(await prisma.invoice.count()).toBe(1);
  });
});

describe("Lead_Scoring", () => {
  it("recomputes the score onto the twin and records why", async () => {
    await setup();

    const outcome = await executeSkill({
      workspaceId, customerId, skill: "Lead_Scoring",
      args: { intent: "buy", matchedProduct: true, quantity: 40 },
    });

    if (outcome.status === "refused") throw new Error(outcome.reason);
    const customer = await prisma.customer.findFirstOrThrow({ where: { id: customerId } });
    expect(customer.leadScore).toBe(outcome.data.score);
    expect(customer.leadScore).toBeGreaterThan(0);

    const events = await prisma.twinEvent.findMany();
    expect(events.map((e) => e.type)).toContain("lead.scored");
  });

  it("uses the same arithmetic as the ingest loop rather than a second copy", async () => {
    await setup();
    // `scoreLead` adds 4 for the message, 20 for `buy`, 10 for a matched
    // product and 10 for a quantity at or above ten — from zero, 44.
    const outcome = await executeSkill({
      workspaceId, customerId, skill: "Lead_Scoring",
      args: { intent: "buy", matchedProduct: true, quantity: 40 },
    });
    if (outcome.status === "refused") throw new Error(outcome.reason);
    expect(outcome.data.score).toBe(44);
  });

  it("refuses when there is no customer twin in scope", async () => {
    await setup();
    const outcome = await executeSkill({ workspaceId, skill: "Lead_Scoring", args: { intent: "buy" } });
    expect(outcome).toMatchObject({ status: "refused" });
    if (outcome.status !== "refused") throw new Error("unreachable");
    expect(outcome.reason).toContain("needs a customer twin");
  });
});
