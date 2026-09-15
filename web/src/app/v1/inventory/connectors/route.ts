import { z } from "zod";
import { body, HttpError, json, route } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { newConnectorSecret, reconcile } from "@/server/services/inventory";
import { eventId } from "../../events";
import { connectorView, SOURCES } from "../view";

/** Connector health, exception counts and mapping coverage in one read. */
export const GET = route(async () => json(await reconcile(await resolveWorkspaceId())));

const createSchema = z.object({
  source: z.enum(SOURCES),
  name: z.string().trim().min(2).max(80),
});

export const POST = route(async (req) => {
  const workspaceId = await resolveWorkspaceId();
  const data = await body(req, createSchema, "Check the connector");

  const clash = await prisma.inventoryConnector.findUnique({
    where: { workspaceId_source: { workspaceId, source: data.source } },
  });
  if (clash) throw new HttpError(409, `A ${data.source} connector already exists`);

  const { secret, hash } = newConnectorSecret();
  const connector = await prisma.inventoryConnector.create({
    data: { workspaceId, ...data, secretHash: hash },
  });

  await prisma.twinEvent.create({
    data: {
      id: eventId(), workspaceId, occurredAt: new Date(),
      type: "inventory_connector.created", twin: "inventory",
      payload: `${connector.source} "${connector.name}"`,
    },
  });

  // Shown exactly once. There is no endpoint that can return it again.
  return json({ connector: connectorView(connector), secret }, 201);
});
