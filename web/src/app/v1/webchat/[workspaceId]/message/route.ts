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
 * workspace's approval policy held it (`held`), in which case the widget
 * polls `/updates` for it once an operator approves.
 *
 * The body is the widget's whole contract (`public/static/widget.js`), so it
 * stays these three fields: whether the model or the template wrote the words
 * is the operator's business, not a visitor's.
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
    reply: result.held ? null : result.reply,
    // The field belongs beside the sentence that asked for it. Under a policy
    // that holds replies there is no sentence on screen yet, so no field.
    contactAsk: result.held ? null : result.contactAsk,
    held: result.held,
  }, 201);
});
