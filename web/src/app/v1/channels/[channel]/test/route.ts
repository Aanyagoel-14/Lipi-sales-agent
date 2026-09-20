import type { Channel } from "@/generated/prisma/client";
import { runIdentity, short } from "@/server/channels/connect";
import { specFor } from "@/server/channels/registry";
import { HttpError, json, route } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";

/**
 * Proves a connection still works, by doing the smallest real thing the
 * provider offers — the same read call the connect step used to identify the
 * account. Nothing is decrypted here any more, because there is nothing
 * stored to decrypt: the credential lives in Composio and this asks Composio
 * to use it.
 */
export const POST = route<{ channel: string }>(async (_req, params) => {
  const workspaceId = await resolveWorkspaceId();
  const channel = params.channel as Channel;

  const spec = specFor(channel);
  if (!spec) throw new HttpError(400, `${params.channel} cannot be tested`);

  const connection = await prisma.channelConnection.findUnique({
    where: { workspaceId_channel: { workspaceId, channel } },
  });
  if (!connection?.composioAccountId) throw new HttpError(404, "That channel is not connected");

  try {
    const identity = await runIdentity(spec, workspaceId, connection.composioAccountId);
    await prisma.channelConnection.update({
      where: { id: connection.id },
      data: {
        // A passing test recovers a row that had failed, but never promotes
        // one that is still `pending`: connect's own hooks have not run, so
        // the connection is not finished even though the account answers.
        ...(connection.status === "pending" ? {} : { status: "connected" }),
        displayName: identity.displayName,
        lastError: null,
      },
    });
    return json({ ok: true, displayName: identity.displayName });
  } catch (error) {
    const message = short(error);
    await prisma.channelConnection.update({
      where: { id: connection.id },
      data: { status: "error", lastError: message },
    });
    return json({ ok: false, error: message }, 400);
  }
});
