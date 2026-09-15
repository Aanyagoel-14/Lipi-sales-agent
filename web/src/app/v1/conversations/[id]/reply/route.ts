import { z } from "zod";
import { adapterFor } from "@/server/channels/index";
import { decrypt } from "@/server/lib/crypto";
import { body, HttpError, json, route } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { requireUser } from "@/server/lib/session";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { recordEvent } from "../../../events";

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

  await prisma.message.create({
    data: { from: "agent", text: data.text, sentAt: new Date(), conversationId },
  });
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { lastAt: new Date(), unread: false },
  });

  let delivered = false;
  const connection = await prisma.channelConnection.findUnique({
    where: { workspaceId_channel: { workspaceId, channel: conversation.channel } },
  });
  const adapter = adapterFor(conversation.channel);

  if (connection?.secretCipher && adapter) {
    const secret = decrypt(connection.secretCipher);
    if (secret) {
      try {
        await adapter.send({
          secret, config: connection.config as Record<string, unknown>,
          to: conversation.customer.handle, text: data.text,
        });
        delivered = true;
      } catch {
        delivered = false;
      }
    }
  }

  await recordEvent(workspaceId, delivered ? "reply.sent" : "reply.recorded", "conversation",
    `${conversationId} by ${user.email}`);

  return json({ ok: true, delivered }, 201);
});
