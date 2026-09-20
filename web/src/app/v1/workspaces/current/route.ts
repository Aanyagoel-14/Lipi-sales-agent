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

/**
 * A browser origin, exactly as a browser sends one: scheme, host, optional
 * port, and nothing else. No path, no trailing slash, and no `*` — a
 * wildcard here would hand every page on the web a key-authenticated call,
 * which is the opposite of what an allow-list is for. See lib/origins.ts.
 */
const originSchema = z
  .url({ protocol: /^https?$/ })
  .max(200)
  .refine(bareOrigin, "Give the origin only, with no path: https://example.com");

function bareOrigin(value: string): boolean {
  // Every refinement runs even when the URL check above already failed, so
  // this has to survive a value that is not a URL at all.
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}

const settingsSchema = z.object({
  approvalPolicy: z.enum(["everything", "money_only", "nothing"]).optional(),
  name: z.string().trim().min(2).max(80).optional(),
  /** Replaces the list; sending `[]` closes the workspace to browsers again. */
  allowedOrigins: z.array(originSchema).max(20).optional(),
});

/** Used by the wizard's approvals step, and later by settings. */
export const PATCH = route(async (req) => {
  const workspaceId = await resolveWorkspaceId();
  const data = await body(req, settingsSchema, "Check the settings");
  return json({ workspace: await prisma.workspace.update({ where: { id: workspaceId }, data }) });
});
