import { beforeEach, describe, expect, it } from "vitest";
import { createUser, createWorkspace, resetDatabase, signedIn } from "./helpers";
import { prisma } from "@/server/lib/prisma";

/**
 * The no-code builder, over HTTP.
 *
 * PRD §2 is three steps — choose, configure, deploy — and §8.1 prints the
 * deploy contract verbatim. Both are asserted here against the paths the PRD
 * names as well as the ones this API has always served, because an integrator
 * reading the PRD will type `/api/v1` and an integrator reading `docs/api.md`
 * will type `/v1`, and neither should be wrong.
 */

let workspaceId: string;

async function setup(policy: "everything" | "money_only" | "nothing" = "nothing") {
  const { user } = await createUser();
  const workspace = await createWorkspace({ userId: user.id, policy });
  workspaceId = workspace.id;
  return signedIn();
}

/** A connected channel, so deploying to it is not refused. */
const connect = (channel: "whatsapp" | "telegram") =>
  prisma.channelConnection.create({
    data: { workspaceId, channel, status: "connected", externalId: `ext_${channel}`, displayName: channel },
  });

/** The PRD's own deploy body (§8.1). */
const PRD_DEPLOY = {
  agent_name: "Wholesale Sales Assistant",
  skills: ["Inventory_Lookup", "Discount_Calculator", "Stripe_Invoice"],
  knowledge_base_ids: [] as string[],
  channels: ["WHATSAPP", "TELEGRAM", "WEB_SDK"],
  guardrails: {
    max_autonomous_discount_pct: 0.12,
    human_escalation_triggers: ["DISPUTE", "REFUND_OVER_500"],
  },
};

beforeEach(async () => { await resetDatabase(); });

describe("step 1 — choosing", () => {
  it("offers the four templates the PRD names", async () => {
    const agent = await setup();
    const res = await agent.get("/v1/agents/templates").expect(200);

    expect(res.body.templates.map((t: { key: string }) => t.key)).toEqual([
      "customer_support", "sdr", "calendar_pa", "inbound_reception",
    ]);
  });

  it("returns every template's guardrails fully defaulted, not just what it declared", async () => {
    const agent = await setup();
    const res = await agent.get("/v1/agents/templates").expect(200);

    const support = res.body.templates.find((t: { key: string }) => t.key === "customer_support");
    // Declared: a zero discount allowance. Not declared, but an operator gets
    // it anyway and the builder must show it.
    expect(support.guardrails.maxAutonomousDiscountPct).toBe(0);
    expect(support.guardrails.minMarginPct).toBe(18);
    expect(support.guardrails.escalateIfMaterialUnknown).toBe(true);
  });

  it("offers the skill catalogue with nothing executable in it", async () => {
    const agent = await setup();
    const res = await agent.get("/v1/agents/skills").expect(200);

    expect(res.body.skills.map((s: { slug: string }) => s.slug)).toContain("Inventory_Lookup");
    expect(JSON.stringify(res.body)).not.toContain("parameters");
  });

  it("refuses an anonymous caller", async () => {
    await setup();
    const { agent } = await import("./dispatch");
    await agent().get("/v1/agents/templates").expect(401);
  });
});

