import { HttpError, json, route } from "@/server/lib/http";
import { preflight } from "@/server/lib/origins";
import { after, paged, pageOf } from "@/server/lib/page";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { conversionStageQuery } from "../contract";
import { conversionOut } from "../shapes";

/**
 * What the conversations produced: orders, seen as conversions.
 *
 * A read-only projection of the rows `/v1/orders` already serves, not a
 * second sales record — the repo has one order path and this does not add
 * another. The difference is what an external funnel needs and the dashboard
 * does not: the exact paise, and the customer's first-touch attribution, so a
 * campaign can be credited without a second round trip per row.
 *
 * `stage` filters to the stages that count as converted for the caller's
 * definition of the word. Which stages those are is the caller's business
 * decision, not ours, so it is a parameter and not a constant in here.
 */
export const GET = route(async (req) => {
  const workspaceId = await resolveWorkspaceId();
  const page = pageOf(req);
  const stages = stageFilter(req);

  const found = await prisma.order.findMany({
    where: { workspaceId, ...(stages.length ? { stage: { in: stages } } : {}), ...after("createdAt", page) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    // Only the attribution columns: the twin itself is `/v1/customers/{id}`,
    // and joining it whole would put a second full row behind every order.
    include: {
      customer: {
        select: {
          utmSource: true, utmMedium: true, utmCampaign: true, utmTerm: true,
          utmContent: true, adClickId: true, landingPage: true, referrer: true,
          firstTouchAt: true,
        },
      },
    },
    take: page.take,
  });
  const { rows, nextCursor } = paged(found, page, (o) => o.createdAt);

  return json({ nextCursor, conversions: rows.map(conversionOut) });
});

/** `?stage=Paid&stage=Shipped`, or nothing at all for every stage. */
function stageFilter(req: Request) {
  const raw = new URL(req.url).searchParams.getAll("stage");
  const parsed = conversionStageQuery.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(422, "Unknown order stage", { stage: raw });
  }
  return parsed.data;
}

export const OPTIONS = route(preflight);
