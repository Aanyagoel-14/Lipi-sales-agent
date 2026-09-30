import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { prisma } from "@/server/lib/prisma";
import { resolveBlocks } from "@/server/sites/generate";
import { themeFor, themeStyle } from "@/server/sites/theme";
import type { SiteStructure } from "@/server/sites/structure";
import { SiteBlocks } from "./blocks";

/**
 * A generated site, served.
 *
 * This is the part of PRD §3 that makes the rest of it true. Without it a
 * "generated site" is a row of JSON an operator has to take on trust; with it
 * they can open the page, send somebody the link, and see the catalogue block
 * showing the stock they actually have.
 *
 * Phase 2 happens here, on every request: `resolveBlocks()` reads each block's
 * binding and fetches live twin rows for it. A site generated in March shows
 * September's prices in September, because the structure never held a price.
 */

type Props = { params: Promise<{ slug: string }> };

const load = async (slug: string) =>
  prisma.generatedSite.findUnique({
    where: { slug },
    select: { id: true, workspaceId: true, slug: true, name: true, structure: true, deployment: true },
  });

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const site = await load(slug);
  if (!site) return { title: "Not found" };

  const structure = site.structure as unknown as SiteStructure;
  const home = structure.pages[0]!;
  const domain = (site.deployment as { custom_domain?: string }).custom_domain;

  return {
    title: home.title,
    description: home.description,
    alternates: domain ? { canonical: `https://${domain}` } : undefined,
    openGraph: { title: home.title, description: home.description, type: "website" },
    robots: { index: true, follow: true },
  };
}

export default async function GeneratedSitePage({ params }: Props) {
  const { slug } = await params;
  const site = await load(slug);
  if (!site) notFound();

  const structure = site.structure as unknown as SiteStructure;
  const page = structure.pages[0]!;
  const blocks = await resolveBlocks(site.workspaceId, site.slug, page);
  const tokens = themeFor(structure.theme);

  return (
    <div
      style={themeStyle(tokens) as React.CSSProperties}
      className="min-h-screen bg-[var(--site-canvas)] text-[var(--site-ink)]"
    >
      {/* The semantic schema the generator produced (§3 Phase 1). Serialised
          with the closing-tag escape JSON-LD requires, because a business name
          containing "</script>" would otherwise end the block early. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(structure.schema).replace(/</g, "\\u003c"),
        }}
      />
      <SiteBlocks
        blocks={blocks}
        slug={site.slug}
        pages={structure.pages.map((p) => ({ path: p.path, title: p.title }))}
        assistant={structure.assistant}
        workspaceId={site.workspaceId}
      />
    </div>
  );
}