describe("step 3 — deploying", () => {
  it("accepts the PRD's request body verbatim and creates a real agent", async () => {
    const agent = await setup();
    await connect("whatsapp");
    await connect("telegram");

    const res = await agent.post("/v1/agents/builder/deploy").send(PRD_DEPLOY).expect(201);

    expect(res.body.agent).toMatchObject({
      agent_name: "Wholesale Sales Assistant",
      status: "deployed",
      channels: ["WHATSAPP", "TELEGRAM", "WEB_SDK"],
    });
    expect(res.body.agent.guardrails.maxAutonomousDiscountPct).toBe(0.12);
    expect(res.body.agent.guardrails.humanEscalationTriggers).toEqual(["DISPUTE", "REFUND_OVER_500"]);

    const row = await prisma.agent.findFirstOrThrow({ where: { workspaceId }, include: { skills: true } });
    expect(row.status).toBe("deployed");
    expect(row.deployedAt).not.toBeNull();
    expect(row.skills.map((s) => s.skill).sort()).toEqual(
      ["Discount_Calculator", "Inventory_Lookup", "Stripe_Invoice"],
    );
    expect(row.channels).toEqual(["whatsapp", "telegram", "webchat"]);
  });

  it("answers at the PRD's own /api/v1 path as well", async () => {
    const agent = await setup();
    await connect("whatsapp");
    await connect("telegram");

    const res = await agent.post("/api/v1/agents/builder/deploy").send(PRD_DEPLOY).expect(201);
    expect(res.body.agent.agent_name).toBe("Wholesale Sales Assistant");
    expect(await prisma.agent.count({ where: { workspaceId } })).toBe(1);
  });

  // An agent published to a channel it cannot answer on is "live" and silent,
  // and the operator finds out from an empty inbox.
  it("refuses to publish to a channel that is not connected", async () => {
    const agent = await setup();
    await connect("whatsapp");

    const res = await agent.post("/v1/agents/builder/deploy").send(PRD_DEPLOY).expect(409);
    expect(res.body.error).toContain("Not connected: TELEGRAM");
    expect(await prisma.agent.count()).toBe(0);
  });

  // Webchat is its own transport — there is no provider account to connect.
  it("publishes to the web widget with no connection at all", async () => {
    const agent = await setup();

    await agent
      .post("/v1/agents/builder/deploy")
      .send({ ...PRD_DEPLOY, channels: ["WEB_SDK"] })
      .expect(201);

    const row = await prisma.agent.findFirstOrThrow({ where: { workspaceId } });
    expect(row.channels).toEqual(["webchat"]);
  });

  // The specification names these skills twice and does not agree with itself:
  // §2 Step 01 lists `Inventory_Lookup`, §8.1's deploy example — the body an
  // integrator copies, because it is the one printed as a request — says
  // `SKILL_INVENTORY_LOOKUP`. Refusing one of them would mean somebody who
  // copied the specification's own example got "Unknown skill" back.
  it("accepts the specification's §8.1 skill spellings and stores the canonical ones", async () => {
    const agent = await setup();
    const res = await agent
      .post("/v1/agents/builder/deploy")
      .send({
        agent_name: "Wholesale Sales Assistant",
        skills: ["SKILL_INVENTORY_LOOKUP", "SKILL_DISCOUNT_NEGOTIATOR", "SKILL_STRIPE_CHECKOUT"],
        knowledge_base_ids: [],
        channels: ["WEB_SDK"],
        guardrails: { max_autonomous_discount_pct: 0.12 },
      })
      .expect(201);

    expect(res.body.agent.skills).toEqual(
      ["Inventory_Lookup", "Discount_Calculator", "Stripe_Invoice"],
    );

    const row = await prisma.agent.findFirstOrThrow({ where: { workspaceId }, include: { skills: true } });
    expect(row.skills.map((s) => s.skill).sort()).toEqual(
      ["Discount_Calculator", "Inventory_Lookup", "Stripe_Invoice"],
    );
  });

  // And the allowed-tool check has to compare like with like, whichever
  // spelling built the agent.
  it("executes a skill on an agent built from the §8.1 spellings", async () => {
    const agent = await setup();
    const deployed = await agent
      .post("/v1/agents/builder/deploy")
      .send({ agent_name: "Runner", skills: ["SKILL_INVENTORY_LOOKUP"], channels: ["WEB_SDK"] })
      .expect(201);

    await agent
      .post(`/v1/agents/${deployed.body.agent.id}/execute`)
      .send({ skill: "SKILL_INVENTORY_LOOKUP", arguments: { product: "Polo Classic" } })
      .expect(200);

    await agent
      .post(`/v1/agents/${deployed.body.agent.id}/execute`)
      .send({ skill: "Inventory_Lookup", arguments: { product: "Polo Classic" } })
      .expect(200);
  });

  it("refuses a skill the registry does not know, and names it", async () => {
    const agent = await setup();
    const res = await agent
      .post("/v1/agents/builder/deploy")
      .send({ ...PRD_DEPLOY, channels: ["WEB_SDK"], skills: ["Inventory_Lookup", "Teleportation"] })
      .expect(422);

    expect(res.body.error).toContain("Unknown skill: Teleportation");
    expect(await prisma.agent.count()).toBe(0);
  });

  it("refuses a channel it has never heard of", async () => {
    const agent = await setup();
    const res = await agent
      .post("/v1/agents/builder/deploy")
      .send({ ...PRD_DEPLOY, channels: ["CARRIER_PIGEON"] })
      .expect(422);

    expect(res.body.error).toContain("Unknown channel: CARRIER_PIGEON");
    expect(res.body.details.supported).toContain("WHATSAPP");
  });

  // Storing a malformed guardrail and ignoring it at execution time hands the
  // operator a ceiling they believe they set.
  it("refuses guardrails it cannot parse", async () => {
    const agent = await setup();
    await agent
      .post("/v1/agents/builder/deploy")
      .send({ ...PRD_DEPLOY, channels: ["WEB_SDK"], guardrails: { max_autonomous_discount_pct: 4 } })
      .expect(422);

    expect(await prisma.agent.count()).toBe(0);
  });

  it("refuses a knowledge entry that is not this workspace's", async () => {
    const agent = await setup();
    const { user: other } = await createUser("other@test.local");
    const theirs = await createWorkspace({ userId: other.id, name: "Other Co" });
    const entry = await prisma.knowledgeEntry.create({
      data: { workspaceId: theirs.id, kind: "policy", title: "Theirs", body: "secret" },
    });

    const res = await agent
      .post("/v1/agents/builder/deploy")
      .send({ ...PRD_DEPLOY, channels: ["WEB_SDK"], knowledge_base_ids: [entry.id] })
      .expect(422);

    expect(res.body.error).toContain("Unknown knowledge entries");
  });

  // Publishing twice is how an operator edits an agent. A second row with the
  // same name and half the traffic is what makes telemetry lie.
  it("re-deploying the same name edits the agent rather than growing a second one", async () => {
    const agent = await setup();

    await agent.post("/v1/agents/builder/deploy").send({ ...PRD_DEPLOY, channels: ["WEB_SDK"] }).expect(201);
    await agent
      .post("/v1/agents/builder/deploy")
      .send({ ...PRD_DEPLOY, channels: ["WEB_SDK"], skills: ["Inventory_Lookup"] })
      .expect(201);

    const agents = await prisma.agent.findMany({ where: { workspaceId }, include: { skills: true } });
    expect(agents).toHaveLength(1);
    // A skill removed from the list actually goes.
    expect(agents[0]!.skills.map((s) => s.skill)).toEqual(["Inventory_Lookup"]);

    const events = await prisma.twinEvent.findMany({ orderBy: { occurredAt: "asc" } });
    expect(events.map((e) => e.type)).toEqual(["agent.deployed", "agent.redeployed"]);
  });

  it("keeps a surviving skill's configuration across a re-deploy", async () => {
    const agent = await setup();
    await agent.post("/v1/agents/builder/deploy").send({ ...PRD_DEPLOY, channels: ["WEB_SDK"] }).expect(201);

    const row = await prisma.agent.findFirstOrThrow({ where: { workspaceId } });
    await prisma.agentSkill.updateMany({
      where: { agentId: row.id, skill: "Inventory_Lookup" },
      data: { config: { threshold: 6 } },
    });

    await agent.post("/v1/agents/builder/deploy").send({ ...PRD_DEPLOY, channels: ["WEB_SDK"] }).expect(201);

    const skill = await prisma.agentSkill.findFirstOrThrow({
      where: { agentId: row.id, skill: "Inventory_Lookup" },
    });
    expect(skill.config).toEqual({ threshold: 6 });
  });

  it("takes its skills and guardrails from a template when none are stated", async () => {
    const agent = await setup();
    const res = await agent
      .post("/v1/agents/builder/deploy")
      .send({ agent_name: "Front Desk", template: "sdr", skills: [], channels: ["WEB_SDK"] })
      .expect(201);

    expect(res.body.agent.skills).toEqual(
      ["Inventory_Lookup", "Discount_Calculator", "Stripe_Invoice", "Lead_Scoring"],
    );
    expect(res.body.agent.guardrails.maxAutonomousDiscountPct).toBe(0.12);
  });
});

