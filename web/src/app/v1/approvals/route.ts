import { json, route } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";

export const GET = route(async () => {
  const workspaceId = await resolveWorkspaceId();
  const rows = await prisma.approval.findMany({ where: { workspaceId }, orderBy: { raisedAt: "desc" } });
  return json({
    approvals: rows.map((a) => ({
      id: a.id, runId: a.runId, agent: a.agent, summary: a.summary, detail: a.detail,
      impact: a.impact, raisedIso: a.raisedAt.toISOString(), severity: a.severity,
    })),
  });
});
