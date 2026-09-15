import { corsPreflight, corsRoute } from "@/server/lib/cors";
import { HttpError, json } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { listAgentMessagesSince } from "@/server/services/webchat";
import { updatesSchema } from "../../schemas";

export const OPTIONS = corsPreflight;

/**
 * Polled by the widget after a held reply — a message sent under a strict
 * approval policy comes back from `POST /message` with `held: true` and no
 * text; this is how the widget later picks up the reply once an operator
 * approves it. GET with query params rather than POST with a body: this is
 * a read, and it is what lets the widget poll on an interval without
 * building a request body each time.
 */
export const GET = corsRoute<{ workspaceId: string }>(async (req, { workspaceId }) => {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } });
  if (!workspace) throw new HttpError(404, "Unknown workspace");

  const url = new URL(req.url);
  const parsed = updatesSchema.safeParse({
    visitorId: url.searchParams.get("visitorId") ?? undefined,
    conversationId: url.searchParams.get("conversationId") ?? undefined,
    sinceIso: url.searchParams.get("sinceIso") ?? undefined,
  });
  if (!parsed.success) throw new HttpError(422, "Check visitorId and conversationId");

  const messages = await listAgentMessagesSince(
    workspaceId, parsed.data.visitorId, parsed.data.conversationId, parsed.data.sinceIso ?? null,
  );

  return json({ messages });
});
