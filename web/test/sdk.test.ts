import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CustomSkill, LipiAgent, toMinorUnits, type ToolContext } from "@lipi-ai/sdk-node";
import { createUser, createWorkspace, resetDatabase } from "./helpers";
import { prisma } from "@/server/lib/prisma";
import { executeSkill } from "@/server/agents/execute";
import { skillCatalogue } from "@/server/agents/registry";

/**
 * The bespoke SDK (PRD §4), driven by the PRD's own worked example.
 *
 * §4.1 prints a metal-fabrication quoter with real arithmetic in it, and the
 * master prompt asks for actual values to be asserted at every boundary that
 * arithmetic has — each material, an unsupported one, the quantity break at
 * 50, the lead-time break at 100 — rather than "returns an object".
 *
 * So the numbers below are computed by hand from the PRD's formula and written
 * out. If the implementation changes what it multiplies, these fail, which is
 * the entire point: a pricing test that recomputes the price with the code
 * under test asserts nothing at all.
 */

let workspaceId: string;
let customerId: string;
let productId: string;
let variantId: string;

/* -------------------------------------------------------------------------
 * The PRD's own snippet, §4.1, transcribed. The import line at the top of
 * this file is the PRD's too.
 * ---------------------------------------------------------------------- */

const customMetalPricingTool = new CustomSkill({
  name: "calculate_custom_fabrication",
  description: "Calculates custom CNC laser cutting & sheet metal pricing based on density and run-time",
  parameters: {
    material: { type: "string", enum: ["STEEL_304", "ALUMINUM_6061", "COPPER"] },
    thickness_mm: { type: "number" },
    cut_length_cm: { type: "number" },
    quantity: { type: "number" },
  },
  handler: async (args, ctx: ToolContext) => {
    const baseDensity = args.material === "STEEL_304" ? 7.93 : 2.7;
    const materialCost = args.thickness_mm * args.cut_length_cm * baseDensity * 0.042;
    const machineTimeMin = (args.cut_length_cm / 25) * (args.thickness_mm * 0.3);
    const machiningCost = machineTimeMin * 1.75;
    const unitPrice = (materialCost + machiningCost) * (args.quantity > 50 ? 0.85 : 1.0);

    // Update the living Digital Order Twin
    await ctx.twinStore.updateOrderDraft({
      custom_specs: args,
      calculated_unit_price: unitPrice,
      quantity: args.quantity,
      estimated_lead_days: args.quantity > 100 ? 7 : 3,
      productId,
      variantId,
    });

    return { unit_price: unitPrice.toFixed(2), lead_days: args.quantity > 100 ? 7 : 3 };
  },
});

const customFabricationAgent = new LipiAgent({
  agentId: "smb_custom_cnc_quoter",
  baseModel: "lipi-reasoning-v2",
  systemPrompt: "You are Apex Fab AI. Calculate custom sheet metal cutting quotes accurately using the custom pricing tool.",
  skills: [customMetalPricingTool],
  guardrails: { maxSingleQuoteValue: 25000, escalateIfMaterialUnknown: true },
});

/* ---------------------------------------------------------------------- */

/** The PRD's formula, independently, so the expectations are not the code. */
function priceByHand(material: string, thicknessMm: number, cutLengthCm: number, quantity: number) {
  const density = material === "STEEL_304" ? 7.93 : 2.7;
  const materialCost = thicknessMm * cutLengthCm * density * 0.042;
  const machiningCost = (cutLengthCm / 25) * (thicknessMm * 0.3) * 1.75;
  return (materialCost + machiningCost) * (quantity > 50 ? 0.85 : 1.0);
}

async function setup() {
  const { user } = await createUser();
  const workspace = await createWorkspace({ userId: user.id, policy: "nothing" });
  workspaceId = workspace.id;

  const variant = await prisma.variant.findFirstOrThrow({
    where: { product: { workspaceId, name: "Polo Classic" } },
  });
  variantId = variant.id;
  productId = variant.productId;

  const customer = await prisma.customer.create({
    data: {
      id: "cus_fab", workspaceId, name: "Apex Buyer", handle: "+91 90 000 0002",
      channel: "whatsapp", segment: "Corporate", lifetimeValue: 0, orderCount: 0,
      avgOrderValue: 0, returnRatePct: 0, priceSensitivity: "Low",
      negotiationStyle: "Unknown", sizeProfile: [], predictedNext: "Unknown",
      riskScore: 10, lastSeenAt: new Date(),
    },
  });
  customerId = customer.id;

  await prisma.agent.create({
    data: {
      workspaceId, name: "smb_custom_cnc_quoter", status: "deployed", channels: ["webchat"],
      guardrails: customFabricationAgent.guardrails() as object,
      deployedAt: new Date(),
      skills: { create: [{ skill: "calculate_custom_fabrication" }] },
    },
  });
}

