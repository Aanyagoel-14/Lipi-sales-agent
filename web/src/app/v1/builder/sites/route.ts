import { json, route } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { originUrlFor } from "@/server/sites/hosting";

/** `GET /v1/builder/sites` — the sites this workspace has generated. */
export const GET = route(async () => {
  const workspaceId = await resolveWorkspaceId();
  const sites = await prisma.generatedSite.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
    select: { id: true, slug: true, name: true, status: true, liveUrl: true, createdAt: true },
  });

  return json({
    sites: sites.map((site) => ({
      id: site.id,
      slug: site.slug,
      name: site.name,
      status: site.status,
      url: originUrlFor(site.slug),
      liveUrl: site.liveUrl,
      createdIso: site.createdAt.toISOString(),
    })),
  });
});
