import { toRupees } from "../lib/money";
import { prisma } from "../lib/prisma";
import type { Focus } from "./briefing";
import type { Prisma } from "@/generated/prisma/client";

/**
 * What to put in front of the customer next.
 *
 * Generated here, in code, from stock and this workspace's own order history,
 * and handed to `sell()` as facts. The model chooses the words; it never
 * chooses the product, and it never sees a price or a count it did not get
 * from a row (invariant 2). Three moves, in the order a shopkeeper makes them:
 *
 *   alternative  what they asked for is sold out, so here is what is not
 *   cross-sell   what other customers here bought alongside it
 *   upsell       the next price tier up in the same category
 *
 * Nothing with zero available stock is ever a candidate: an alternative that
 * cannot be bought either is worse than admitting the shelf is empty.
 */

const CAPS = {
  /** In-stock variants and category neighbours offered against a sold-out match. */
  alternatives: 3,
  /** Companion products named per turn. */
  crossSell: 2,
  /**
   * Orders of the matched product read to find who bought it, and their other
   * orders read to count what they bought alongside it. Both bounded: a
   * co-occurrence count that scans the whole order table gets slower with
   * every sale the business makes, on every single inbound message.
   */
  anchorOrders: 200,
  companionOrders: 500,
  /** Products above the matched price considered for the step up. */
  upsellScan: 5,
};

/** No margin, no supplier: a recommendation is made of what a customer can see. */
const recommendSelect = {
  id: true, name: true, category: true, price: true,
  variants: {
    select: { optionA: true, optionB: true, stock: true, reserved: true },
    orderBy: [{ optionA: "asc" }, { optionB: "asc" }],
  },
} satisfies Prisma.ProductSelect;

type RecommendProduct = Prisma.ProductGetPayload<{ select: typeof recommendSelect }>;

export type Recommendation = {
  kind: "alternative" | "cross_sell" | "upsell";
  product: string;
  /** The specific variant being offered, where one variant is the offer. */
  variant: string | null;
  priceInr: number;
  available: number;
  /**
   * Why this is being offered, as the briefing states it. A label for a
   * deterministic choice, not a claim about money -- every number in the line
   * it ends up in comes from the fields above.
   */
  why: string;
};

export type Recommendations = {
  /**
   * The matched variant, when the customer cannot have it. Present with no
   * `alternative` in `items` means the honest answer is "there is nothing" --
   * the block says so, and the model is told to say so plainly.
   */
  soldOut: { product: string; variant: string } | null;
  items: Recommendation[];
};

/** A fresh empty result each time, so no caller can edit another's. */
const nothing = (): Recommendations => ({ soldOut: null, items: [] });

const available = (v: { stock: number; reserved: number }) => v.stock - v.reserved;
const totalAvailable = (product: RecommendProduct) =>
  product.variants.reduce((a, v) => a + Math.max(available(v), 0), 0);

const label = (v: { optionA: string; optionB: string }) => `${v.optionA} / ${v.optionB}`;

