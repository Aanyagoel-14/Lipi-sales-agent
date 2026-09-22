import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { prisma } from "@/server/lib/prisma";
import { resolveBlocks } from "@/server/sites/generate";
import { themeFor, themeStyle } from "@/server/sites/theme";
import type { SiteStructure } from "@/server/sites/structure";
import { SiteBlocks } from "../blocks";

/**
 * Every page of a generated site other than its home page.
 *
 * A catch-all rather than a route per goal, because which pages exist is
 * decided by the structure and the structure is data. `/book`, `/quote` and
 * `/catalogue` are the ones the generator currently produces; adding a fourth
 * is a change to `sites/structure.ts` and to nothing here.
 */

type Props = { params: Promise<{ slug: string; path: string[] }> };

const load = async (slug: string) =>
  prisma.generatedSite.findUnique({
    where: { slug },
    select: { id: true, workspaceId: true, slug: true, structure: true },
  });

const pageFor = (structure: SiteStructure, path: string[]) =>
  structure.pages.find((page) => page.path === `/${path.join("/")}`);

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug, path } = await params;
  const site = await load(slug);
  if (!site) return { title: "Not found" };

  const page = pageFor(site.structure as unknown as SiteStructure, path);
  if (!page) return { title: "Not found" };

  return {
    title: page.title,
    description: page.description,
    openGraph: { title: page.title, description: page.description, type: "website" },
  };
}

export default async function GeneratedSiteSubpage({ params }: Props) {
  const { slug, path } = await params;
  const site = await load(slug);
  if (!site) notFound();

  const structure = site.structure as unknown as SiteStructure;
  const page = pageFor(structure, path);
  if (!page) notFound();

  const blocks = await resolveBlocks(site.workspaceId, site.slug, page);
  const tokens = themeFor(structure.theme);

  return (
    <div
      style={themeStyle(tokens) as React.CSSProperties}
      className="min-h-screen bg-[var(--site-canvas)] text-[var(--site-ink)]"
    >
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
