import { messageCustomer, sendReply } from "@/server/channels/outbound";
import { HttpError, json, route } from "@/server/lib/http";
import { toRupees } from "@/server/lib/money";
import { publicInvoiceUrl } from "@/server/lib/payments";
import { prisma } from "@/server/lib/prisma";
import { requireUser } from "@/server/lib/session";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { invoiceForOrder } from "@/server/services/invoicing";
import { confirmOrder, releaseHold } from "@/server/services/reservations";
import { recordEvent } from "../../../events";

/**
 * Approving is what makes the queue mean anything. The run is marked done, the
 * approval is cleared, and who did it is written to the event log — an
 * approval nobody can trace is not an audit trail.
 *
 * An approval that carries an order is a purchase order waiting on its
 * terms. Approving confirms the order — its stock is held until it settles
 * rather than for four hours — issues the invoice, and tells the customer,
 * with the link to pay it. Rejecting gives the stock back at once. Before
 * this, approving changed nothing about the order, and the customer who had
 * been told "someone will confirm shortly" was never told anything again.
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
    if (approval.orderId) {
      if (approved) {
        // Refused, and the approval kept, when the hold lapsed and the stock
        // has since gone: "confirmed" would not be true.
        const confirmed = await confirmOrder(tx, workspaceId, approval.orderId);
        if (!confirmed.ok) throw new HttpError(409, confirmed.reason);
      } else {
        await releaseHold(tx, workspaceId, approval.orderId, `Purchase order declined by ${user.email}`);
      }
    }
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
  if (approval.orderId) {
    await recordEvent(workspaceId, "order_twin.updated", "order",
      `${approval.orderId} ${approved ? "Quoted->Confirmed" : "purchase order declined"} by ${user.email}`);
  }

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

  // The confirmed purchase order gets its invoice now, on the terms its
  // customer's segment carries, and the customer is told — after the held
  // reply, if there was one, so the thread reads in order.
  if (approved && approval.orderId) {
    const { invoice } = await invoiceForOrder(workspaceId, approval.orderId);
    const sent = await messageCustomer({
      workspaceId,
      orderId: approval.orderId,
      by: user.email,
      text:
        `Your purchase order is confirmed. Invoice ${invoice.number} for ₹${toRupees(invoice.amount).toLocaleString("en-IN")}, ` +
        `payable by ${invoice.dueOn.toISOString().slice(0, 10)}: ${publicInvoiceUrl(invoice.number)}`,
    });
    delivered = delivered || Boolean(sent?.delivered);
  }

  return json({ ok: true, decision, delivered });
});
