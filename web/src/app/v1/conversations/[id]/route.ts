import { HttpError, json, route, searchParams } from "@/server/lib/http";
import { preflight } from "@/server/lib/origins";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { conversationOut } from "../../shapes";

/**
 * One thread, with its messages. What the reading pane actually needs.
 *
 * `?by=customer` widens it to everything this customer has said on this
 * channel, across the conversation-per-message rows `ingest()` writes, so the
 * inbox reads as one continuing chat. The conversation named is still the
 * one returned, and still the one a reply is sent against.
 */
export const GET = route<{ id: string }>(async (req, { id }) => {
  const workspaceId = await resolveWorkspaceId();
  const conversation = await prisma.conversation.findFirst({
    where: { id, workspaceId },
    include: { customer: true, messages: { orderBy: { sentAt: "asc" } } },
  });
  if (!conversation) throw new HttpError(404, "Conversation not found");

  if (searchParams(req).get("by") === "customer") {
    const messages = await prisma.message.findMany({
      where: { conversation: { workspaceId, customerId: conversation.customerId, channel: conversation.channel } },
      orderBy: [{ sentAt: "asc" }, { id: "asc" }],
    });
    return json({ conversation: conversationOut({ ...conversation, messages }) });
  }

  return json({ conversation: conversationOut(conversation) });
});

export const OPTIONS = route<{ id: string }>(preflight);
