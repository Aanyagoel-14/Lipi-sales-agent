import { json, route } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { agentView } from "@/server/agents/deploy";

/** `GET /v1/agents` — every agent this workspace has built, newest first. */
export const GET = route(async () => {
  const workspaceId = await resolveWorkspaceId();
  const agents = await prisma.agent.findMany({
    where: { workspaceId },
    orderBy: [{ createdAt: "desc" }],
    include: { skills: { where: { enabled: true }, select: { skill: true } } },
  });

  return json({
    agents: agents.map((agent) => agentView(agent, agent.skills.map((s) => s.skill))),
  });
});