/** A to Z, so two candidates that tie break the same way on every call. */
function compare(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

type VariantRow = RecommendProduct["variants"][number];

/** How much a variant has in common with the one the customer asked for. */
const nearness = (v: VariantRow, near?: VariantRow) =>
  near ? Number(v.optionA === near.optionA) + Number(v.optionB === near.optionB) : 0;

/**
 * The in-stock variants of a product: nearest to what they asked for first,
 * then deepest stock. A customer told their size is gone wants the same
 * colour in another size before they want a different colour entirely, and
 * among equals the one with most left is the one least likely to go while
 * they are deciding.
 */
function inStockVariants(product: RecommendProduct, near?: VariantRow) {
  return product.variants
    .filter((v) => available(v) > 0)
    .sort(
      (a, b) =>
        nearness(b, near) - nearness(a, near) ||
        available(b) - available(a) ||
        compare(label(a), label(b)),
    );
}

/** The one variant to name when a whole product is the offer, if it has one. */
const bestVariant = (product: RecommendProduct) => {
  const best = inStockVariants(product)[0];
  return best ? label(best) : null;
};

export async function buildRecommendations(workspaceId: string, focus: Focus): Promise<Recommendations> {
  if (!focus.matched) return nothing();

  const matched = await prisma.product.findFirst({
    where: { workspaceId, name: focus.matched.product },
    select: recommendSelect,
  });
  if (!matched) return nothing();

  const wanted = matched.variants.find((v) => label(v) === focus.matched!.variant);
  const gone = wanted && available(wanted) <= 0 ? wanted : null;

  const [alternatives, companions, step] = await Promise.all([
    gone ? alternativesTo(workspaceId, matched, gone) : [],
    crossSellFor(workspaceId, matched),
    upsellFrom(workspaceId, matched),
  ]);

  // One product, one heading. A sold-out match can make a neighbour both the
  // nearest thing in stock and the next tier up, and offering it twice reads
  // as two products, so the strongest reason for putting it in front of them
  // wins. Several *variants* of one product are still several offers: "your
  // size is gone, but M and L are here" is one sentence a shopkeeper says.
  const items: Recommendation[] = [...alternatives];
  const offered = new Set(alternatives.map((a) => a.product));
  for (const item of [...companions, ...step]) {
    if (offered.has(item.product)) continue;
    offered.add(item.product);
    items.push(item);
  }

  return { soldOut: gone ? { product: matched.name, variant: label(gone) } : null, items };
}

/**
 * What this workspace's own customers bought alongside the matched product: a
 * co-occurrence count over `Order`, scoped to the tenant at both hops
 * (invariant 5) and bounded at both, so the cost of a recommendation does not
 * grow with every sale the business has ever made.
 *
 * The count itself never reaches the block. How many other people bought a
 * belt with their polo is the business's information, not the shopper's --
 * what they get is the belt.
 */
async function crossSellFor(workspaceId: string, matched: RecommendProduct): Promise<Recommendation[]> {
  const anchors = await prisma.order.findMany({
    where: { workspaceId, productId: matched.id },
    select: { customerId: true },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take: CAPS.anchorOrders,
  });

  const customerIds = [...new Set(anchors.map((a) => a.customerId))];
  if (!customerIds.length) return [];

  const alongside = await prisma.order.findMany({
    where: { workspaceId, customerId: { in: customerIds }, productId: { not: matched.id } },
    select: { productId: true },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take: CAPS.companionOrders,
  });

  const counts = new Map<string, number>();
  for (const order of alongside) counts.set(order.productId, (counts.get(order.productId) ?? 0) + 1);
  if (!counts.size) return [];

  const products = await prisma.product.findMany({
    where: { workspaceId, id: { in: [...counts.keys()] } },
    select: recommendSelect,
  });

  return products
    .map((product) => ({ product, count: counts.get(product.id) ?? 0, stocked: totalAvailable(product) }))
    .filter((c) => c.stocked > 0)
    .sort((a, b) => b.count - a.count || compare(a.product.name, b.product.name))
    .slice(0, CAPS.crossSell)
    .map(({ product, stocked }) => ({
      kind: "cross_sell" as const,
      product: product.name,
      variant: null,
      priceInr: toRupees(product.price),
      available: stocked,
      why: `Bought alongside the ${matched.name} here`,
    }));
}

/** In-stock variants of the same product first, then the rest of its category. */
async function alternativesTo(
  workspaceId: string,
  matched: RecommendProduct,
  gone: VariantRow,
): Promise<Recommendation[]> {
  const why = `Instead of ${matched.name} ${label(gone)}, which is sold out`;

  const items: Recommendation[] = inStockVariants(matched, gone)
    .slice(0, CAPS.alternatives)
    .map((v) => ({
      kind: "alternative" as const,
      product: matched.name,
      variant: label(v),
      priceInr: toRupees(matched.price),
      available: available(v),
      why,
    }));

  if (items.length >= CAPS.alternatives) return items;

  const neighbours = await prisma.product.findMany({
    where: { workspaceId, category: matched.category, id: { not: matched.id } },
    select: recommendSelect,
    orderBy: { name: "asc" },
    take: CAPS.alternatives,
  });

  for (const neighbour of neighbours) {
    const stocked = totalAvailable(neighbour);
    if (!stocked) continue;
    items.push({
      kind: "alternative",
      product: neighbour.name,
      variant: bestVariant(neighbour),
      priceInr: toRupees(neighbour.price),
      available: stocked,
      why,
    });
    if (items.length >= CAPS.alternatives) break;
  }

  return items;
}

/**
 * The next tier up: the cheapest product in the same category that costs more
 * than the matched one and is actually on the shelf. Cheapest-above rather
 * than dearest, because an upsell is a step, not a leap -- a customer shown a
 * polo at twice the price stops reading. Prices come from the rows; nothing
 * here computes a difference, a saving or a discount.
 */
async function upsellFrom(workspaceId: string, matched: RecommendProduct): Promise<Recommendation[]> {
  const dearer = await prisma.product.findMany({
    where: { workspaceId, category: matched.category, price: { gt: matched.price }, id: { not: matched.id } },
    select: recommendSelect,
    orderBy: [{ price: "asc" }, { name: "asc" }],
    take: CAPS.upsellScan,
  });

  for (const product of dearer) {
    const stocked = totalAvailable(product);
    if (!stocked) continue;
    return [{
      kind: "upsell",
      product: product.name,
      variant: bestVariant(product),
      priceInr: toRupees(product.price),
      available: stocked,
      why: `A step up from the ${matched.name}`,
    }];
  }

  return [];
}
