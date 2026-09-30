import { body, json, route } from "@/server/lib/http";
import { eventId } from "@/server/lib/events";
import { preflight } from "@/server/lib/origins";
import { after, paged, pageOf } from "@/server/lib/page";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { createEventBody, EXTERNAL_EVENT_PREFIX } from "../contract";
import { eventOut } from "../shapes";

export const GET = route(async (req) => {
  const workspaceId = await resolveWorkspaceId();
  const page = pageOf(req);
  const found = await prisma.twinEvent.findMany({
    where: { workspaceId, ...after("occurredAt", page) },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: page.take,
  });
  const { rows, nextCursor } = paged(found, page, (e) => e.occurredAt);
  return json({ nextCursor, events: rows.map(eventOut) });
});

/**
 * Records something that happened on the integrator's own site.
 *
 * The event log is append-only evidence, so this only ever inserts: there is
 * no update and no delete, here or anywhere.
 *
 * Two things the caller does not get to decide. The **type** is namespaced
 * under `external.`, because evidence a caller can author under the system's
 * own event names is not evidence — nothing posted here can be mistaken for
 * something `ingest()` observed. And `occurredIso` may only date an event
 * into the past: a caller with a fast clock could otherwise park a row above
 * every future page of a newest-first list.
 */
export const POST = route(async (req) => {
  const data = await body(req, createEventBody, "Invalid event");
  const workspaceId = await resolveWorkspaceId();

  const now = new Date();
  const occurredAt = data.occurredIso ? new Date(data.occurredIso) : now;

  const event = await prisma.twinEvent.create({
    data: {
      id: eventId(),
      workspaceId,
      occurredAt: occurredAt > now ? now : occurredAt,
      type: `${EXTERNAL_EVENT_PREFIX}${data.type}`,
      twin: data.twin,
      payload: data.payload,
    },
  });

  return json({ event: eventOut(event) }, 201);
});

export const OPTIONS = route(preflight);
