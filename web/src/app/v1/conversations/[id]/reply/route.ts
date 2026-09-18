import { z } from "zod";
import { sendReply } from "@/server/channels/outbound";
import { body, HttpError, json, route } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { requireUser } from "@/server/lib/session";
import { resolveWorkspaceId } from "@/server/lib/workspace";

/** Replying by hand. The twin records it as its own message so history stays whole. */
const replySchema = z.object({ text: z.string().trim().min(1).max(2000) });

export const POST = route<{ id: string }>(async (req, { id: conversationId }) => {
  const user = await requireUser();
  const workspaceId = await resolveWorkspaceId();
  const data = await body(req, replySchema, "Write something first");

  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, workspaceId },
    include: { customer: true },
  });
  if (!conversation) throw new HttpError(404, "Conversation not found");

  // Written first and marked as in flight, so the thread is whole even if the
  // provider refuses — and so it never reads as delivered before it is.
  const message = await prisma.message.create({
    data: { from: "agent", text: data.text, sentAt: new Date(), conversationId, deliveryStatus: "pending" },
  });
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { lastAt: new Date(), unread: false },
  });

  // `sendReply` records the outcome, on the message and in the event trail.
  const { delivered, reason } = await sendReply({
    workspaceId, conversationId, messageId: message.id, by: user.email,
  });

  return json({ ok: true, delivered, ...(reason ? { reason } : {}) }, 201);
});
