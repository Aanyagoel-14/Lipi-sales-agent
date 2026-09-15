import { json, route } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { catalogueFor } from "@/server/services/catalogues";

/** Axis names and suggested options for the workspace's trade, to prefill the form. */
export const GET = route(async () => {
  const workspaceId = await resolveWorkspaceId();
  const workspace = await prisma.workspace.findUniqueOrThrow({
    where: { id: workspaceId },
    select: { vertical: true },
  });

  const catalogue = catalogueFor(workspace.vertical);
  const sample = catalogue.products[0]!;

  return json({
    vertical: workspace.vertical,
    axes: sample.axes,
    suggestedOptionsA: [...new Set(catalogue.products.flatMap((p) => p.optionsA))],
    suggestedOptionsB: [...new Set(catalogue.products.flatMap((p) => p.optionsB))],
    categories: [...new Set(catalogue.products.map((p) => p.category))],
    attributeKeys: Object.keys(sample.attributes),
  });
});
