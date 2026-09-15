import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma";
import { EMPTY_TOUCH, firstTouchData, hasAttribution, type AttributionTouch } from "./attribution";
import { ingest } from "./ingest";

/**
 * The webchat channel (Req 1).
 *
 * Every other channel is a webhook: a provider calls us, we run `ingest()`
 * inside `after()`, and reply through that provider's own send API. A
 * website visitor has no provider account to send through — the widget IS
 * the transport, so this module calls `ingest()` directly and hands the
 * reply straight back in the HTTP response. `replySent` still governs
 * whether that reply is shown immediately: a workspace on a strict
 * approval policy gets a holding message here exactly as it would get a
 * "held" conversation on any other channel, and the widget polls
 * `listSince` for the reply once an operator approves it.
 *
 * `visitorId` is minted client-side (see `public/static/widget.js`) and
 * kept in the browser's own localStorage — there is no server-issued
 * session token. That is a deliberate, narrow trust boundary: it is
 * exactly the model most embeddable chat widgets use (an opaque id the
 * script keeps), and the one thing it must never be treated as is a
 * *login* — a visitor who clears localStorage simply starts a new,
 * unrelated visitor row. `listSince` requires the same visitorId that
 * created the session before it will return that session's messages,
 * which is what stops a stranger from polling a conversation they did not
 * start; it is not a substitute for real authentication, and none of the
 * dashboard, orders, or twin-configuration surfaces are reachable this way.
 */

const id = (prefix: string) => `${prefix}_${randomUUID().slice(0, 8)}`;

export type SessionInput = {
  workspaceId: string;
  visitorId: string;
  touch: AttributionTouch;
};

export async function upsertSession(input: SessionInput) {
  const existing = await prisma.visitorSession.findUnique({
    where: { workspaceId_visitorId: { workspaceId: input.workspaceId, visitorId: input.visitorId } },
  });

  // First touch is written once, at creation, and never overwritten by a
  // later page load — see attribution.ts's own note on why a retargeting
  // click a month later must not re-attribute an existing visitor.
  const session = existing
    ? await prisma.visitorSession.update({
        where: { id: existing.id },
        data: { lastSeenAt: new Date() },
      })
    : await prisma.visitorSession.create({
        data: {
          id: id("vst"), workspaceId: input.workspaceId, visitorId: input.visitorId,
          ...(hasAttribution(input.touch) ? input.touch : EMPTY_TOUCH),
        },
      });

  const workspace = await prisma.workspace.findUnique({
    where: { id: input.workspaceId },
    select: { voice: { select: { greeting: true, signOff: true } }, name: true },
  });

  return {
    sessionId: session.id,
    greeting: workspace?.voice?.greeting ?? `Hi! How can ${workspace?.name ?? "we"} help?`,
  };
}

export type MessageInput = {
  workspaceId: string;
  visitorId: string;
  text: string;
  name?: string;
};

export async function sendVisitorMessage(input: MessageInput) {
  const session = await prisma.visitorSession.findUnique({
    where: { workspaceId_visitorId: { workspaceId: input.workspaceId, visitorId: input.visitorId } },
  });
  // A message can arrive before /session ever landed (a widget bug, a
  // direct API call, a page that skipped the load event) — start the
  // session here rather than reject the message the visitor actually sent.
  const touch: AttributionTouch = session ?? EMPTY_TOUCH;

  const result = await ingest({
    workspaceId: input.workspaceId,
    channel: "webchat",
    handle: `web:${input.visitorId}`,
    text: input.text,
    name: input.name,
  });

  // Copy first touch onto the customer twin exactly once — the moment a
  // customer row is first created for this visitor. `ingest()` stays
  // channel-agnostic; it has no idea what a VisitorSession is, so this
  // happens here, in the one caller that does.
  if (result.customer.isNew && hasAttribution(touch)) {
    await prisma.customer.update({
      where: { id: result.customer.id },
      data: firstTouchData(touch, new Date()),
    });
  }

  await prisma.visitorSession.upsert({
    where: { workspaceId_visitorId: { workspaceId: input.workspaceId, visitorId: input.visitorId } },
    create: {
      id: id("vst"), workspaceId: input.workspaceId, visitorId: input.visitorId,
      ...touch, customerId: result.customer.id, engagedAt: new Date(),
    },
    update: { customerId: result.customer.id, engagedAt: session?.engagedAt ?? new Date(), lastSeenAt: new Date() },
  });

  return result;
}

/** Agent replies sent after the visitor's own request returned — i.e. an
 *  approval that landed later — for the widget to pick up on its next poll. */
export async function listAgentMessagesSince(workspaceId: string, visitorId: string, conversationId: string, sinceIso: string | null) {
  const session = await prisma.visitorSession.findUnique({
    where: { workspaceId_visitorId: { workspaceId, visitorId } },
  });
  if (!session?.customerId) return [];

  // The visitorId must own the conversation it is polling — see the
  // module-level note on why this is the access boundary here.
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, workspaceId, customerId: session.customerId },
    select: { id: true },
  });
  if (!conversation) return [];

  const messages = await prisma.message.findMany({
    where: {
      conversationId,
      from: "agent",
      ...(sinceIso ? { sentAt: { gt: new Date(sinceIso) } } : {}),
    },
    orderBy: { sentAt: "asc" },
    select: { text: true, sentAt: true },
  });

  return messages.map((m) => ({ text: m.text, sentIso: m.sentAt.toISOString() }));
}
