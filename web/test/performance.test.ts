import { beforeEach, describe, expect, it } from "vitest";
import { createUser, createWorkspace, resetDatabase } from "./helpers";
import { prisma } from "@/server/lib/prisma";
import { CustomSkill } from "@lipi-ai/sdk-node";
import { executeSkill } from "@/server/agents/execute";
import { generateSite } from "@/server/sites/generate";
import { generateSiteSchema } from "@/server/sites/structure";
import { deployAgent } from "@/server/agents/deploy";
import { ingest } from "@/server/services/ingest";

/**
 * The PRD's measurable acceptance criteria (§9), measured.
 *
 * Three of them can be measured here honestly, and the rest cannot — WER,
 * turn-taking latency and intent F1 need a voice pipeline and a labelled
 * corpus, neither of which exists (`BLOCKERS.md` B-007). Those are marked
 * NOT VERIFIED in `TRACEABILITY.md` §I and no number is invented for them.
 *
 * What is asserted here is the PRD's own threshold. What is *printed* is the
 * measurement, so `PERFORMANCE.md` can quote a figure somebody actually saw
 * rather than a bound somebody hoped for.
 *
 * Every number is **measured locally**, on a development machine, against a
 * local Postgres and with no model in the loop. That is a real measurement of
 * this code and it is not a production figure; the difference is stated
 * wherever these appear.
 */

const report = (label: string, ms: number, budget: string) =>
  console.log(`[perf] ${label}: ${ms.toFixed(1)}ms (PRD budget ${budget})`);

/** Median of several runs: one sample on a laptop measures the laptop. */
async function median(runs: number, fn: () => Promise<unknown>): Promise<number> {
  const timings: number[] = [];
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    await fn();
    timings.push(performance.now() - started);
  }
  return timings.sort((a, b) => a - b)[Math.floor(timings.length / 2)]!;
}

let workspaceId: string;

beforeEach(async () => {
  await resetDatabase();
  const { user } = await createUser();
  const workspace = await createWorkspace({ userId: user.id, policy: "nothing" });
  workspaceId = workspace.id;
});

describe("PRD §9 acceptance criteria that can be measured here", () => {
  // I-1: "Site build < 180s".
  it("generates a site well inside the PRD's 180 seconds", async () => {
    const input = generateSiteSchema.parse({
      business_profile: {
        name: "Apex Ceramic & Detailing",
        industry: "Automotive Services",
        target_geo: "Austin, TX",
        primary_goals: ["ONLINE_BOOKING", "CUSTOM_QUOTE_CALCULATION", "PHONE_CAPTURE"],
      },
      site_features: {
        embed_ai_voice_widget: true,
        embed_digital_twin_catalog: true,
        theme_mode: "DARK_SLATE_PREMIUM",
        custom_quote_formula: "BASE_VEHICLE_SIZE * COATING_GRADE + (PAINT_CORRECTION ? 250 : 0)",
      },
    });

    const ms = await median(5, async () => {
      await prisma.generatedSite.deleteMany({ where: { workspaceId } });
      await generateSite(workspaceId, input);
    });

    report("site generation", ms, "180s");
    expect(ms).toBeLessThan(180_000);
  });

  // I-2: "Agent deploy < 2 min".
  it("deploys an agent well inside the PRD's 2 minutes", async () => {
    const ms = await median(5, () =>
      deployAgent(workspaceId, {
        agent_name: "Wholesale Sales Assistant",
        skills: ["Inventory_Lookup", "Discount_Calculator", "Stripe_Invoice"],
        channels: ["WEB_SDK"],
        guardrails: { max_autonomous_discount_pct: 0.12 },
      }),
    );

    report("agent deploy", ms, "2min");
    expect(ms).toBeLessThan(120_000);
  });

  // I-7: "Custom tool overhead < 120ms".
  //
  // Overhead is what the *executor* costs on top of the handler: the
  // allowed-tool check, the schema parse, the transaction, the guardrails, the
  // run row and the events. So it is measured as the difference between
  // executing a skill whose handler does nothing and calling that handler
  // directly — not as the wall clock of a skill that does real work, which
  // would be measuring the work.
  it("adds less than the PRD's 120ms of overhead to a custom tool", async () => {
    const handler = async () => ({ ok: true });

    const skill = new CustomSkill({
      name: "measure_overhead",
      description: "does nothing, on purpose",
      parameters: { value: { type: "number" } },
      handler,
      touchesMoney: false,
    }).register();

    const bare = await median(21, () => handler());
    const executed = await median(21, () =>
      executeSkill({ workspaceId, skill: "measure_overhead", args: { value: 1 } }),
    );

    skill.unregister();

    const overhead = executed - bare;
    report("custom tool overhead", overhead, "120ms");
    expect(overhead).toBeLessThan(120);
  });
});

describe("what the rest of the system costs", () => {
  // Not a PRD criterion, but the number every other one sits on top of: one
  // inbound message, through the whole deterministic loop, in one transaction.
  it("runs the full ingest loop for one message", async () => {
    let n = 0;
    const ms = await median(7, () =>
      ingest({ workspaceId, channel: "whatsapp", handle: `+91 90 000 ${1000 + n++}`, text: "I want 2 olive L polos" }),
    );

    report("ingest (deterministic path, no model)", ms, "—");
    // Not a PRD threshold. A ceiling loose enough that only a regression of
    // the kind that would be felt by a customer trips it.
    expect(ms).toBeLessThan(2_000);
  });

  it("executes a real skill against the twins", async () => {
    const ms = await median(11, () =>
      executeSkill({
        workspaceId,
        skill: "Inventory_Lookup",
        args: { product: "Polo Classic", optionA: "L", optionB: "Olive" },
      }),
    );

    report("Inventory_Lookup end to end", ms, "—");
    expect(ms).toBeLessThan(1_000);
  });
});
