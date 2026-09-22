import { HttpError, json, route } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { originUrlFor } from "@/server/sites/hosting";

/** `GET /v1/builder/sites/{slug}` — one site, with the structure it generated. */
export const GET = route<{ slug: string }>(async (_req, { slug }) => {
  const workspaceId = await resolveWorkspaceId();
  const site = await prisma.generatedSite.findFirst({ where: { slug, workspaceId } });
  if (!site) throw new HttpError(404, "Site not found");

  return json({
    site: {
      id: site.id,
      slug: site.slug,
      name: site.name,
      status: site.status,
      url: originUrlFor(site.slug),
      liveUrl: site.liveUrl,
      profile: site.profile,
      features: site.features,
      deployment: site.deployment,
      structure: site.structure,
      createdIso: site.createdAt.toISOString(),
    },
  });
});
