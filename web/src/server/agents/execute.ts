import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import type { TwinEffect } from "../lib/events";
import { DEFAULT_GUARDRAILS, readGuardrails, trippedTrigger, type Guardrails } from "./guardrails";
import { skillFor } from "./registry";
import { twinStoreFor } from "./twin-store";
import type { SkillOutcome, SkillResult, ToolContext } from "./types";

/**
 * The one place a skill is allowed to run.
 *
 * Agent tool execution is a hard security boundary, and this is the boundary.
 * Everything that decides whether a tool call may proceed is here rather than
 * inside the skills, because a check inside a skill is a check the *next*
 * skill's author has to remember to copy — and the caller is, in the end, a
 * language model choosing a function name and a bag of arguments.
 *
 * In order, and all of them before `run()` is reached:
 *
 *   1. the skill exists in the registry            — unknown name, refused
 *   2. the agent (if named) is this workspace's    — cross-tenant, refused
 *   3. the agent holds this skill, and it is on    — allowed-tool list
 *   4. the arguments satisfy the skill's schema    — field-level 422 detail
 *   5. nothing in the request trips an escalation trigger
 *
 * And after `run()` returns, before anything is visible:
 *
 *   6. the quoted value is inside `maxSingleQuoteValue`
 *   7. the customer has no past-due invoices, when the agent cares
 *   8. the skill's own `escalate` verdict is honoured
 *   9. the workspace's approval policy has its say
 *
 * A refusal at any numbered step is a *value*, not an exception. A model that
 * asked for something it may not have gets a structured "no" it can act on,
 * the operator gets an audit row either way, and nothing reaches a customer.
 *
 * Steps 6–9 can only hold a result back; they never edit one. A skill's
 * arithmetic is the skill's, and quietly halving a number to fit a ceiling
 * would be the fact/voice split broken from the other end.
 */

const id = (prefix: string) => `${prefix}_${randomUUID().slice(0, 8)}`;

export type ExecuteInput = {
  workspaceId: string;
  skill: string;
  args: unknown;
  /** The configured agent whose authority this runs under, when there is one. */
  agentId?: string | null;
  customerId?: string | null;
  conversationId?: string | null;
  /**
   * The customer's own words, when a skill is being run in response to a
   * message. Escalation triggers are matched against this — `DISPUTE` is a
   * thing a customer says, not an argument a model passes.
   */
  requestText?: string;
  now?: Date;
  /**
   * Guardrails to apply when no agent is named. Ignored when `agentId` is
   * given, because the agent's own are then authoritative — a caller must not
   * be able to widen a deployed agent's ceilings by passing looser ones.
   */
  guardrails?: Guardrails;
};

const refuse = (skill: string, reason: string, details?: unknown): SkillOutcome => ({
  status: "refused",
  skill,
  reason,
  ...(details === undefined ? {} : { details }),
});

