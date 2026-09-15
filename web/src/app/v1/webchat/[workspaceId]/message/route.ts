import { corsPreflight, corsRoute } from "@/server/lib/cors";
import { HttpError, body, json } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { sendVisitorMessage } from "@/server/services/webchat";
import { messageSchema } from "../../schemas";

export const OPTIONS = corsPreflight;

/**
 * A message from an anonymous website visitor. Unlike every other channel,
 * there is no provider to send the reply through — the reply goes straight
 * back in this response, and the widget shows it immediately unless the
 * workspace's approval policy held it (`replySent: false`), in which case
 * the widget polls `/updates` for it once an operator approves.
 */
export const POST = corsRoute<{ workspaceId: string }>(async (req, { workspaceId }) => {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } });
  if (!workspace) throw new HttpError(404, "Unknown workspace");

  const data = await body(req, messageSchema, "Check the message");
  const result = await sendVisitorMessage({
    workspaceId, visitorId: data.visitorId, text: data.text, name: data.name,
  });

  return json({
    conversationId: result.conversationId,
    reply: result.replySent ? result.reply : null,
    held: !result.replySent,
  }, 201);
});
