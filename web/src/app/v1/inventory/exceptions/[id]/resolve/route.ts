import { z } from "zod";
import { body, HttpError, json, route } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { requireUser } from "@/server/lib/session";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { eventId } from "../../../../events";

const resolveSchema = z.object({
  /** Mapping the SKU is the fix for the common case; dismissing is for a SKU
   *  the business does not sell through this twin at all. */
  action: z.enum(["map", "dismiss"]),
  variantId: z.string().trim().min(1).max(60).optional(),
});

export const POST = route<{ id: string }>(async (req, { id }) => {
  const user = await requireUser();
  const workspaceId = await resolveWorkspaceId();
  const data = await body(req, resolveSchema, "Say how to resolve it");

  const exception = await prisma.inventoryException.findFirst({
    where: { id, connector: { workspaceId } },
  });
  if (!exception) throw new HttpError(404, "Exception not found");
  if (exception.resolvedAt) throw new HttpError(409, "That exception is already resolved");

  if (data.action === "map") {
    if (!data.variantId) throw new HttpError(422, "Choose the variant this SKU means");

    const variant = await prisma.variant.findFirst({
      where: { id: data.variantId, product: { workspaceId } },
    });
    if (!variant) throw new HttpError(422, "That variant is not in this workspace");

    await prisma.inventoryMapping.upsert({
      where: {
        connectorId_externalSku: { connectorId: exception.connectorId, externalSku: exception.externalSku },
      },
      create: {
        connectorId: exception.connectorId, externalSku: exception.externalSku,
        variantId: data.variantId,
      },
      update: { variantId: data.variantId },
    });
  }

  // Every exception on this SKU for this connector, not just the one clicked:
  // a daily sync raises the same unmapped SKU every day, and mapping it fixes
  // all of them at once.
  const { count } = await prisma.inventoryException.updateMany({
    where: {
      connectorId: exception.connectorId,
      externalSku: exception.externalSku,
      kind: exception.kind,
      resolvedAt: null,
    },
    data: { resolvedAt: new Date(), resolvedBy: user.email },
  });

  await prisma.twinEvent.create({
    data: {
      id: eventId(), workspaceId, occurredAt: new Date(),
      type: "inventory_exception.resolved", twin: "inventory",
      payload: `sku=${exception.externalSku} action=${data.action} count=${count} by ${user.email}`,
    },
  });

  return json({ ok: true, resolved: count });
});
