import { HttpError, json, route } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { recordEvent } from "@/server/lib/events";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { apiKeyView } from "../view";

/**
 * Revoke, not delete. The row is what answers "what was that key, and when
 * did it last call" after the fact, and a deleted key cannot be told apart
 * from one that never existed.
 */
export const DELETE = route<{ id: string }>(async (_req, { id }) => {
  const workspaceId = await resolveWorkspaceId({ sessionOnly: true });

  const { count } = await prisma.apiKey.updateMany({
    where: { id, workspaceId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (!count) throw new HttpError(404, "Key not found");

  const key = await prisma.apiKey.findUniqueOrThrow({ where: { id } });
  await recordEvent(workspaceId, "api_key.revoked", "operations", `${key.name} (${key.prefix}…)`);

  return json({ key: apiKeyView(key) });
});
