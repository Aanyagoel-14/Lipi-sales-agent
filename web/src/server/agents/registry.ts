import { calendarNegotiation } from "./skills/calendar-negotiation";
import { discountCalculator } from "./skills/discount-calculator";
import { inventoryLookup } from "./skills/inventory-lookup";
import { leadScoring } from "./skills/lead-scoring";
import { stripeInvoice } from "./skills/stripe-invoice";
import type { SkillSpec } from "./types";

/**
 * Every skill this deployment can run.
 *
 * One array, the way `server/channels/registry.ts` holds one array of channel
 * specs. Adding a skill is a file and a line here; it is never a branch in an
 * agent, and nothing downstream — the executor, the builder, the deploy
 * endpoint, the SDK — knows any skill by name.
 *
 * The five the PRD names in §2 Step 01. `50+ modular skills` is the product
 * ambition; five is what is implemented, each of them genuinely executing
 * against the twins rather than describing itself. A registry with five real
 * entries is worth more than fifty that return plausible objects, and the
 * shape is what makes the fiftieth cheap.
 */
export const skillSpecs: SkillSpec<never>[] = [
  inventoryLookup,
  discountCalculator,
  stripeInvoice,
  leadScoring,
  calendarNegotiation,
] as unknown as SkillSpec<never>[];

const bySlug = new Map(skillSpecs.map((spec) => [spec.slug.toLowerCase(), spec]));

/**
 * Skills registered at runtime by `@lipi-ai/sdk-node`.
 *
 * Kept apart from `skillSpecs` so "what ships with the product" and "what this
 * deployment's own code added" stay distinguishable — the catalogue below
 * marks them, and a built-in slug cannot be shadowed by a custom one.
 *
 * Registration is a server-side call, never a request: a tenant cannot add a
 * skill by posting one, and there is no path from an HTTP body to this map.
 */
const registered = new Map<string, SkillSpec<never>>();

export function registerSkill(spec: SkillSpec<never> | SkillSpec<Record<string, unknown>>) {
  const key = spec.slug.trim().toLowerCase();
  if (bySlug.has(key)) {
    throw new Error(`"${spec.slug}" is a built-in skill and cannot be redefined`);
  }
  registered.set(key, spec as SkillSpec<never>);
}

export function unregisterSkill(slug: string) {
  registered.delete(slug.trim().toLowerCase());
}


/**
 * The product specification names these skills twice and does not agree with
 * itself.
 *
 * §2 Step 01 lists them as `Inventory_Lookup`, `Discount_Calculator`,
 * `Stripe_Invoice`, `Lead_Scoring`, `Calendar_Negotiation`. §8.1's deploy
 * contract — the body an integrator will copy, because it is the one printed
 * as a request — uses `SKILL_INVENTORY_LOOKUP`, `SKILL_DISCOUNT_NEGOTIATOR`
 * and `SKILL_STRIPE_CHECKOUT`.
 *
 * Both are accepted. Picking one and refusing the other would mean an
 * integrator who copied the specification's own example got
 * "Unknown skill" back, which is a needlessly unhelpful way to be right.
 * The canonical spelling is the spec's and is what gets stored and reported,
 * so the alias never leaks past this lookup.
 */
const SPEC_ALIASES: Record<string, string> = {
  skill_inventory_lookup: "inventory_lookup",
  skill_discount_negotiator: "discount_calculator",
  skill_discount_calculator: "discount_calculator",
  skill_stripe_checkout: "stripe_invoice",
  skill_stripe_invoice: "stripe_invoice",
  skill_lead_scoring: "lead_scoring",
  skill_calendar_negotiation: "calendar_negotiation",
};

/**
 * The spec for a slug, or undefined.
 *
 * Case-insensitive because the slug travels through a language model, a JSON
 * body and an operator's form field before it gets here, and `inventory_lookup`
 * meaning nothing while `Inventory_Lookup` works is a difference no caller can
 * see the reason for. The stored and reported spelling is always the spec's.
 */
export const skillFor = (slug: string): SkillSpec<never> | undefined => {
  const raw = slug.trim().toLowerCase();
  const key = SPEC_ALIASES[raw] ?? raw;
  return bySlug.get(key) ?? registered.get(key);
};

/** Whether every named skill exists. Used by deploy to refuse early. */
export function unknownSkills(slugs: string[]): string[] {
  return slugs.filter((slug) => !skillFor(slug));
}

/**
 * What a caller's spelling is actually called.
 *
 * Deploy stores this rather than what arrived, so an agent built from the
 * specification's §8.1 example and one built from its §2 list hold the same
 * rows — and the allowed-tool check at execution time compares like with like
 * however each of them was written.
 */
export const canonicalSkill = (slug: string): string => skillFor(slug)?.slug ?? slug;

/** What the builder renders a catalogue from. No `run`, no schemas — data. */
export const skillCatalogue = () =>
  [...skillSpecs, ...registered.values()].map((spec) => ({
    slug: spec.slug,
    label: spec.label,
    description: spec.description,
    category: spec.category,
    touchesMoney: spec.touchesMoney,
    /** False for anything this deployment's own code registered at runtime. */
    builtIn: bySlug.has(spec.slug.toLowerCase()),
  }));