export async function executeSkill(input: ExecuteInput): Promise<SkillOutcome> {
  const now = input.now ?? new Date();

  /* ------------------------------------------------ 1. the skill exists */
  const spec = skillFor(input.skill);
  if (!spec) return refuse(input.skill, `Unknown skill "${input.skill}"`);

  /* ---------------------------------- 2 & 3. whose authority, and may it */
  let agentName = "Agent";
  let guardrails = input.guardrails ?? DEFAULT_GUARDRAILS;
  let config: Record<string, unknown> = {};

  if (input.agentId) {
    const agent = await prisma.agent.findFirst({
      where: { id: input.agentId, workspaceId: input.workspaceId },
      include: { skills: true },
    });
    // Same answer for "no such agent" and "not yours": a caller must not be
    // able to probe another tenant's agent ids by the shape of the refusal.
    if (!agent) return refuse(spec.slug, "Unknown agent");
    if (agent.status !== "deployed") {
      return refuse(spec.slug, `Agent "${agent.name}" is ${agent.status}, not deployed`);
    }

    const held = agent.skills.find((row) => row.skill === spec.slug);
    if (!held) return refuse(spec.slug, `Agent "${agent.name}" does not hold the skill ${spec.slug}`);
    if (!held.enabled) return refuse(spec.slug, `Skill ${spec.slug} is disabled on agent "${agent.name}"`);

    agentName = agent.name;
    guardrails = readGuardrails(agent.guardrails);
    config = (held.config ?? {}) as Record<string, unknown>;
  }

  /* --------------------------------------------- 4. the arguments parse */
  const parsed = spec.parameters.safeParse(input.args);
  if (!parsed.success) {
    return refuse(spec.slug, `Invalid arguments for ${spec.slug}`, z.flattenError(parsed.error).fieldErrors);
  }

  /* --------------------------------------- 5. words that fetch a human */
  // Checked before the skill runs, so a dispute does not first get itself
  // priced. The skill's own list and the agent's are both in force; a skill
  // knows its dangerous edges better than a config written months earlier.
  const escalationText = input.requestText ?? "";
  const preEscalation =
    trippedTrigger(escalationText, guardrails) ??
    trippedTrigger(escalationText, { ...guardrails, humanEscalationTriggers: spec.alwaysEscalateOn ?? [] });

  /* ------------------------------------------------------------- run it */
  const effects: TwinEffect[] = [];
  let result: SkillResult;
  let runId = "";

  try {
    const outcome = await prisma.$transaction(async (tx) => {
      const record = (type: string, twin: string, payload: string) => effects.push({ type, twin, payload });

      const ctx: ToolContext = {
        workspaceId: input.workspaceId,
        agentId: input.agentId ?? null,
        agentName,
        customerId: input.customerId ?? null,
        conversationId: input.conversationId ?? null,
        now,
        guardrails,
        config,
        tx,
        record,
        twinStore: twinStoreFor({
          tx,
          workspaceId: input.workspaceId,
          customerId: input.customerId ?? null,
          now,
          record,
        }),
      };

      const started = Date.now();
      const ran = await spec.run(parsed.data, ctx);
      const durationMs = Date.now() - started;

      /* ------------------------------------- 6, 7, 8, 9. may it be sent */
      const held = await holdReason({
        result: ran,
        guardrails,
        preEscalation,
        workspaceId: input.workspaceId,
        touchesMoney: spec.touchesMoney,
        ctx,
      });

      const status = held ? ("needs_approval" as const) : ("done" as const);
      const run = await tx.agentRun.create({
        data: {
          id: id("run"),
          workspaceId: input.workspaceId,
          agentId: input.agentId ?? null,
          skill: spec.slug,
          agent: agentName,
          action: ran.summary,
          status,
          durationMs,
          ranAt: now,
          conversationId: input.conversationId ?? null,
        },
      });

      record("skill.executed", "agent", `${spec.slug} by ${agentName} -> ${status}`);

      if (held) {
        await tx.approval.create({
          data: {
            id: id("apr"),
            workspaceId: input.workspaceId,
            agent: agentName,
            summary: ran.summary,
            detail: `${spec.slug}: ${held}`,
            impact:
              ran.quotedValue === undefined
                ? "No money committed"
                : `Quoted ${ran.quotedValue} (minor units)`,
            raisedAt: now,
            severity: "policy",
            runId: run.id,
          },
        });
        record("skill.escalated", "agent", `${spec.slug} reason="${held}"`);
      }

      // The event trail commits with the work it describes, or neither does
      // (invariant 1 and 6). A skill never writes one itself.
      await tx.twinEvent.createMany({
        data: effects.map((effect, i) => ({
          id: id("evt"),
          workspaceId: input.workspaceId,
          occurredAt: new Date(now.getTime() + i),
          type: effect.type,
          twin: effect.twin,
          payload: effect.payload,
        })),
      });

      return { ran, status, runId: run.id, held };
    });

    result = outcome.ran;
    runId = outcome.runId;

    return {
      status: outcome.status,
      skill: spec.slug,
      runId,
      summary: result.summary,
      data: result.data ?? {},
      events: effects,
      ...(outcome.held ? { escalationReason: outcome.held } : {}),
    };
  } catch (error) {
    // A skill that threw gets a refusal, not a 500 — and the message is the
    // skill's own, which is why skills throw sentences rather than codes. The
    // transaction has already rolled back, so nothing it wrote survives and
    // no event claims it did.
    const reason = error instanceof Error ? error.message : "Skill execution failed";
    console.warn(`[agents] ${spec.slug} failed: ${reason}`);
    return refuse(spec.slug, reason);
  }
}

/**
 * Why this result must wait for a human, or null if it need not.
 *
 * The order is the order the reasons matter in: a ceiling crossed is a harder
 * fact than a policy preference, and the operator reading the approval should
 * see the sharpest reason rather than the first one checked.
 */
async function holdReason(opts: {
  result: SkillResult;
  guardrails: Guardrails;
  preEscalation: string | null;
  workspaceId: string;
  touchesMoney: boolean;
  ctx: ToolContext;
}): Promise<string | null> {
  const { result, guardrails, preEscalation, touchesMoney, ctx } = opts;

  if (
    guardrails.maxSingleQuoteValue !== null &&
    result.quotedValue !== undefined &&
    result.quotedValue > guardrails.maxSingleQuoteValue
  ) {
    return `quote of ${result.quotedValue} exceeds maxSingleQuoteValue ${guardrails.maxSingleQuoteValue}`;
  }

  if (result.escalate) return result.escalate.reason;
  if (preEscalation) return `escalation trigger "${preEscalation}"`;

  if (guardrails.escalateOnPastDueInvoices && touchesMoney && ctx.customerId) {
    const due = await ctx.twinStore.pastDueInvoices();
    if (due.count > 0) {
      return `customer has ${due.count} past-due invoice${due.count === 1 ? "" : "s"} totalling ${due.totalPaise} (minor units)`;
    }
  }

  const policy = await ctx.tx.workspace.findUnique({
    where: { id: opts.workspaceId },
    select: { approvalPolicy: true },
  });
  if (policy?.approvalPolicy === "everything") return "workspace approval policy is everything";
  if (policy?.approvalPolicy === "money_only" && touchesMoney) {
    return "workspace approval policy holds anything that touches money";
  }

  return null;
}
