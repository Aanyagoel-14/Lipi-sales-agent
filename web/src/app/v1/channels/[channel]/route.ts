import { HttpError, noContent, route } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";

export const DELETE = route<{ channel: string }>(async (_req, { channel }) => {
  const workspaceId = await resolveWorkspaceId();

  const { count } = await prisma.channelConnection.deleteMany({
    where: { workspaceId, channel: channel as never },
  });
  if (!count) throw new HttpError(404, "That channel is not connected");

  return noContent();
});