const quote = (args: Record<string, unknown>, agentId?: string) =>
  executeSkill({
    workspaceId, customerId, agentId: agentId ?? null,
    skill: "calculate_custom_fabrication", args,
  });

beforeEach(async () => {
  await resetDatabase();
  customFabricationAgent.register();
});

afterEach(() => {
  customFabricationAgent.unregister();
});

describe("converting money at the SDK boundary", () => {
  // Everything below this line stores integer minor units and never rounds
  // again (invariant 4). The conversion happens once, here.
  it("turns major units into integer minor units, rounding half away from zero", () => {
    expect(toMinorUnits(12.34)).toBe(1234);
    expect(toMinorUnits(0.005)).toBe(1);
    expect(toMinorUnits(0.004)).toBe(0);
    expect(toMinorUnits(25_000)).toBe(2_500_000);
    expect(toMinorUnits(-1.235)).toBe(-124);
  });

  it("refuses an amount that is not a number anybody can be charged", () => {
    expect(() => toMinorUnits(Number.NaN)).toThrow();
    expect(() => toMinorUnits(Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe("registering a custom skill", () => {
  it("makes it executable and lists it as not built in", async () => {
    await setup();
    const catalogue = skillCatalogue();
    const entry = catalogue.find((s) => s.slug === "calculate_custom_fabrication");

    expect(entry).toBeDefined();
    expect(entry!.builtIn).toBe(false);
    expect(catalogue.find((s) => s.slug === "Inventory_Lookup")!.builtIn).toBe(true);
  });

  it("refuses to shadow a built-in skill", () => {
    expect(
      () =>
        new CustomSkill({
          name: "Inventory_Lookup",
          description: "not on my watch",
          parameters: {},
          handler: async () => ({}),
        }).register(),
    ).toThrow(/built-in skill/);
  });
});

describe("the PRD's fabrication quoter — arithmetic", () => {
  // 3mm × 100cm of steel, 10 off. Below the quantity break, so no discount.
  //   material   3 × 100 × 7.93 × 0.042      = 99.918
  //   machining  (100/25) × (3 × 0.3) × 1.75 = 6.3
  //   unit                                    = 106.218
  it("prices STEEL_304 at the PRD's own formula", async () => {
    await setup();
    const outcome = await quote({ material: "STEEL_304", thickness_mm: 3, cut_length_cm: 100, quantity: 10 });

    if (outcome.status === "refused") throw new Error(outcome.reason);
    expect(outcome.data.unit_price).toBe("106.22");
    expect(outcome.data.lead_days).toBe(3);
    expect(priceByHand("STEEL_304", 3, 100, 10)).toBeCloseTo(106.218, 3);
  });

  // The same cut in aluminium: density 2.70 rather than 7.93.
  //   material   3 × 100 × 2.70 × 0.042 = 34.02
  //   machining  6.3
  //   unit                              = 40.32
  it("prices ALUMINUM_6061 at the lighter density", async () => {
    await setup();
    const outcome = await quote({ material: "ALUMINUM_6061", thickness_mm: 3, cut_length_cm: 100, quantity: 10 });

    if (outcome.status === "refused") throw new Error(outcome.reason);
    expect(outcome.data.unit_price).toBe("40.32");
  });

  // The PRD's own formula gives COPPER the same 2.70 density as aluminium —
  // `material === 'STEEL_304' ? 7.93 : 2.70`. Asserted as written rather than
  // silently corrected to copper's real density; the formula is the SMB's,
  // and the SDK's job is to run it, not to second-guess it.
  it("prices COPPER exactly as the PRD's formula does, not as physics would", async () => {
    await setup();
    const copper = await quote({ material: "COPPER", thickness_mm: 3, cut_length_cm: 100, quantity: 10 });
    const aluminium = await quote({ material: "ALUMINUM_6061", thickness_mm: 3, cut_length_cm: 100, quantity: 10 });

    if (copper.status === "refused" || aluminium.status === "refused") throw new Error("unreachable");
    expect(copper.data.unit_price).toBe(aluminium.data.unit_price);
  });

  it("scales with thickness and with cut length", async () => {
    await setup();
    const thin = await quote({ material: "STEEL_304", thickness_mm: 1, cut_length_cm: 100, quantity: 1 });
    const thick = await quote({ material: "STEEL_304", thickness_mm: 6, cut_length_cm: 100, quantity: 1 });
    const short = await quote({ material: "STEEL_304", thickness_mm: 3, cut_length_cm: 50, quantity: 1 });

    if (thin.status === "refused" || thick.status === "refused" || short.status === "refused") {
      throw new Error("unreachable");
    }
    expect(thin.data.unit_price).toBe("35.41"); // 33.306 + 2.1
    expect(thick.data.unit_price).toBe("212.44"); // 199.836 + 12.6
    expect(short.data.unit_price).toBe("53.11"); // 49.959 + 3.15
  });
});

describe("the PRD's fabrication quoter — the quantity break at 50", () => {
  // `args.quantity > 50 ? 0.85 : 1.0`, so 50 is full price and 51 is not.
  it("charges full price at exactly 50", async () => {
    await setup();
    const outcome = await quote({ material: "STEEL_304", thickness_mm: 3, cut_length_cm: 100, quantity: 50 });
    if (outcome.status === "refused") throw new Error(outcome.reason);
    expect(outcome.data.unit_price).toBe("106.22");
  });

  it("applies the 15% break at 51", async () => {
    await setup();
    const outcome = await quote({ material: "STEEL_304", thickness_mm: 3, cut_length_cm: 100, quantity: 51 });
    if (outcome.status === "refused") throw new Error(outcome.reason);
    // 106.218 × 0.85 = 90.2853
    expect(outcome.data.unit_price).toBe("90.29");
  });
});

describe("the PRD's fabrication quoter — the lead-time break at 100", () => {
  // `args.quantity > 100 ? 7 : 3`, so 100 is three days and 101 is seven.
  it("quotes 3 days at exactly 100", async () => {
    await setup();
    const outcome = await quote({ material: "ALUMINUM_6061", thickness_mm: 1, cut_length_cm: 10, quantity: 100 });
    if (outcome.status === "refused") throw new Error(outcome.reason);
    expect(outcome.data.lead_days).toBe(3);
  });

  it("quotes 7 days at 101", async () => {
    await setup();
    const outcome = await quote({ material: "ALUMINUM_6061", thickness_mm: 1, cut_length_cm: 10, quantity: 101 });
    if (outcome.status === "refused") throw new Error(outcome.reason);
    expect(outcome.data.lead_days).toBe(7);
  });
});

describe("parameter validation", () => {
  it("refuses a material outside the declared enum, naming the field", async () => {
    await setup();
    const outcome = await quote({ material: "UNOBTAINIUM", thickness_mm: 3, cut_length_cm: 100, quantity: 10 });

    expect(outcome.status).toBe("refused");
    if (outcome.status !== "refused") throw new Error("unreachable");
    expect(outcome.details).toHaveProperty("material");
    expect(await prisma.order.count()).toBe(0);
  });

  it("refuses a missing argument", async () => {
    await setup();
    const outcome = await quote({ material: "STEEL_304", thickness_mm: 3, cut_length_cm: 100 });
    expect(outcome.status).toBe("refused");
  });

  it("refuses an argument of the wrong type", async () => {
    await setup();
    const outcome = await quote({ material: "STEEL_304", thickness_mm: "thick", cut_length_cm: 100, quantity: 1 });
    expect(outcome.status).toBe("refused");
  });

  // A model improvising an extra argument is a thing worth seeing, not a
  // thing worth silently dropping.
  it("refuses an argument nobody declared", async () => {
    await setup();
    const outcome = await quote({
      material: "STEEL_304", thickness_mm: 3, cut_length_cm: 100, quantity: 1, discount_pct: 0.9,
    });
    expect(outcome.status).toBe("refused");
  });

  // `z.number()` accepts both, and a quote computed from either is a number
  // nobody can honour.
  it("refuses NaN and Infinity", async () => {
    await setup();
    for (const thickness of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const outcome = await quote({ material: "STEEL_304", thickness_mm: thickness, cut_length_cm: 100, quantity: 1 });
      expect(outcome.status, String(thickness)).toBe("refused");
    }
  });
});

describe("the Digital Twin mutation", () => {
  it("writes the draft order the handler asked for, in integer minor units", async () => {
    await setup();
    const outcome = await quote({ material: "STEEL_304", thickness_mm: 3, cut_length_cm: 100, quantity: 10 });
    if (outcome.status === "refused") throw new Error(outcome.reason);

    const order = await prisma.order.findFirstOrThrow({ where: { workspaceId } });
    expect(order.qty).toBe(10);
    // 106.218 → 10622 minor units per unit, × 10.
    expect(order.value).toBe(106_220);
    expect(order.blocked).toContain("STEEL_304");

    const events = await prisma.twinEvent.findMany();
    expect(events.map((e) => e.type)).toContain("order_twin.created");
  });

  it("updates the same draft rather than growing one per revision", async () => {
    await setup();
    await quote({ material: "STEEL_304", thickness_mm: 3, cut_length_cm: 100, quantity: 10 });
    await quote({ material: "STEEL_304", thickness_mm: 4, cut_length_cm: 100, quantity: 10 });

    expect(await prisma.order.count({ where: { workspaceId } })).toBe(1);
    const order = await prisma.order.findFirstOrThrow({ where: { workspaceId } });
    // 4mm: material 4 × 100 × 7.93 × 0.042 = 133.224, machining 8.4 → 141.624
    expect(order.value).toBe(141_620);
  });

  it("rolls the draft back when the handler throws after writing it", async () => {
    await setup();
    const exploding = new CustomSkill({
      name: "explodes_after_writing",
      description: "writes a draft and then fails",
      parameters: { price: { type: "number" } },
      handler: async (args, ctx) => {
        await ctx.twinStore.updateOrderDraft({
          calculated_unit_price: args.price, quantity: 1, productId, variantId,
        });
        throw new Error("the machine caught fire");
      },
    }).register();

    const outcome = await executeSkill({
      workspaceId, customerId, skill: "explodes_after_writing", args: { price: 10 },
    });

    expect(outcome).toMatchObject({ status: "refused", reason: "the machine caught fire" });
    expect(await prisma.order.count({ where: { workspaceId } })).toBe(0);
    expect(await prisma.twinEvent.count()).toBe(0);
    exploding.unregister();
  });
});

describe("guardrails on a bespoke agent", () => {
  it("reads the PRD's maxSingleQuoteValue as major units", () => {
    expect(customFabricationAgent.guardrails().maxSingleQuoteValue).toBe(2_500_000);
    expect(customFabricationAgent.guardrails().escalateIfMaterialUnknown).toBe(true);
  });

  // The ceiling is checked against what the handler actually committed, which
  // it never had to report — a skill that quietly wrote a draft worth more
  // than its ceiling is exactly what the ceiling is for.
  it("holds a quote past maxSingleQuoteValue without the handler reporting it", async () => {
    await setup();
    const agent = await prisma.agent.findFirstOrThrow({ where: { workspaceId } });

    // 20mm × 5000cm of steel, 500 off: far past 25,000.
    const outcome = await quote(
      { material: "STEEL_304", thickness_mm: 20, cut_length_cm: 5000, quantity: 500 },
      agent.id,
    );

    expect(outcome.status).toBe("needs_approval");
    if (outcome.status === "refused") throw new Error("unreachable");
    expect(outcome.escalationReason).toContain("exceeds maxSingleQuoteValue 2500000");
    expect(await prisma.approval.count()).toBe(1);
  });

  it("lets a quote inside the ceiling through", async () => {
    await setup();
    const agent = await prisma.agent.findFirstOrThrow({ where: { workspaceId } });

    const outcome = await quote(
      { material: "ALUMINUM_6061", thickness_mm: 1, cut_length_cm: 10, quantity: 1 },
      agent.id,
    );
    expect(outcome.status).toBe("done");
  });

  // The allowed-tool list applies to custom skills exactly as it does to
  // built-in ones — that is the whole reason they share an executor.
  it("refuses a custom skill the agent does not hold", async () => {
    await setup();
    const other = await prisma.agent.create({
      data: {
        workspaceId, name: "Holds nothing useful", status: "deployed", channels: ["webchat"],
        skills: { create: [{ skill: "Inventory_Lookup" }] },
      },
    });

    const outcome = await quote(
      { material: "STEEL_304", thickness_mm: 3, cut_length_cm: 100, quantity: 1 },
      other.id,
    );
    expect(outcome.status).toBe("refused");
    if (outcome.status !== "refused") throw new Error("unreachable");
    expect(outcome.reason).toContain("does not hold the skill");
  });
});

describe("deploying a bespoke agent", () => {
  it("registers its skills and deploys through the same validation the builder uses", async () => {
    await setup();
    await prisma.agent.deleteMany({ where: { workspaceId } });

    const deployed = await customFabricationAgent.deploy({
      workspaceId,
      channels: ["WEB_SDK"],
    });

    expect(deployed.agent_name).toBe("smb_custom_cnc_quoter");
    expect(deployed.skills).toEqual(["calculate_custom_fabrication"]);
    expect(deployed.channels).toEqual(["WEB_SDK"]);
    expect(deployed.status).toBe("deployed");

    const row = await prisma.agent.findFirstOrThrow({ where: { workspaceId }, include: { skills: true } });
    expect(row.skills.map((s) => s.skill)).toEqual(["calculate_custom_fabrication"]);
    expect((row.guardrails as { maxSingleQuoteValue: number }).maxSingleQuoteValue).toBe(2_500_000);
  });

  it("is refused a channel the workspace has not connected", async () => {
    await setup();
    await expect(
      customFabricationAgent.deploy({ workspaceId, channels: ["WHATSAPP"] }),
    ).rejects.toThrow(/Not connected/);
  });
});
