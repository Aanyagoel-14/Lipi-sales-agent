import { HttpError, json, route } from "@/server/lib/http";
import { preflight } from "@/server/lib/origins";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { conversationOut } from "../../shapes";

/** One thread, with its messages. What the reading pane actually needs. */
export const GET = route<{ id: string }>(async (_req, { id }) => {
  const workspaceId = await resolveWorkspaceId();
  const conversation = await prisma.conversation.findFirst({
    where: { id, workspaceId },
    include: { customer: true, messages: { orderBy: { sentAt: "asc" } } },
  });
  if (!conversation) throw new HttpError(404, "Conversation not found");

  return json({ conversation: conversationOut(conversation) });
});

export const OPTIONS = route<{ id: string }>(preflight);
