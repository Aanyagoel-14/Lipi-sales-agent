import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma";
import { EMPTY_TOUCH, firstTouchData, hasAttribution, type AttributionTouch } from "./attribution";
import { contactHeld, planContactCapture } from "./contacts";
import { nextContactAsk, type ContactField } from "./leads";
import { sell } from "./selling";
import type { DetectedContact } from "./extract";

/**
 * The webchat channel (Req 1).
 *
 * Every other channel is a webhook: a provider calls us, we run `ingest()`
 * inside `after()`, and reply through that provider's own send API. A
 * website visitor has no provider account to send through — the widget IS
 * the transport, so this module calls `sell()` directly and hands the
 * reply straight back in the HTTP response. `held` still governs
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

/**
 * The visitor, recorded at page load — before they open the panel, and
 * whether or not they ever do. That is the only moment the ad platform's
 * own query parameters are reliably still on the URL, and a visitor who
 * arrives from a paid click and reads the page without clicking is the
 * majority of ad traffic (Req 3).
 *
 * "Loaded" is not "engaged": this writes `createdAt`/`lastSeenAt` and never
 * `engagedAt`, which `sendVisitorMessage` stamps when the visitor first
 * says something. The greeting comes back with the row but is the widget's
 * to hold until the panel opens — nothing here shows anybody anything.
 */
export async function upsertSession(input: SessionInput) {
  // One statement rather than a read and then a write: capture happens on
  // every page load, so two tabs opening at the same moment is ordinary
  // traffic and a read-then-create would race them onto the unique index.
  //
  // First touch is written once, at creation, and never overwritten by a
  // later page load — `update` moves `lastSeenAt` and nothing else. See
  // attribution.ts's own note on why a retargeting click a month later must
  // not re-attribute an existing visitor (invariant 3).
  const session = await prisma.visitorSession.upsert({
    where: { workspaceId_visitorId: { workspaceId: input.workspaceId, visitorId: input.visitorId } },
    create: {
      id: id("vst"), workspaceId: input.workspaceId, visitorId: input.visitorId,
      ...(hasAttribution(input.touch) ? input.touch : EMPTY_TOUCH),
    },
    update: { lastSeenAt: new Date() },
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

  // `sell()` runs `ingest()` itself: the facts are decided exactly once, and
  // the model only chooses the words that carry them (invariant 2). It reads
  // this visitor's earlier turns too — by handle, which is the same customer
  // twin `session.customerId` points at — so the website's memory and every
  // webhook channel's are one piece of code.
  const result = await sell({
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

export type TypedContactResult = {
  captured: ContactField[];
  /** The address is on this twin and on another one in this workspace. The
   *  operator's flag, never a merge — see `services/contacts.ts`. */
  duplicateEmail: boolean;
  /** What the widget should put the next field on screen for, or null when
   *  there is nothing left worth asking. One at a time, here as in words. */
  contactAsk: ContactField | null;
};

/**
 * A contact detail typed into the widget's own field (#16).
 *
 * The other capture path rides inside `ingest()`'s transaction, because the
 * message that carried the address is being written anyway. Nothing else is
 * being written here — the visitor pressed Save on a box, not sent a message
 * — so this is its own transaction, and `planContactCapture` is what keeps
 * the two paths agreeing about what overwrites what.
 *
 * Null means this workspace has never heard from this visitor: the handle is
 * workspace-scoped, so there is no twin here to write onto (invariant 5).
 */
export async function captureTypedContact(input: {
  workspaceId: string;
  visitorId: string;
  detected: DetectedContact;
}): Promise<TypedContactResult | null> {
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    const customer = await tx.customer.findFirst({
      where: { workspaceId: input.workspaceId, handle: `web:${input.visitorId}` },
    });
    if (!customer) return null;

    const plan = await planContactCapture(tx, {
      workspaceId: input.workspaceId, customer, detected: input.detected, source: "form", now,
    });

    // Retyping the same address writes nothing, and a write of nothing is
    // still a write — so the twin is only touched when the plan says so.
    const updated = plan.captured.length
      ? await tx.customer.update({ where: { id: customer.id }, data: plan.update })
      : customer;

    await tx.twinEvent.createMany({
      data: plan.events.map((e, i) => ({
        id: id("evt"),
        workspaceId: input.workspaceId,
        occurredAt: new Date(now.getTime() + i),
        type: e.type,
        twin: e.twin,
        payload: e.payload,
      })),
    });

    return {
      captured: plan.captured,
      duplicateEmail: plan.duplicateEmailOf !== null,
      // Asked of the twin as it stands after the save, so the field the
      // widget shows next is never the one just filled in.
      contactAsk: nextContactAsk(updated.leadScore, updated.leadStage, contactHeld(updated)),
    };
  });
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
