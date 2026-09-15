import { body, HttpError, json, route } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { eventId } from "../../../../events";
import { stockSchema } from "../../../schemas";

/** Stock corrections are a first-class action: the twin is only as good as this number. */
export const PUT = route<{ id: string }>(async (req, { id: productId }) => {
  const workspaceId = await resolveWorkspaceId();

  const product = await prisma.product.findFirst({
    where: { id: productId, workspaceId },
    include: { variants: true },
  });
  if (!product) throw new HttpError(404, "Product not found");

  const data = await body(req, stockSchema, "Check the stock figures");
  const changes: string[] = [];

  await prisma.$transaction(async (tx) => {
    for (const update of data.variants) {
      const existing = product.variants.find(
        (v) => v.optionA === update.optionA && v.optionB === update.optionB,
      );
      if (!existing || existing.stock === update.stock) continue;

      await tx.variant.update({ where: { id: existing.id }, data: { stock: update.stock } });
      changes.push(`${update.optionA}/${update.optionB} ${existing.stock}->${update.stock}`);
    }

    if (changes.length) {
      await tx.twinEvent.create({
        data: {
          id: eventId(), workspaceId, occurredAt: new Date(),
          type: "inventory_twin.corrected", twin: "inventory",
          payload: `${product.id} ${changes.join(" ")}`,
        },
      });
    }
  });

  return json({ updated: changes.length, changes });
});