describe("managing a deployed agent", () => {
  async function deployed() {
    const agent = await setup();
    const res = await agent.post("/v1/agents/builder/deploy").send({ ...PRD_DEPLOY, channels: ["WEB_SDK"] });
    return { agent, id: res.body.agent.id as string };
  }

  it("lists and reads back what was deployed", async () => {
    const { agent, id } = await deployed();

    const list = await agent.get("/v1/agents").expect(200);
    expect(list.body.agents).toHaveLength(1);

    const one = await agent.get(`/v1/agents/${id}`).expect(200);
    expect(one.body.agent.id).toBe(id);
  });

  it("pauses and resumes", async () => {
    const { agent, id } = await deployed();

    await agent.patch(`/v1/agents/${id}`).send({ status: "paused" }).expect(200);
    expect((await prisma.agent.findFirstOrThrow({ where: { id } })).status).toBe("paused");

    await agent.patch(`/v1/agents/${id}`).send({ status: "deployed" }).expect(200);
    expect((await prisma.agent.findFirstOrThrow({ where: { id } })).status).toBe("deployed");
  });

  it("refuses to edit anything but status through PATCH", async () => {
    const { agent, id } = await deployed();
    await agent.patch(`/v1/agents/${id}`).send({ skills: ["Inventory_Lookup"] }).expect(422);
  });

  // A run is evidence. Deleting the agent does not un-happen what it did.
  it("keeps an agent's runs after the agent is deleted", async () => {
    const { agent, id } = await deployed();
    await agent
      .post(`/v1/agents/${id}/execute`)
      .send({ skill: "Inventory_Lookup", arguments: { product: "Polo Classic" } })
      .expect(200);

    await agent.delete(`/v1/agents/${id}`).expect(204);

    const runs = await prisma.agentRun.findMany();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.agentId).toBeNull();
    expect(runs[0]!.skill).toBe("Inventory_Lookup");
  });

  it("cannot see, pause or delete another tenant's agent", async () => {
    const { id } = await deployed();

    const { user: other } = await createUser("other@test.local");
    await createWorkspace({ userId: other.id, name: "Other Co" });
    const intruder = await signedIn("other@test.local");

    await intruder.get(`/v1/agents/${id}`).expect(404);
    await intruder.patch(`/v1/agents/${id}`).send({ status: "paused" }).expect(404);
    await intruder.delete(`/v1/agents/${id}`).expect(404);
    expect(await prisma.agent.count()).toBe(1);
  });
});

