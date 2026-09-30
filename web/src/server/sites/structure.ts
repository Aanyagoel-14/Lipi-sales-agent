import { z } from "zod";
import { parseFormula, variablesIn } from "./formula";

/**
 * Phase 1 of the website generator: intent → structure (PRD §3).
 *
 * "The LLM generates responsive Tailwind/React components, semantic schema,
 * and sitemaps." What is generated here is *structure*, deterministically:
 * which pages exist, which blocks are on them, what each block binds to, what
 * the schema.org document says, what the sitemap lists.
 *
 * A model is not asked to do it, and the reason is the same one that governs
 * the rest of this codebase. A structure is a set of facts about a business —
 * this shop takes bookings, that one publishes a catalogue and a quote
 * calculator — and a model asked to invent one will eventually invent a
 * booking page for a business that cannot take bookings. Copy is a different
 * question: the headline on a hero block is words, and words are exactly what
 * a model should write. So the generator produces the structure and the
 * *slots*; anything model-written goes into a slot and can be regenerated
 * without moving a page.
 *
 * Phase 2 is the `binding` on each block: a block does not carry data, it
 * names which twin supplies it. `src/app/s/[slug]` resolves those bindings at
 * request time against live rows, so a price on a generated site is the price
 * in the catalogue and not a number frozen at generation.
 */

/* ------------------------------------------------------------- the ask */

export const PRIMARY_GOALS = [
  "ONLINE_BOOKING",
  "CUSTOM_QUOTE_CALCULATION",
  "PHONE_CAPTURE",
  "LEAD_CAPTURE",
  "PRODUCT_CATALOG",
  "CONTENT_MARKETING",
] as const;

export type PrimaryGoal = (typeof PRIMARY_GOALS)[number];

export const THEME_MODES = ["DARK_SLATE_PREMIUM", "LIGHT_MINIMAL", "HIGH_CONTRAST"] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

/** The PRD's request body, §3.1, as a schema. */
export const generateSiteSchema = z.object({
  business_profile: z.object({
    name: z.string().min(1).max(120),
    industry: z.string().min(1).max(120),
    target_geo: z.string().min(1).max(120).optional(),
    primary_goals: z.array(z.enum(PRIMARY_GOALS)).min(1).max(PRIMARY_GOALS.length),
  }),
  site_features: z
    .object({
      embed_ai_voice_widget: z.boolean().default(false),
      embed_digital_twin_catalog: z.boolean().default(false),
      theme_mode: z.enum(THEME_MODES).default("DARK_SLATE_PREMIUM"),
      /**
       * The quote expression. Parsed here, at the door, so a malformed one is
       * a 422 on the operator's own request rather than a 500 on a visitor's.
       */
      custom_quote_formula: z.string().max(2_000).optional(),
    })
    .prefault({}),
  deployment_target: z
    .object({
      custom_domain: z.string().max(253).optional(),
      auto_provision_ssl: z.boolean().default(true),
    })
    .prefault({}),
});

export type GenerateSiteInput = z.infer<typeof generateSiteSchema>;

/* -------------------------------------------------------- the structure */

/**
 * What a block binds to, which is the whole of Phase 2.
 *
 * A block never carries data. `catalogue` means "the products this workspace
 * actually stocks", `quote` means "this site's formula, evaluated against what
 * the visitor typed", `reviews` means "whatever the reviews connector has".
 * The renderer resolves them at request time, so a generated site cannot show
 * a price that was true at generation and is not true now.
 */
export type BlockBinding =
  | { source: "static" }
  | { source: "catalogue"; limit: number }
  | { source: "quote"; variables: string[] }
  | { source: "booking" }
  | { source: "reviews"; limit: number }
  | { source: "contact"; fields: ("name" | "email" | "phone")[] };

export type Block = {
  id: string;
  type:
    | "hero" | "features" | "catalogue" | "quote_calculator" | "booking"
    | "reviews" | "contact_form" | "phone_cta" | "faq" | "footer" | "assistant";
  heading: string;
  /** A slot for model-written copy. Empty until somebody fills it. */
  body: string;
  binding: BlockBinding;
};

export type Page = {
  path: string;
  title: string;
  description: string;
  blocks: Block[];
};

export type SiteStructure = {
  pages: Page[];
  /** schema.org JSON-LD for the business. */
  schema: Record<string, unknown>;
  sitemap: { path: string; changefreq: string; priority: number }[];
  theme: ThemeMode;
  /** Parsed once at generation; the renderer re-parses from the stored source. */
  quote: { formula: string; variables: string[] } | null;
  assistant: { embedded: boolean; channel: "webchat" };
};

const block = (id: string, type: Block["type"], heading: string, binding: BlockBinding = { source: "static" }): Block =>
  ({ id, type, heading, body: "", binding });

/**
 * Which blocks a goal requires.
 *
 * A goal is a promise the site makes to a visitor, so each one has to bring
 * the thing that keeps it. `ONLINE_BOOKING` without a booking block is a
 * business claiming to take bookings and not taking them.
 */
