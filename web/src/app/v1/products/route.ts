import { json, route } from "@/server/lib/http";
import { preflight } from "@/server/lib/origins";
import { afterText, paged, pageOf } from "@/server/lib/page";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { productOut } from "../shapes";

/**
 * The catalogue, A to Z.
 *
 * Alphabetical rather than newest-first because that is the order a human
 * reads a catalogue in, and products carry no created timestamp to sort on.
 * The cursor is the same opaque keyset cursor as everywhere else; only the
 * key it carries is text.
 *
 * `suppliers` is the whole set, not a page: a catalogue of any size is
 * sourced from a handful of them, and a product row is unreadable without the
 * supplier it names.
 */
export const GET = route(async (req) => {
  const workspaceId = await resolveWorkspaceId();
  const page = pageOf(req);

  const [found, suppliers] = await Promise.all([
    prisma.product.findMany({
      where: { workspaceId, ...afterText("name", page) },
      include: { variants: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: page.take,
    }),
    // Only the contracted columns: the row also carries `workspaceId`, which
    // is the caller's own tenant restated and has no business in a response.
    prisma.supplier.findMany({
      where: { workspaceId },
      select: {
        id: true, name: true, onTimePct: true, avgLeadDays: true,
        defectRatePct: true, moq: true, responseHours: true,
      },
    }),
  ]);
  const { rows, nextCursor } = paged(found, page, (p) => p.name);

  return json({ nextCursor, products: rows.map(productOut), suppliers });
});

export const OPTIONS = route(preflight);
