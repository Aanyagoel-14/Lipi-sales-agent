import { body, json, route } from "@/server/lib/http";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { generateSite } from "@/server/sites/generate";
import { originUrlFor } from "@/server/sites/hosting";
import { generateSiteSchema } from "@/server/sites/structure";

/**
 * `POST /v1/builder/sites/generate` — PRD §3.1.
 *
 * The request body is the one the PRD prints, verbatim. The response reports
 * where the site is actually served, which is this deployment's own origin
 * under `/s/{slug}` — a real page rendering real twin data — and separately
 * whether an edge host has been asked for it. Those are different facts and
 * conflating them is how an operator ends up sending a customer a link that
 * does not exist.
 */
export const POST = route(async (req) => {
  const workspaceId = await resolveWorkspaceId();
  const input = await body(req, generateSiteSchema, "Invalid site generation request");

  const { site, structure } = await generateSite(workspaceId, input);

  return json(
    {
      site: {
        id: site.id,
        slug: site.slug,
        name: site.name,
        status: site.status,
        /** Live now, on this deployment. Not a promise about a CDN. */
        url: originUrlFor(site.slug),
        liveUrl: site.liveUrl,
        createdIso: site.createdAt.toISOString(),
      },
      structure: {
        pages: structure.pages.map((page) => ({
          path: page.path,
          title: page.title,
          description: page.description,
          blocks: page.blocks.map((block) => ({ id: block.id, type: block.type, binding: block.binding.source })),
        })),
        sitemap: structure.sitemap,
        schema: structure.schema,
        theme: structure.theme,
        quote: structure.quote,
        assistant: structure.assistant,
      },
    },
    201,
  );
});
