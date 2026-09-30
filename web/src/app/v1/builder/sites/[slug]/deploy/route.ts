import { HttpError, json, route } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { deploySite } from "@/server/sites/generate";

/**
 * `POST /v1/builder/sites/{slug}/deploy` — PRD §3 Phase 3.
 *
 * Answers **200 whether or not an edge host took it**, because the useful
 * distinction is not success versus failure: the site is served either way, at
 * `url`. What a provider adds is a CDN, a custom domain and a certificate, and
 * `edge.ok` says whether it did. Reporting a 500 when no provider is
 * configured would say the deployment failed, and it did not — nobody was
 * asked.
 */
export const POST = route<{ slug: string }>(async (_req, { slug }) => {
  const workspaceId = await resolveWorkspaceId();
  const existing = await prisma.generatedSite.findFirst({
    where: { slug, workspaceId },
    select: { id: true },
  });
  if (!existing) throw new HttpError(404, "Site not found");

  const { site, outcome, originUrl } = await deploySite(workspaceId, existing.id);

  return json({
    site: { id: site.id, slug: site.slug, status: site.status, url: originUrl, liveUrl: site.liveUrl },
    edge: outcome.ok
      ? { ok: true, provider: outcome.provider, url: outcome.url, sslProvisioned: outcome.sslProvisioned }
      : { ok: false, provider: outcome.provider, reason: outcome.reason },
  });
});
