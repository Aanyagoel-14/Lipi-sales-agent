import type { Prisma } from "@/generated/prisma/client";
import { body, json, route } from "@/server/lib/http";
import { preflight } from "@/server/lib/origins";
import { after, paged, pageOf } from "@/server/lib/page";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { ingest } from "@/server/services/ingest";
import { createConversationBody } from "../contract";
import { conversationSummaryOut } from "../shapes";

/** Enough for a preview line: the twin, the newest message, and how many. */
const summaryInclude = {
  customer: true,
  messages: { orderBy: { sentAt: "desc" }, take: 1 },
  _count: { select: { messages: true } },
} as const satisfies Prisma.ConversationInclude;

type SummaryRow = Prisma.ConversationGetPayload<{ include: typeof summaryInclude }>;

const summaryOf = (c: SummaryRow) =>
  conversationSummaryOut({ ...c, messageCount: c._count.messages, lastMessage: c.messages[0] });

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
    include: summaryInclude,
    take: page.take,
  });

  // `lastAt` moves when a thread gets a new message, so a thread can shift
  // under an open cursor. The client dedupes by id for that reason.
  const { rows, nextCursor } = paged(found, page, (c) => c.lastAt);

  return json({ nextCursor, conversations: rows.map(summaryOf) });
});

/**
 * Starts a conversation from the integrator's own site.
 *
 * The same message that `POST /v1/messages` takes, answered with the thread
 * it landed in. Both call `ingest()` — there is one path that decides what is
 * true about a message, and an integration must not get a second one that
 * could disagree with it.
 *
 * A handle that has written before resolves to its existing customer twin,
 * which is where continuity lives; the thread is per message, exactly as it
 * is for `/v1/messages`, and changing that is not this endpoint's business.
 */
export const POST = route(async (req) => {
  const data = await body(req, createConversationBody, "Invalid conversation");
  const workspaceId = await resolveWorkspaceId();
  const result = await ingest({ ...data, workspaceId });

  const conversation = await prisma.conversation.findFirstOrThrow({
    where: { id: result.conversationId, workspaceId },
    include: summaryInclude,
  });

  return json({ conversation: summaryOf(conversation), reply: result.reply }, 201);
});

export const OPTIONS = route(preflight);
