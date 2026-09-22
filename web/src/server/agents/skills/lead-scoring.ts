import { z } from "zod";
import { scoreLead } from "../../services/leads";
import type { SkillSpec } from "../types";

/**
 * `Lead_Scoring` (PRD §2 Step 01).
 *
 * How close this conversation is to becoming an order, recomputed from
 * signals and written onto the customer twin.
 *
 * The arithmetic is `services/leads.ts`'s, not a second copy of it. That
 * module already runs inside `ingest()` after every inbound message; this
 * skill is the same function made addressable, so an agent assembled in the
 * builder — an SDR that does nothing but qualify — can hold scoring without
 * holding the whole commerce loop. Two implementations of a score would be
 * two lead lists that disagree.
 */
export const leadScoring: SkillSpec<{
  intent?: string;
  matchedProduct?: boolean;
  quantity?: number;
  justOrdered?: boolean;
}> = {
  slug: "Lead_Scoring",
  label: "Lead scoring",
  description: "Recomputes a customer twin's purchase-intent score and stage from this turn's signals.",
  category: "crm",
  touchesMoney: false,
  parameters: z.object({
    intent: z.string().min(1).optional(),
    matchedProduct: z.boolean().optional(),
    quantity: z.number().int().positive().optional(),
    justOrdered: z.boolean().optional(),
  }),

  async run(args, ctx) {
    if (!ctx.customerId) throw new Error("Lead_Scoring needs a customer twin; none was in scope");

    const customer = await ctx.tx.customer.findFirst({
      where: { id: ctx.customerId, workspaceId: ctx.workspaceId },
      select: { id: true, leadScore: true, leadStage: true },
    });
    if (!customer) throw new Error("Lead_Scoring was given a customer that is not in this workspace");

    // Ground truth for "has this customer ever ordered" is the order table,
    // not `Customer.orderCount` — `leads.ts` has its own note on why that
    // field is not to be trusted here.
    const orderCount = await ctx.tx.order.count({ where: { customerId: customer.id } });

    const { score, stage } = scoreLead({
      previousScore: customer.leadScore,
      intent: args.intent ?? "other",
      matchedProduct: args.matchedProduct ?? false,
      quantity: args.quantity ?? null,
      justOrdered: args.justOrdered ?? false,
      orderCount,
    });

    const changed = score !== customer.leadScore || stage !== customer.leadStage;
    if (changed) {
      await ctx.tx.customer.update({
        where: { id: customer.id },
        data: { leadScore: score, leadStage: stage },
      });
      ctx.record("lead.scored", "customer", `${customer.id} score=${score} stage=${stage}`);
    }

    return {
      summary: changed
        ? `Scored the lead ${score} (${stage}), was ${customer.leadScore} (${customer.leadStage})`
        : `Lead unchanged at ${score} (${stage})`,
      data: {
        customerId: customer.id,
        score,
        stage,
        previousScore: customer.leadScore,
        previousStage: customer.leadStage,
        changed,
      },
    };
  },
};
