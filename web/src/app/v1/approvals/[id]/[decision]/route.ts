import { sendReply } from "@/server/channels/outbound";
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
  if (conversation) {
    const draft = await prisma.message.findFirst({
      where: { conversationId: conversation.id, from: "agent" },
      orderBy: { sentAt: "desc" },
    });

    // A message the provider already accepted is history, not a draft. Without
    // this guard a second decision on the same thread would re-send it.
    if (draft && draft.deliveryStatus !== "sent") {
      if (approved) {
        ({ delivered } = await sendReply({
          workspaceId, conversationId: conversation.id, messageId: draft.id, by: user.email,
        }));
      } else {
        // A rejected reply is never sent. Saying so on the message is what
        // stops the inbox implying it went out.
        await prisma.message.update({
          where: { id: draft.id },
          data: { deliveryStatus: "held", deliveryError: null },
        });
      }
    }
  }

  return json({ ok: true, decision, delivered });
});
