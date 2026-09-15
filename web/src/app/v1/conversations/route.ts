import { json, route } from "@/server/lib/http";
import { after, paged, pageOf } from "@/server/lib/page";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { customerOut, messageOut } from "../shapes";

/**
 * The thread list carries a preview, not the thread.
 *
 * Loading every message of every conversation to render a list that shows one
 * line each is the whole table on every dashboard render. The open thread is
 * fetched by id instead, which is the only one whose messages are on screen.
 */
export const GET = route(async (req) => {
  const workspaceId = await resolveWorkspaceId();
  const page = pageOf(req);

  const found = await prisma.conversation.findMany({
    where: { workspaceId, ...after("lastAt", page) },
    // Ends in a unique column, or the anchor is ambiguous.
    orderBy: [{ lastAt: "desc" }, { id: "desc" }],
    include: {
      customer: true,
      messages: { orderBy: { sentAt: "desc" }, take: 1 },
      _count: { select: { messages: true } },
    },
    take: page.take,
  });

  // `lastAt` moves when a thread gets a new message, so a thread can shift
  // under an open cursor. The client dedupes by id for that reason.
  const { rows, nextCursor } = paged(found, page, (c) => c.lastAt);

  return json({
    nextCursor,
    conversations: rows.map((c) => ({
      id: c.id, customerId: c.customerId, channel: c.channel, subject: c.subject,
      unread: c.unread, lastAtIso: c.lastAt.toISOString(), intent: c.intent,
      signals: c.signals,
      messageCount: c._count.messages,
      lastMessage: c.messages[0] ? messageOut(c.messages[0]) : null,
      customer: customerOut(c.customer),
    })),
  });
});
