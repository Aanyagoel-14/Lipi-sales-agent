import { prisma } from "../lib/prisma";
import { toRupees } from "../lib/money";

/**
 * Invoice state is derived, never stored: `owed` comes from the payments
 * recorded against an invoice, and the ageing buckets come from the invoices.
 * Storing either would let the totals drift from the rows they summarise.
 *
 * "Now" is pinned so the demo dataset keeps its shape. Replace with
 * `new Date()` once the data is live.
 */
export const AS_OF = new Date("2026-08-22T12:00:00Z");

const DAY = 86_400_000;

export type AgeBucket = "not_due" | "late_1_15" | "late_16_30" | "late_30_plus";

export function bucketOf(daysLate: number): AgeBucket {
  if (daysLate <= 0) return "not_due";
  if (daysLate <= 15) return "late_1_15";
  if (daysLate <= 30) return "late_16_30";
  return "late_30_plus";
}

export async function resolveInvoices(workspaceId: string) {
  const rows = await prisma.invoice.findMany({
    where: { workspaceId },
    include: { payments: true, customer: { select: { name: true } } },
  });

  return rows
    .map((inv) => {
      const paid = inv.payments.reduce((a, p) => a + p.amount, 0);
      const owed = inv.amount - paid;
      const daysLate = owed > 0 ? Math.floor((AS_OF.getTime() - inv.dueOn.getTime()) / DAY) : 0;
      const status = owed <= 0 ? "paid" : daysLate > 0 ? "overdue" : paid > 0 ? "partial" : "awaiting";

      return {
        number: inv.number,
        customerId: inv.customerId,
        customerName: inv.customer.name,
        orderId: inv.orderId,
        source: inv.source,
        issuedIso: inv.issuedOn.toISOString().slice(0, 10),
        dueIso: inv.dueOn.toISOString().slice(0, 10),
        amountInr: toRupees(inv.amount),
        receivedInr: toRupees(paid),
        owedInr: toRupees(owed),
        daysLate,
        status,
        bucket: bucketOf(daysLate),
      };
    })
    .sort((a, b) => b.daysLate - a.daysLate || Date.parse(b.issuedIso) - Date.parse(a.issuedIso));
}

const methodLabel = {
  bank_transfer: "Bank transfer",
  card: "Card",
  upi: "UPI",
  cash: "Cash",
} as const;

export async function resolvePayments(workspaceId: string) {
  // Oldest first so each invoice's running balance is correct, then flip for display.
  const rows = await prisma.payment.findMany({
    where: { workspaceId },
    orderBy: { receivedAt: "asc" },
    include: { invoice: { select: { amount: true } }, customer: { select: { name: true } } },
  });

  const paidSoFar = new Map<string, number>();
  const withBalance = rows.map((p) => {
    const running = (paidSoFar.get(p.invoiceNumber) ?? 0) + p.amount;
    paidSoFar.set(p.invoiceNumber, running);
    return {
      id: p.id,
      receivedIso: p.receivedAt.toISOString(),
      customerId: p.customerId,
      customerName: p.customer.name,
      invoiceNumber: p.invoiceNumber,
      method: methodLabel[p.method],
      reference: p.reference,
      loggedBy: p.loggedBy,
      amountInr: toRupees(p.amount),
      balanceAfterInr: toRupees(p.invoice.amount - running),
    };
  });

  return withBalance.reverse();
}

export async function ageing(workspaceId: string) {
  const resolved = await resolveInvoices(workspaceId);
  const open = resolved.filter((i) => i.owedInr > 0);
  const buckets: AgeBucket[] = ["not_due", "late_1_15", "late_16_30", "late_30_plus"];

  const rows = buckets.map((bucket) => {
    const inBucket = open.filter((i) => i.bucket === bucket);
    return {
      bucket,
      amountInr: inBucket.reduce((a, i) => a + i.owedInr, 0),
      invoices: inBucket.length,
    };
  });

  const settled = resolved.filter((i) => i.owedInr <= 0);
  const settlements = await prisma.payment.findMany({
    where: { workspaceId, invoiceNumber: { in: settled.map((s) => s.number) } },
    include: { invoice: { select: { number: true, issuedOn: true } } },
  });

  const lastPerInvoice = new Map<string, number>();
  for (const p of settlements) {
    const at = p.receivedAt.getTime();
    if (at > (lastPerInvoice.get(p.invoiceNumber) ?? 0)) lastPerInvoice.set(p.invoiceNumber, at);
  }

  const totalDays = settled.reduce((a, s) => {
    const last = lastPerInvoice.get(s.number);
    return a + (last ? Math.floor((last - Date.parse(s.issuedIso)) / DAY) : 0);
  }, 0);

  return {
    rows,
    totalOutstanding: rows.reduce((a, r) => a + r.amountInr, 0),
    avgDaysToPay: Math.round(totalDays / Math.max(settled.length, 1)),
    settledCount: settled.length,
  };
}
