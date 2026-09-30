import { z } from "zod";
import type { SkillSpec } from "../types";

/**
 * `Inventory_Lookup` (PRD §2 Step 01).
 *
 * What is on the shelf, as a number a reply may quote. The figure is read
 * from the variant rows and nothing else computes it — this is the skill
 * form of the check `ingest()` has always made inline, and the reason it is
 * a skill now is that an agent assembled in the builder needs to be able to
 * hold it without holding the whole commerce loop.
 *
 * `available` is stock minus what is already reserved for somebody else,
 * because stock alone is a number that will be wrong the moment two
 * customers ask at once.
 */
export const inventoryLookup: SkillSpec<{ product: string; optionA?: string; optionB?: string }> = {
  slug: "Inventory_Lookup",
  label: "Inventory lookup",
  description: "Reads live stock for a product, or for one specific variant of it.",
  category: "inventory",
  touchesMoney: false,
  parameters: z.object({
    /** A product name or a SKU. */
    product: z.string().min(1),
    /** The first variant axis — Size for apparel, Fitment for parts. */
    optionA: z.string().min(1).optional(),
    /** The second — Colour, Grade. */
    optionB: z.string().min(1).optional(),
  }),

  async run(args, ctx) {
    const product = await ctx.twinStore.findProduct(args.product);
    if (!product) {
      return {
        summary: `Looked for "${args.product}" and found nothing in the catalogue`,
        data: { found: false, product: args.product },
      };
    }

    const matches = product.variants.filter(
      (v) =>
        (!args.optionA || v.optionA.toLowerCase() === args.optionA.toLowerCase()) &&
        (!args.optionB || v.optionB.toLowerCase() === args.optionB.toLowerCase()),
    );

    // A named variant that does not exist is a different answer from one that
    // exists and is empty, and a customer is owed the difference.
    if (!matches.length) {
      const asked = [args.optionA, args.optionB].filter(Boolean).join(" / ");
      ctx.record("inventory_twin.checked", "inventory", `product=${product.id} variant="${asked}" result=no_such_variant`);
      return {
        summary: `${product.name} has no ${asked} variant`,
        data: { found: true, product: product.name, variantExists: false, variants: [] },
      };
    }

    const variants = matches.map((v) => ({
      sku: v.sku,
      optionA: v.optionA,
      optionB: v.optionB,
      stock: v.stock,
      reserved: v.reserved,
      available: v.stock - v.reserved,
    }));
    const available = variants.reduce((sum, v) => sum + v.available, 0);

    ctx.record(
      "inventory_twin.checked",
      "inventory",
      `product=${product.id} variants=${variants.length} available=${available}`,
    );

    return {
      summary:
        matches.length === 1
          ? `Checked ${variants[0]!.sku}: ${available} available`
          : `Checked ${product.name}: ${available} available across ${variants.length} variants`,
      data: {
        found: true,
        variantExists: true,
        product: product.name,
        priceMinorUnits: product.price,
        leadTimeDays: product.leadTimeDays,
        available,
        variants,
      },
    };
  },
};
