import type { Tx } from "../lib/prisma";
import type { TwinEffect } from "../lib/events";

/**
 * The Customer and Supply twin rules the PRD states (§5).
 *
 * Three of them, and they are collected here rather than written inline in
 * `ingest()` for one reason: each is a *rule about the business*, each is
 * stated in one sentence in the PRD, and each was previously either absent or
 * a sentence in a log. A rule in its own function can be tested against a
 * table of cases; the same rule spread across four branches of a 600-line
 * transaction cannot.
 *
 *   creditRisk   "flags credit risk if past-due invoices > 0"
 *   vipRouting   "routes VIP inquiries instantly"
 *   restock      "auto-dispatches POs when reserved inventory drops below
 *                 threshold"
 *
 * None of them refuses a sale. A good customer with one late invoice is still
 * a good customer, and deciding otherwise unattended is not a sales agent's
 * call — what these do is flag, route and raise, so a human sees the thing the
 * PRD says they should see.
 */

/* ------------------------------------------------------------ credit risk */

export type CreditVerdict = {
  /** Money outstanding past its due date, in integer minor units. */
  overduePaise: number;
  overdueInvoices: number;
  hold: boolean;
};

/**
 * What this customer owes that is late.
 *
 * Derived from payments, never from a stored status — `services/billing.ts` is
 * explicit that storing it would let the total drift from the rows it
 * summarises, and two definitions of "paid" is how a customer gets chased for
 * money they sent.
 */
export async function creditRisk(tx: Tx, workspaceId: string, customerId: string, now: Date): Promise<CreditVerdict> {
  const invoices = await tx.invoice.findMany({
    where: { workspaceId, customerId, dueOn: { lt: now } },
    select: { amount: true, payments: { select: { amount: true } } },
  });

  let overduePaise = 0;
  let overdueInvoices = 0;
  for (const invoice of invoices) {
    const owed = invoice.amount - invoice.payments.reduce((sum, payment) => sum + payment.amount, 0);
    if (owed <= 0) continue;
    overdueInvoices += 1;
    overduePaise += owed;
  }

  return { overduePaise, overdueInvoices, hold: overdueInvoices > 0 };
}

export const creditEffect = (customerId: string, verdict: CreditVerdict): TwinEffect => ({
  type: "customer_twin.credit_risk",
  twin: "customer",
  payload: `${customerId} overdue_invoices=${verdict.overdueInvoices} overdue=${verdict.overduePaise}`,
});

/* ------------------------------------------------------------ VIP routing */

/**
 * Lifetime value at which a customer is routed as VIP regardless of segment,
 * in integer minor units — one lakh.
 *
 * A figure has to be somewhere, and the PRD gives none. It is here, named, and
 * next to the rule it governs, rather than inline in a condition where the
 * next person to read it has to work out what 10000000 meant.
 */
export const VIP_LIFETIME_VALUE = 100_000_00;

export type VipReason = "segment" | "lifetime_value" | null;

/**
 * Whether this inquiry goes to the front of the queue.
 *
 * Corporate buyers and high-value customers. "Instantly" in the PRD means
 * *ahead of the rest*, which in this system is a matter of what an operator
 * sees first — so the rule marks the run and the event, and the approval queue
 * and inbox order on it. It does not change what the twin says, because a VIP
 * getting a different price is a different feature and not one the PRD asks
 * for here.
 */
export function vipRouting(customer: { segment: string; lifetimeValue: number }): VipReason {
  if (customer.segment === "Corporate") return "segment";
  if (customer.lifetimeValue >= VIP_LIFETIME_VALUE) return "lifetime_value";
  return null;
}

export const vipEffect = (customerId: string, reason: NonNullable<VipReason>): TwinEffect => ({
  type: "customer_twin.vip_routed",
  twin: "customer",
  payload: `${customerId} reason=${reason}`,
});

/* --------------------------------------------------------------- restock */

export type RestockPlan = {
  qty: number;
  supplierId: string;
  expectedOn: Date;
  reason: string;
};

/**
 * What to order when a variant crosses its reorder point.
 *
 * Quantity is the supplier's MOQ or the shortfall back to a working level,
 * whichever is larger: ordering below a minimum is an order the supplier
 * refuses, and ordering exactly the shortfall puts the twin back at the
 * threshold it just crossed.
 *
 * Returns null when there is already an open PO for this variant. A reorder
 * point is crossed by *every* subsequent message until stock arrives, and a
 * rule that raised a PO each time would bury the operator in duplicates of the
 * same decision.
 */
export async function planRestock(
  tx: Tx,
  opts: {
    workspaceId: string;
    productId: string;
    variantId: string;
    supplierId: string;
    available: number;
    reorderPoint: number;
    now: Date;
  },
): Promise<RestockPlan | null> {
  const open = await tx.purchaseOrder.findFirst({
    where: { variantId: opts.variantId, status: { in: ["draft", "sent"] } },
    select: { id: true },
  });
  if (open) return null;

  const supplier = await tx.supplier.findFirst({
    where: { id: opts.supplierId, workspaceId: opts.workspaceId },
    select: { moq: true, avgLeadDays: true, name: true },
  });
  if (!supplier) return null;

  // Back to twice the reorder point, so the next sale does not re-cross it.
  const shortfall = Math.max(0, opts.reorderPoint * 2 - opts.available);
  const qty = Math.max(supplier.moq, shortfall);

  return {
    qty,
    supplierId: opts.supplierId,
    expectedOn: new Date(opts.now.getTime() + supplier.avgLeadDays * 86_400_000),
    reason:
      `Available fell to ${opts.available}, at or below the reorder point of ${opts.reorderPoint}. ` +
      `${supplier.name} MOQ ${supplier.moq}, lead time ${supplier.avgLeadDays} days.`,
  };
}

/** Raises the PO the plan describes, and the event that says it happened. */
export async function raiseRestock(
  tx: Tx,
  opts: { workspaceId: string; productId: string; variantId: string; plan: RestockPlan },
): Promise<TwinEffect> {
  const purchaseOrder = await tx.purchaseOrder.create({
    data: {
      workspaceId: opts.workspaceId,
      productId: opts.productId,
      variantId: opts.variantId,
      supplierId: opts.plan.supplierId,
      qty: opts.plan.qty,
      reason: opts.plan.reason,
      expectedOn: opts.plan.expectedOn,
    },
  });

  return {
    type: "supply_twin.po_raised",
    twin: "supply",
    payload:
      `${purchaseOrder.id} variant=${opts.variantId} qty=${opts.plan.qty} ` +
      `expected=${opts.plan.expectedOn.toISOString().slice(0, 10)} status=draft`,
  };
}
