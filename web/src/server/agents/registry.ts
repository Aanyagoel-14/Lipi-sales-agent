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

/** Every custom skill this process currently holds. */
export const registeredSkills = () => [...registered.values()];

/**
 * The spec for a slug, or undefined.
 *
 * Case-insensitive because the slug travels through a language model, a JSON
 * body and an operator's form field before it gets here, and `inventory_lookup`
 * meaning nothing while `Inventory_Lookup` works is a difference no caller can
 * see the reason for. The stored and reported spelling is always the spec's.
 */
export const skillFor = (slug: string): SkillSpec<never> | undefined => {
  const key = slug.trim().toLowerCase();
  return bySlug.get(key) ?? registered.get(key);
};

/** Whether every named skill exists. Used by deploy to refuse early. */
export function unknownSkills(slugs: string[]): string[] {
  return slugs.filter((slug) => !skillFor(slug));
}

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
