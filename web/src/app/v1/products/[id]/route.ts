import { HttpError, json, route } from "@/server/lib/http";
import { preflight } from "@/server/lib/origins";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { productOut } from "../../shapes";

/**
 * One product with its variants and their live stock.
 *
 * The read half of the catalogue. `/v1/catalogue/products/[id]` is the
 * dashboard's editing surface and keeps its own verbs; this is the shape an
 * integration renders a product page from.
 */
export const GET = route<{ id: string }>(async (_req, { id }) => {
  const workspaceId = await resolveWorkspaceId();
  const product = await prisma.product.findFirst({
    where: { id, workspaceId },
    include: { variants: { orderBy: [{ optionA: "asc" }, { optionB: "asc" }] } },
  });
  if (!product) throw new HttpError(404, "Product not found");

  return json({ product: productOut(product) });
});

export const OPTIONS = route<{ id: string }>(preflight);
