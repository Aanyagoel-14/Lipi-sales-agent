import { HttpError, json, route } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { customerOut, messageOut } from "../../shapes";

/** One thread, with its messages. What the reading pane actually needs. */
export const GET = route<{ id: string }>(async (_req, { id }) => {
  const workspaceId = await resolveWorkspaceId();
  const conversation = await prisma.conversation.findFirst({
    where: { id, workspaceId },
    include: { customer: true, messages: { orderBy: { sentAt: "asc" } } },
  });
  if (!conversation) throw new HttpError(404, "Conversation not found");

  return json({
    conversation: {
      id: conversation.id, customerId: conversation.customerId, channel: conversation.channel,
      subject: conversation.subject, unread: conversation.unread,
      lastAtIso: conversation.lastAt.toISOString(), intent: conversation.intent,
      signals: conversation.signals,
      messageCount: conversation.messages.length,
      messages: conversation.messages.map(messageOut),
      customer: customerOut(conversation.customer),
    },
  });
});
