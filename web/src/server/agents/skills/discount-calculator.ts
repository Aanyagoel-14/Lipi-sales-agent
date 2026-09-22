import { z } from "zod";
import type { SkillSpec } from "../types";

/**
 * `Discount_Calculator` (PRD §2 Step 01, and the floors in Step 02).
 *
 * The one place a price may move, and the reason it is deterministic code
 * rather than a prompt: a model asked to "apply a sensible discount" will
 * eventually apply one the business cannot honour, and the customer has no
 * way to tell that from a real quote (invariant 2).
 *
 * Three ceilings, checked in order, because they answer different questions:
 *
 *   maxAutonomousDiscountPct  how far may this agent move on its own
 *   minPriceFloorPct          how low may the number go, however it got there
 *   minMarginPct              PRD §5 — "authorises custom quotes if margin > 18%"
 *
 * A request beyond any of them is not silently clamped. Clamping would hand
 * the customer a number nobody authorised and tell the operator a discount
 * was granted; instead the skill returns the best it *can* authorise and
 * escalates, so a human sees the gap and decides.
 */
export const discountCalculator: SkillSpec<{
  product: string;
  quantity: number;
  requestedUnitPrice?: number;
  requestedDiscountPct?: number;
}> = {
  slug: "Discount_Calculator",
  label: "Discount calculator",
  description:
    "Decides whether a requested price or discount is within the agent's authority, and what it may offer instead.",
  category: "commerce",
  touchesMoney: true,
  alwaysEscalateOn: ["DISPUTE", "CHARGEBACK"],
  parameters: z
    .object({
      product: z.string().min(1),
      quantity: z.number().int().positive(),
      /** What the customer asked to pay, per unit, in integer minor units. */
      requestedUnitPrice: z.number().int().nonnegative().optional(),
      /** Or the same request as a fraction off list. One or the other. */
      requestedDiscountPct: z.number().min(0).max(1).optional(),
    })
    .refine((v) => v.requestedUnitPrice !== undefined || v.requestedDiscountPct !== undefined, {
      message: "Give either requestedUnitPrice or requestedDiscountPct",
      path: ["requestedUnitPrice"],
    }),

  async run(args, ctx) {
    const product = await ctx.twinStore.findProduct(args.product);
    if (!product) {
      return {
        summary: `Cannot price "${args.product}" — no such product`,
        data: { authorised: false, reason: "unknown_product" },
      };
    }

    const list = product.price;
    const requested =
      args.requestedUnitPrice ?? Math.round(list * (1 - (args.requestedDiscountPct ?? 0)));
    const requestedDiscountPct = list === 0 ? 0 : (list - requested) / list;

    // The lowest unit price each rule permits. Rounded *up*, so rounding can
    // only ever move the floor in the business's favour.
    const byAllowance = Math.ceil(list * (1 - ctx.guardrails.maxAutonomousDiscountPct));
    const byFloor = Math.ceil(list * ctx.guardrails.minPriceFloorPct);
    // Margin is carried as whole percent of list on the product row, so the
    // cost implied by it is list × (1 − margin), and a price that leaves the
    // required margin is cost ÷ (1 − required).
    const impliedCost = Math.round(list * (1 - product.marginPct / 100));
    const byMargin =
      ctx.guardrails.minMarginPct >= 100
        ? Number.POSITIVE_INFINITY
        : Math.ceil(impliedCost / (1 - ctx.guardrails.minMarginPct / 100));

    const floor = Math.max(byAllowance, byFloor, byMargin);
    const binding =
      floor === byMargin ? "minMarginPct" : floor === byFloor ? "minPriceFloorPct" : "maxAutonomousDiscountPct";

    const authorised = requested >= floor;
    const unitPrice = authorised ? requested : floor;
    const total = unitPrice * args.quantity;

    ctx.record(
      "pricing.evaluated",
      "order",
      `product=${product.id} list=${list} requested=${requested} floor=${floor} binding=${binding} authorised=${authorised}`,
    );

    return {
      summary: authorised
        ? `Authorised ${args.quantity} × ${product.name} at ${unitPrice} (list ${list})`
        : `Refused ${requested} for ${product.name}: ${binding} puts the floor at ${floor}`,
      data: {
        authorised,
        product: product.name,
        quantity: args.quantity,
        listUnitPrice: list,
        requestedUnitPrice: requested,
        requestedDiscountPct: Number(requestedDiscountPct.toFixed(4)),
        authorisedUnitPrice: unitPrice,
        floorUnitPrice: floor,
        bindingConstraint: binding,
        totalMinorUnits: total,
      },
      quotedValue: total,
      // Below the floor is exactly the case a human exists for. The skill
      // still reports what it *could* do, so the approver has a counter-offer
      // in front of them rather than only a refusal.
      ...(authorised
        ? {}
        : {
            escalate: {
              reason: `requested ${requested} is below the ${binding} floor of ${floor}`,
            },
          }),
    };
  },
};
