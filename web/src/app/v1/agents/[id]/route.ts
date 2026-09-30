import { z } from "zod";
import { body, HttpError, json, noContent, route } from "@/server/lib/http";
import { recordEvent } from "@/server/lib/events";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { agentView } from "@/server/agents/deploy";

const withSkills = { skills: { where: { enabled: true }, select: { skill: true } } } as const;

export const GET = route<{ id: string }>(async (_req, { id }) => {
  const workspaceId = await resolveWorkspaceId();
  const agent = await prisma.agent.findFirst({ where: { id, workspaceId }, include: withSkills });
  if (!agent) throw new HttpError(404, "Agent not found");
  return json({ agent: agentView(agent, agent.skills.map((s) => s.skill)) });
});

/**
 * Pausing and resuming, which is the one edit that is not a re-deploy.
 *
 * Everything else about an agent — its skills, channels, guardrails — is
 * stated by `POST /v1/agents/builder/deploy`, so there is one code path that
 * validates them and no second one that could validate them differently.
 */
export const PATCH = route<{ id: string }>(async (req, { id }) => {
  const workspaceId = await resolveWorkspaceId();
  const input = await body(
    req,
    z.object({ status: z.enum(["deployed", "paused"]) }),
    "Only an agent's status can be patched; re-deploy to change anything else",
  );

  const agent = await prisma.agent.findFirst({ where: { id, workspaceId } });
  if (!agent) throw new HttpError(404, "Agent not found");
  if (agent.status === "draft") {
    throw new HttpError(409, "A draft agent has never been deployed; deploy it rather than resuming it");
  }

  const updated = await prisma.agent.update({
    where: { id: agent.id },
    data: { status: input.status },
    include: withSkills,
  });
  await recordEvent(workspaceId, `agent.${input.status}`, "agent", `${agent.id} name="${agent.name}"`);

  return json({ agent: agentView(updated, updated.skills.map((s) => s.skill)) });
});

/**
 * Deleting an agent.
 *
 * Its runs survive: `AgentRun.agentId` is `ON DELETE SET NULL`, because a run
 * is evidence of something that happened and deleting the agent does not
 * un-happen it (invariant 6).
 */
export const DELETE = route<{ id: string }>(async (_req, { id }) => {
  const workspaceId = await resolveWorkspaceId();
  const agent = await prisma.agent.findFirst({ where: { id, workspaceId } });
  if (!agent) throw new HttpError(404, "Agent not found");

  await prisma.agent.delete({ where: { id: agent.id } });
  await recordEvent(workspaceId, "agent.deleted", "agent", `${agent.id} name="${agent.name}"`);
  return noContent();
});
