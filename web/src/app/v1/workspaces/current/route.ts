import { z } from "zod";
import { body, json, route } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";

export const GET = route(async () => {
  const id = await resolveWorkspaceId();
  const workspace = await prisma.workspace.findUnique({
    where: { id },
    include: { voice: true, _count: { select: {
      knowledge: true, examples: true, products: true, customers: true,
      connections: { where: { status: "connected" } }, agentRuns: true,
    } } },
  });
  return json({ workspace });
});

const settingsSchema = z.object({
  approvalPolicy: z.enum(["everything", "money_only", "nothing"]).optional(),
  name: z.string().trim().min(2).max(80).optional(),
});

/** Used by the wizard's approvals step, and later by settings. */
export const PATCH = route(async (req) => {
  const workspaceId = await resolveWorkspaceId();
  const data = await body(req, settingsSchema, "Check the settings");
  return json({ workspace: await prisma.workspace.update({ where: { id: workspaceId }, data }) });
});
