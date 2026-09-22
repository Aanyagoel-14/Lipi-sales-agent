import { z } from "zod";
import { HttpError } from "../lib/http";
import { recordEvent } from "../lib/events";
import { prisma } from "../lib/prisma";
import { FormulaError, evaluateQuote, parseFormula, type FormulaScope } from "./formula";
import { hostingProvider, originUrlFor } from "./hosting";
import { buildStructure, type GenerateSiteInput, type SiteStructure } from "./structure";

/**
 * Generating, storing and quoting from a site (PRD §3).
 *
 * Three things live here because they are the three moments a site is not
 * just markup: it is generated from a profile, it is resolved against live
 * twin data when somebody looks at it, and it computes a price when somebody
 * asks for one.
 */

/* ------------------------------------------------------------ generating */

/** A URL segment from a business name. Public, so it has to be predictable. */
export function slugFor(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return base || "site";
}

export async function generateSite(workspaceId: string, input: GenerateSiteInput) {
  // Parsed here rather than at render time, so a malformed formula is a 422 on
  // the operator's own request and never a 500 on a visitor's.
  let structure: SiteStructure;
  try {
    structure = buildStructure(input);
  } catch (error) {
    if (error instanceof FormulaError) {
      throw new HttpError(422, `The quote formula is not valid: ${error.message}`, {
        custom_quote_formula: [error.message],
        position: error.position,
      });
    }
    throw error;
  }

  // A goal that promises something the site cannot do is refused rather than
  // generated into a page with a dead form on it.
  if (input.business_profile.primary_goals.includes("CUSTOM_QUOTE_CALCULATION") && !structure.quote) {
    throw new HttpError(422, "CUSTOM_QUOTE_CALCULATION needs site_features.custom_quote_formula", {
      custom_quote_formula: ["required when CUSTOM_QUOTE_CALCULATION is a primary goal"],
    });
  }

  const slug = await uniqueSlug(slugFor(input.business_profile.name), workspaceId);

  const site = await prisma.generatedSite.create({
    data: {
      workspaceId,
      slug,
      name: input.business_profile.name,
      profile: input.business_profile,
      features: input.site_features,
      deployment: input.deployment_target,
      structure: structure as unknown as object,
      quoteFormula: structure.quote?.formula ?? null,
    },
  });

  await recordEvent(
    workspaceId,
    "site.generated",
    "site",
    `${site.id} slug=${slug} pages=${structure.pages.length} goals=[${input.business_profile.primary_goals.join(", ")}]`,
  );

  return { site, structure };
}

/**
 * A slug nobody else holds.
 *
 * The column is globally unique because the slug is a public URL segment, so
 * two tenants cannot both own `apex-detailing`. A collision appends a counter
 * rather than failing: the operator asked for a site, not for a naming
 * argument.
 */
async function uniqueSlug(base: string, workspaceId: string): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const taken = await prisma.generatedSite.findUnique({ where: { slug: candidate }, select: { workspaceId: true } });
    if (!taken) return candidate;
  }
  // Fifty businesses with the same name is not a naming problem any more.
  return `${base}-${workspaceId.slice(-6)}`;
}

/* ------------------------------------------------------------- deploying */

export async function deploySite(workspaceId: string, siteId: string) {
  const site = await prisma.generatedSite.findFirst({ where: { id: siteId, workspaceId } });
  if (!site) throw new HttpError(404, "Site not found");

  const deployment = site.deployment as { custom_domain?: string; auto_provision_ssl?: boolean };
  const originUrl = originUrlFor(site.slug);

  const outcome = await hostingProvider().deploy({
    slug: site.slug,
    originUrl,
    customDomain: deployment.custom_domain,
    autoProvisionSsl: deployment.auto_provision_ssl ?? true,
  });

  const updated = await prisma.generatedSite.update({
    where: { id: site.id },
    data: {
      status: outcome.ok ? "deployed" : "failed",
      liveUrl: outcome.ok ? outcome.url : null,
    },
  });

  await recordEvent(
    workspaceId,
    outcome.ok ? "site.deployed" : "site.deploy_failed",
    "site",
    outcome.ok
      ? `${site.id} provider=${outcome.provider} url=${outcome.url} ssl=${outcome.sslProvisioned}`
      : `${site.id} provider=${outcome.provider} reason="${outcome.reason}"`,
  );

  return { site: updated, outcome, originUrl };
}

