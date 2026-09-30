import { z } from "zod";
import { env } from "../../env";
import { paymentProvider } from "../../lib/payments";
import { issueInvoice } from "../../services/invoicing";
import type { SkillSpec } from "../types";

/**
 * `Stripe_Invoice` (PRD §2 Step 01).
 *
 * Raises the invoice for an order and, when the deployment has a payment
 * provider, a checkout link for it.
 *
 * Two things happen here and they are deliberately not the same thing. The
 * invoice is always real: a row, a gap-free number, a due date derived from
 * the customer's segment, and a PDF anyone can download. The checkout link is
 * real *or absent* — see `server/lib/payments.ts`. A URL that nobody can pay
 * would be the worst kind of fake success, because the customer only finds
 * out at the moment they try to hand over money.
 *
 * Idempotent through `issueInvoice()`, so a retried tool call, or a customer
 * asking twice, never produces two demands for the same amount.
 */
export const stripeInvoice: SkillSpec<{ orderId: string }> = {
  slug: "Stripe_Invoice",
  label: "Issue invoice and checkout link",
  description: "Raises the invoice for an order and a payment link for it where a provider is configured.",
  category: "finance",
  touchesMoney: true,
  alwaysEscalateOn: ["REFUND", "CHARGEBACK", "DISPUTE"],
  parameters: z.object({
    orderId: z.string().min(1),
  }),

  async run(args, ctx) {
    const order = await ctx.tx.order.findFirst({
      where: { id: args.orderId, workspaceId: ctx.workspaceId },
      select: { id: true, value: true, qty: true, variant: true, product: { select: { name: true } } },
    });
    // Scoped read, so naming another tenant's order id is indistinguishable
    // from naming one that does not exist.
    if (!order) throw new Error(`Unknown order ${args.orderId}`);

    const { invoice, created } = await issueInvoice(ctx.tx, ctx.workspaceId, order.id, ctx.now);

    const description = `${order.qty} × ${order.product.name} (${order.variant})`;
    const checkout = await paymentProvider().createCheckoutLink({
      workspaceId: ctx.workspaceId,
      amount: invoice.amount,
      currency: env.STRIPE_CURRENCY,
      description,
      reference: invoice.number,
    });

    if (checkout.ok) {
      ctx.record(
        "checkout.link_created",
        "order",
        `order=${order.id} invoice=${invoice.number} provider=${checkout.provider} ref=${checkout.link.providerRef}`,
      );
    } else {
      // Recorded as plainly as a success would be. An operator looking at why
      // a customer never paid should find the reason in the trail rather than
      // in a log nobody reads.
      ctx.record(
        "checkout.link_unavailable",
        "order",
        `order=${order.id} invoice=${invoice.number} provider=${checkout.provider} reason="${checkout.reason}"`,
      );
    }

    return {
      summary: created
        ? `Raised invoice ${invoice.number} for ${description}`
        : `Returned the existing invoice ${invoice.number} for ${description}`,
      data: {
        invoiceNumber: invoice.number,
        amountMinorUnits: invoice.amount,
        dueIso: invoice.dueOn.toISOString().slice(0, 10),
        invoiceUrl: `/v1/invoices/${encodeURIComponent(invoice.number)}/pdf`,
        newlyCreated: created,
        // Null, not a placeholder. Callers render the difference.
        checkoutUrl: checkout.ok ? checkout.link.url : null,
        paymentProvider: checkout.provider,
        ...(checkout.ok ? {} : { checkoutUnavailableReason: checkout.reason }),
      },
      quotedValue: invoice.amount,
    };
  },
};
