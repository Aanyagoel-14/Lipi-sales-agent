import { prisma } from "@/server/lib/prisma";

/** The event log's id scheme, shared by every route that writes to it. */
export const eventId = () =>
  `evt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const recordEvent = (workspaceId: string, type: string, twin: string, payload: string) =>
  prisma.twinEvent.create({
    data: { id: eventId(), workspaceId, occurredAt: new Date(), type, twin, payload },
  });
