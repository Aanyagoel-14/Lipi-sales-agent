import { z } from "zod";
import { body, HttpError, json, route } from "@/server/lib/http";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { executeSkill } from "@/server/agents/execute";

/**
 * `POST /v1/agents/{id}/execute` — run one of an agent's skills.
 *
 * This is the surface a bespoke SDK agent and an external orchestrator both
 * call, which makes it the most security-sensitive endpoint in the API: the
 * caller is, in the general case, a language model that has chosen a function
 * name and a bag of arguments.
 *
 * Nothing is decided here. Every check — that the agent is this workspace's
 * and deployed, that it holds the skill, that the arguments parse, that the
 * guardrails allow the outcome — lives in `server/agents/execute.ts`, so the
 * route is a translation of one refusal vocabulary into another and there is
 * no second place a check could be forgotten.
 *
 * A refused execution answers **422**, not 500: the caller sent something that
 * was understood and not permitted, and a model reading the reason can act on
 * it. A held execution answers **202**, because the work is real and waiting
 * for a person.
 */
const executeSchema = z.object({
  skill: z.string().min(1),
  /** Whatever the skill's own schema takes. Validated there, never here. */
  arguments: z.unknown().optional(),
  customerId: z.string().min(1).optional(),
  conversationId: z.string().min(1).optional(),
  /** The customer's own words, for escalation triggers to be matched against. */
  requestText: z.string().max(4000).optional(),
});

export const POST = route<{ id: string }>(async (req, { id }) => {
  const workspaceId = await resolveWorkspaceId();
  const input = await body(req, executeSchema, "Invalid skill execution");

  const outcome = await executeSkill({
    workspaceId,
    agentId: id,
    skill: input.skill,
    args: input.arguments ?? {},
    customerId: input.customerId ?? null,
    conversationId: input.conversationId ?? null,
    requestText: input.requestText,
  });

  if (outcome.status === "refused") {
    throw new HttpError(422, outcome.reason, outcome.details);
  }

  return json(
    {
      status: outcome.status,
      skill: outcome.skill,
      runId: outcome.runId,
      summary: outcome.summary,
      data: outcome.data,
      escalationReason: outcome.escalationReason ?? null,
      events: outcome.events.map((event) => ({ type: event.type, twin: event.twin, payload: event.payload })),
    },
    outcome.status === "needs_approval" ? 202 : 200,
  );
});