/* --------------------------------------------------------------- quoting */

export const quoteRequestSchema = z.object({
  /** Whatever the formula's variables are called. Numbers and yes/nos only. */
  variables: z.record(z.string(), z.union([z.number(), z.boolean()])),
});

/**
 * A price from a site's own formula.
 *
 * Deterministic, computed here, handed to whoever asked. The model is not
 * involved — this is the same rule that keeps `sell()` from inventing a total
 * (invariant 2), applied to the one number a generated site quotes.
 */
export async function quoteFromSite(slug: string, variables: FormulaScope) {
  const site = await prisma.generatedSite.findUnique({
    where: { slug },
    select: { id: true, workspaceId: true, quoteFormula: true },
  });
  if (!site) throw new HttpError(404, "Site not found");
  if (!site.quoteFormula) throw new HttpError(409, "This site has no quote calculator");

  try {
    const tree = parseFormula(site.quoteFormula);
    const amount = evaluateQuote(tree, variables);
    return { amountMinorUnits: amount, siteId: site.id, workspaceId: site.workspaceId };
  } catch (error) {
    if (error instanceof FormulaError) {
      // The visitor's fault, not the server's: a missing or unusable value.
      throw new HttpError(422, error.message);
    }
    throw error;
  }
}

/* ------------------------------------------------------------- resolving */

export type ResolvedBlock = {
  id: string;
  type: string;
  heading: string;
  body: string;
  /** Live data for this block, resolved at request time. Never stored. */
  data: Record<string, unknown>;
};

/**
 * Phase 2, at the moment it matters: a block's binding resolved against live
 * rows.
 *
 * This is why the structure holds no business data. A catalogue block named
 * the catalogue at generation; here it gets the products the workspace stocks
 * *now*, with the stock it has *now*. A site generated in March cannot quote
 * March's prices in September.
 */
export async function resolveBlocks(
  workspaceId: string,
  slug: string,
  page: SiteStructure["pages"][number],
): Promise<ResolvedBlock[]> {
  const resolved: ResolvedBlock[] = [];

  for (const block of page.blocks) {
    const base = { id: block.id, type: block.type, heading: block.heading, body: block.body };

    switch (block.binding.source) {
      case "catalogue": {
        const products = await prisma.product.findMany({
          where: { workspaceId },
          orderBy: { name: "asc" },
          take: block.binding.limit,
          select: {
            id: true, name: true, category: true, price: true, leadTimeDays: true,
            variants: { select: { optionA: true, optionB: true, stock: true, reserved: true } },
          },
        });

        resolved.push({
          ...base,
          data: {
            products: products.map((product) => ({
              id: product.id,
              name: product.name,
              category: product.category,
              priceMinorUnits: product.price,
              leadTimeDays: product.leadTimeDays,
              available: product.variants.reduce((sum, v) => sum + (v.stock - v.reserved), 0),
            })),
          },
        });
        break;
      }

      case "quote":
        resolved.push({
          ...base,
          // The variables, not the formula: a visitor's browser has no
          // business holding the business's pricing maths, and the price is
          // computed on the server anyway.
          data: {
            variables: block.binding.variables,
            quoteEndpoint: `/v1/builder/sites/${encodeURIComponent(slug)}/quote`,
          },
        });
        break;

      case "reviews":
        // No reviews connector exists. An empty list and a reason, rather than
        // invented testimonials — see docs/impl/BLOCKERS.md B-006.
        resolved.push({ ...base, data: { reviews: [], unavailable: "No reviews source is connected" } });
        break;

      case "booking":
      case "contact":
      case "static":
        resolved.push({ ...base, data: {} });
        break;
    }
  }

  return resolved;
}
