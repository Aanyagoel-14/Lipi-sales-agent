import { adapterFor } from "@/server/channels/index";
import { decrypt } from "@/server/lib/crypto";
import { HttpError, json, route } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { requireUser } from "@/server/lib/session";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { recordEvent } from "../../../events";

/**
 * Approving is what makes the queue mean anything. The run is marked done, the
 * approval is cleared, and who did it is written to the event log — an
 * approval nobody can trace is not an audit trail.
 */
export const POST = route<{ id: string; decision: string }>(async (_req, { id, decision }) => {
  const user = await requireUser();
  const workspaceId = await resolveWorkspaceId();

  if (decision !== "approve" && decision !== "reject") {
    throw new HttpError(400, "Decision must be approve or reject");
  }

  const approval = await prisma.approval.findFirst({
    where: { id, workspaceId },
    include: { run: { include: { conversation: true } } },
  });
  if (!approval) throw new HttpError(404, "Approval not found");

  const approved = decision === "approve";
  let delivered = false;

  await prisma.$transaction(async (tx) => {
    await tx.agentRun.update({
      where: { id: approval.runId },
      data: { status: approved ? "done" : "failed" },
    });
    await tx.approval.delete({ where: { id: approval.id } });
  });

  await recordEvent(
    workspaceId,
    approved ? "approval.granted" : "approval.rejected",
    "conversation",
    `${approval.agent} "${approval.summary}" by ${user.email}`,
  );

  // Approving a held reply is what finally sends it.
  const conversation = approval.run.conversation;
  if (approved && conversation) {
    const held = await prisma.message.findFirst({
      where: { conversationId: conversation.id, from: "agent" },
      orderBy: { sentAt: "desc" },
    });

    const connection = await prisma.channelConnection.findUnique({
      where: { workspaceId_channel: { workspaceId, channel: conversation.channel } },
    });
    const adapter = adapterFor(conversation.channel);
    const customer = await prisma.customer.findUnique({ where: { id: conversation.customerId } });

    if (held && connection?.secretCipher && adapter && customer) {
      const secret = decrypt(connection.secretCipher);
      if (secret) {
        try {
          await adapter.send({
            secret, config: connection.config as Record<string, unknown>,
            to: customer.handle, text: held.text,
          });
          delivered = true;
          await recordEvent(workspaceId, "reply.sent", "conversation", `${conversation.id} via ${conversation.channel}`);
        } catch (error) {
          await recordEvent(workspaceId, "reply.failed", "conversation", (error as Error).message.slice(0, 200));
        }
      }
    }
  }

  return json({ ok: true, decision, delivered });
});
