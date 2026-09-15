import { z } from "zod";
import { body, HttpError, json, route } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { requireConnector } from "../../../view";

export const GET = route<{ id: string }>(async (_req, { id }) => {
  const workspaceId = await resolveWorkspaceId();
  const connector = await requireConnector(id, workspaceId);

  const rows = await prisma.inventoryMapping.findMany({
    where: { connectorId: connector.id },
    include: { variant: { include: { product: { select: { id: true, name: true } } } } },
    orderBy: { externalSku: "asc" },
  });

  return json({
    mappings: rows.map((m) => ({
      id: m.id, externalSku: m.externalSku, variantId: m.variantId,
      productId: m.variant.product.id, product: m.variant.product.name,
      variant: `${m.variant.optionA} / ${m.variant.optionB}`,
      stock: m.variant.stock, reserved: m.variant.reserved,
    })),
  });
});

const mapSchema = z.object({
  externalSku: z.string().trim().min(1).max(120),
  variantId: z.string().trim().min(1).max(60),
});

export const POST = route<{ id: string }>(async (req, { id }) => {
  const workspaceId = await resolveWorkspaceId();
  const connector = await requireConnector(id, workspaceId);
  const data = await body(req, mapSchema, "Check the mapping");

  // The variant has to be one of ours, or the connector would be given a
  // handle on another tenant's stock.
  const variant = await prisma.variant.findFirst({
    where: { id: data.variantId, product: { workspaceId } },
  });
  if (!variant) throw new HttpError(422, "That variant is not in this workspace");

  const mapping = await prisma.inventoryMapping.upsert({
    where: { connectorId_externalSku: { connectorId: connector.id, externalSku: data.externalSku } },
    create: { connectorId: connector.id, ...data },
    update: { variantId: data.variantId },
  });

  return json({ mapping }, 201);
});
