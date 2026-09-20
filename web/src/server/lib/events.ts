import { prisma } from "./prisma";

/**
 * The event log's id scheme and writer.
 *
 * This lived in `src/app/v1/events.ts` while only routes wrote events. The
 * connect flow writes one from the server layer, and a server module importing
 * from `app/` is backwards, so the definition moved down here and the old path
 * re-exports it — every existing `from "../../events"` still resolves.
 */
export const eventId = () =>
  `evt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const recordEvent = (workspaceId: string, type: string, twin: string, payload: string) =>
  prisma.twinEvent.create({
    data: { id: eventId(), workspaceId, occurredAt: new Date(), type, twin, payload },
  });
