import { adapterFor } from "@/server/channels/index";
import { decrypt } from "@/server/lib/crypto";
import { HttpError, json, route } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import type { ChannelName } from "../../view";

export const POST = route<{ channel: string }>(async (_req, params) => {
  const workspaceId = await resolveWorkspaceId();
  const channel = params.channel as ChannelName;

  const connection = await prisma.channelConnection.findUnique({
    where: { workspaceId_channel: { workspaceId, channel } },
  });
  if (!connection?.secretCipher) throw new HttpError(404, "That channel is not connected");

  const adapter = adapterFor(channel);
  const secret = decrypt(connection.secretCipher);
  if (!adapter || !secret) throw new HttpError(500, "Stored credentials could not be read. Reconnect the channel.");

  try {
    const identity = await adapter.test({ secret, config: connection.config as Record<string, unknown> });
    await prisma.channelConnection.update({
      where: { id: connection.id },
      data: { status: "connected", lastError: null, displayName: identity.displayName },
    });
    return json({ ok: true, ...identity });
  } catch (error) {
    const message = (error as Error).message;
    await prisma.channelConnection.update({
      where: { id: connection.id },
      data: { status: "error", lastError: message },
    });
    return json({ ok: false, error: message }, 400);
  }
});