const GOAL_BLOCKS: Record<PrimaryGoal, (input: GenerateSiteInput) => Block[]> = {
  ONLINE_BOOKING: () => [block("booking", "booking", "Book an appointment", { source: "booking" })],
  CUSTOM_QUOTE_CALCULATION: (input) => {
    const formula = input.site_features.custom_quote_formula;
    // No formula, no calculator. A quote form with nothing behind it is the
    // exact fake the master prompt forbids.
    if (!formula) return [];
    return [
      block("quote", "quote_calculator", "Get an instant quote", {
        source: "quote",
        variables: variablesIn(parseFormula(formula)),
      }),
    ];
  },
  PHONE_CAPTURE: () => [block("phone", "phone_cta", "Call us", { source: "contact", fields: ["name", "phone"] })],
  LEAD_CAPTURE: () => [
    block("contact", "contact_form", "Get in touch", { source: "contact", fields: ["name", "email", "phone"] }),
  ],
  PRODUCT_CATALOG: () => [block("catalogue", "catalogue", "What we sell", { source: "catalogue", limit: 12 })],
  CONTENT_MARKETING: () => [block("faq", "faq", "Common questions")],
};

/** Goals that deserve a page of their own rather than a section. */
const GOAL_PAGES: Partial<Record<PrimaryGoal, { path: string; title: (input: GenerateSiteInput) => string }>> = {
  ONLINE_BOOKING: { path: "/book", title: (input) => `Book with ${input.business_profile.name}` },
  CUSTOM_QUOTE_CALCULATION: { path: "/quote", title: (input) => `Get a quote from ${input.business_profile.name}` },
  PRODUCT_CATALOG: { path: "/catalogue", title: (input) => `${input.business_profile.name} — catalogue` },
};

/**
 * The structure for a business profile.
 *
 * Deterministic: the same profile produces the same structure, which is what
 * makes a regenerate safe and a test meaningful.
 */
export function buildStructure(input: GenerateSiteInput): SiteStructure {
  const { business_profile: profile, site_features: features } = input;
  const goals = [...new Set(profile.primary_goals)];
  const where = profile.target_geo ? ` in ${profile.target_geo}` : "";

  const home: Page = {
    path: "/",
    title: `${profile.name} — ${profile.industry}${where}`,
    description: `${profile.industry}${where}. ${goalSentence(goals)}`,
    blocks: [
      block("hero", "hero", profile.name),
      block("features", "features", `Why ${profile.name}`),
      // Every goal's block also appears on the home page, in the order the
      // operator listed them: the order they were asked for is the order they
      // matter in, and a visitor who never leaves the home page should still
      // be able to do the thing the business most wants them to do.
      ...goals.flatMap((goal) => GOAL_BLOCKS[goal](input)),
      ...(features.embed_digital_twin_catalog && !goals.includes("PRODUCT_CATALOG")
        ? [block("catalogue", "catalogue", "What we sell", { source: "catalogue", limit: 6 })]
        : []),
      ...(features.embed_ai_voice_widget ? [block("assistant", "assistant", "Ask us anything")] : []),
      block("footer", "footer", profile.name),
    ],
  };

  const pages: Page[] = [home];
  for (const goal of goals) {
    const spec = GOAL_PAGES[goal];
    if (!spec) continue;
    const blocks = GOAL_BLOCKS[goal](input);
    if (!blocks.length) continue;
    pages.push({
      path: spec.path,
      title: spec.title(input),
      description: home.description,
      blocks: [...blocks, block("footer", "footer", profile.name)],
    });
  }

  const formula = features.custom_quote_formula;

  return {
    pages,
    schema: schemaFor(input),
    sitemap: pages.map((page) => ({
      path: page.path,
      changefreq: page.path === "/" ? "weekly" : "monthly",
      priority: page.path === "/" ? 1 : 0.7,
    })),
    theme: features.theme_mode,
    quote: formula ? { formula, variables: variablesIn(parseFormula(formula)) } : null,
    assistant: { embedded: features.embed_ai_voice_widget, channel: "webchat" },
  };
}

const GOAL_SENTENCE: Record<PrimaryGoal, string> = {
  ONLINE_BOOKING: "Book online",
  CUSTOM_QUOTE_CALCULATION: "Get an instant quote",
  PHONE_CAPTURE: "Call us",
  LEAD_CAPTURE: "Get in touch",
  PRODUCT_CATALOG: "Browse the catalogue",
  CONTENT_MARKETING: "Read our guides",
};

const goalSentence = (goals: PrimaryGoal[]) => `${goals.map((goal) => GOAL_SENTENCE[goal]).join(". ")}.`;

/**
 * schema.org JSON-LD.
 *
 * `LocalBusiness` rather than `Organization` whenever a geography was given,
 * because that is what a search engine needs to put a business on a map, and
 * `target_geo` is the field the PRD supplies for exactly that.
 */
function schemaFor(input: GenerateSiteInput): Record<string, unknown> {
  const profile = input.business_profile;
  const document: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": profile.target_geo ? "LocalBusiness" : "Organization",
    name: profile.name,
    description: `${profile.industry}${profile.target_geo ? ` in ${profile.target_geo}` : ""}`,
  };

  if (profile.target_geo) {
    document.address = { "@type": "PostalAddress", addressLocality: profile.target_geo };
  }
  if (input.deployment_target.custom_domain) {
    document.url = `https://${input.deployment_target.custom_domain}`;
  }
  if (profile.primary_goals.includes("ONLINE_BOOKING")) {
    document.potentialAction = {
      "@type": "ReserveAction",
      target: `${input.deployment_target.custom_domain ? `https://${input.deployment_target.custom_domain}` : ""}/book`,
    };
  }

  return document;
}

/** `sitemap.xml`, from the structure. */
export function sitemapXml(structure: SiteStructure, origin: string): string {
  const urls = structure.sitemap
    .map(
      (entry) =>
        `  <url><loc>${origin.replace(/\/$/, "")}${entry.path}</loc>` +
        `<changefreq>${entry.changefreq}</changefreq>` +
        `<priority>${entry.priority}</priority></url>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}
