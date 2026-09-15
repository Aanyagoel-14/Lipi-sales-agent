import { json, route } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { runOut } from "../../shapes";

export const GET = route(async () => {
  const workspaceId = await resolveWorkspaceId();
  const rows = await prisma.agentRun.findMany({ where: { workspaceId }, orderBy: { ranAt: "desc" } });
  return json({ runs: rows.map(runOut) });
});