describe("executing a skill over HTTP", () => {
  async function deployed(skills = ["Inventory_Lookup"], guardrails: Record<string, unknown> = {}) {
    const agent = await setup();
    const res = await agent
      .post("/v1/agents/builder/deploy")
      .send({ agent_name: "Runner", skills, channels: ["WEB_SDK"], guardrails });
    return { agent, id: res.body.agent.id as string };
  }

  it("runs a skill the agent holds and returns what it found", async () => {
    const { agent, id } = await deployed();
    const res = await agent
      .post(`/v1/agents/${id}/execute`)
      .send({ skill: "Inventory_Lookup", arguments: { product: "Polo Classic", optionA: "L", optionB: "Olive" } })
      .expect(200);

    expect(res.body.status).toBe("done");
    expect(res.body.data.available).toBe(22);
    expect(res.body.events.map((e: { type: string }) => e.type)).toContain("inventory_twin.checked");
  });

  // A refused tool call is a 422, not a 500: the caller sent something
  // understood and not permitted, and a model reading it can act on it.
  it("answers 422 with the field detail when the arguments do not parse", async () => {
    const { agent, id } = await deployed();
    const res = await agent
      .post(`/v1/agents/${id}/execute`)
      .send({ skill: "Inventory_Lookup", arguments: { product: "" } })
      .expect(422);

    expect(res.body.error).toBe("Invalid arguments for Inventory_Lookup");
    expect(res.body.details.product).toBeDefined();
  });

  it("answers 422 when the agent does not hold the skill", async () => {
    const { agent, id } = await deployed(["Inventory_Lookup"]);
    const res = await agent
      .post(`/v1/agents/${id}/execute`)
      .send({ skill: "Discount_Calculator", arguments: { product: "Polo Classic", quantity: 1, requestedDiscountPct: 0 } })
      .expect(422);

    expect(res.body.error).toContain("does not hold the skill");
  });

  // Held work is real and waiting for a person, which is neither success nor
  // failure — 202 is the status that says so.
  it("answers 202 when a guardrail holds the result for a human", async () => {
    const { agent, id } = await deployed(["Discount_Calculator"], { maxSingleQuoteValue: 100 });
    const res = await agent
      .post(`/v1/agents/${id}/execute`)
      .send({ skill: "Discount_Calculator", arguments: { product: "Polo Classic", quantity: 1, requestedDiscountPct: 0 } })
      .expect(202);

    expect(res.body.status).toBe("needs_approval");
    expect(res.body.escalationReason).toContain("maxSingleQuoteValue");
    expect(await prisma.approval.count()).toBe(1);
  });
});
