import { HttpError, noContent, route } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";

export const DELETE = route<{ id: string }>(async (_req, { id }) => {
  const workspaceId = await resolveWorkspaceId();
  const { count } = await prisma.voiceExample.deleteMany({ where: { id, workspaceId } });
  if (!count) throw new HttpError(404, "Example not found");
  return noContent();
});
