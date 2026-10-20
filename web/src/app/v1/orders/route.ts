import { json, route } from "@/server/lib/http";
import { toRupees } from "@/server/lib/money";
import { publicInvoiceUrl } from "@/server/lib/payments";
import { holdsStock, releaseExpiredReservations } from "@/server/services/reservations";
import { after, paged, pageOf } from "@/server/lib/page";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";

export const GET = route(async (req) => {
  const workspaceId = await resolveWorkspaceId();
  const page = pageOf(req);
  // A hold that has lapsed is released before it is shown, so the list never
  // says "held until" a time that has passed. Idempotent and bounded, and the
  // same sweep the scheduled tick runs; a deployment with the tick finds
  // nothing here to do.
  await releaseExpiredReservations(workspaceId);
  const found = await prisma.order.findMany({
    where: { workspaceId, ...after("createdAt", page) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: {
      customer: { select: { name: true } },
      product: { select: { name: true } },
      invoices: { include: { payments: { select: { amount: true } } } },
    },
    take: page.take,
  });
  const { rows, nextCursor } = paged(found, page, (o) => o.createdAt);

  return json({
    nextCursor,
    orders: rows.map((o) => {
      // What the order is waiting on, read off the invoice and the stock
      // rather than inferred from the stage: a Confirmed order on credit
      // terms is unpaid and reserved; a Quoted one is unpaid and holds nothing.
      const invoice = o.invoices[0] ?? null;
      const paid = invoice ? invoice.payments.reduce((sum, p) => sum + p.amount, 0) : 0;
      const payment = invoice && paid >= invoice.amount ? "paid"
        : paid > 0 ? "partly_paid"
        : o.stage === "Confirmed" && invoice ? "on_terms"
        : "unpaid";
      const stock = o.stage === "Delivered" ? "shipped"
        : o.stage === "Returned" || o.stage === "Cancelled" ? "released"
        : holdsStock(o) ? (o.reservedUntil ? "held" : "reserved")
        : "not_held";
      return {
        id: o.id, customerId: o.customerId, productId: o.productId, variant: o.variant,
        qty: o.qty, valueInr: toRupees(o.value), stage: o.stage, channel: o.channel,
        createdIso: o.createdAt.toISOString(), blocked: o.blocked ?? undefined,
        customerName: o.customer.name, productName: o.product.name,
        payment, paidInr: toRupees(paid),
        invoiceNumber: invoice?.number, dueIso: invoice?.dueOn.toISOString().slice(0, 10),
        payLink: invoice && paid < invoice.amount ? publicInvoiceUrl(invoice.number) : undefined,
        stock, reservedUntilIso: o.reservedUntil?.toISOString(),
      };
    }),
  });
});
