import { invoiceNumberFrom } from "@/server/lib/crypto";
import { paymentMethodFrom, paymentProviderFor } from "@/server/lib/payments";
import { prisma } from "@/server/lib/prisma";
import { settleInvoice } from "@/server/services/checkout";

/**
 * Where the gateway sends the customer back to after they pay.
 *
 * Razorpay appends what happened to the query string. None of that is
 * evidence — it is a URL in the customer's browser — so the gateway is asked
 * directly, through the connection that issued the link, and only its answer
 * settles the invoice. The webhook will say the same thing a moment later
 * and find it already settled; this exists so the customer who comes back
 * to the page sees "Paid" at once rather than "Unpaid" for a few seconds.
 *
 * A customer who paid in a UPI app and never came back is covered by the
 * webhook alone, which is why the webhook is required at connect time.
 */

export const dynamic = "force-dynamic";

const back = (token: string, query = "") =>
  new Response(null, { status: 303, headers: { Location: `/i/${token}${query}` } });

export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const number = invoiceNumberFrom(token);
  if (!number) return new Response(null, { status: 404 });

  const invoice = await prisma.invoice.findUnique({
    where: { number }, include: { payments: true, paymentLink: true },
  });
  if (!invoice) return new Response(null, { status: 404 });

  const owed = invoice.amount - invoice.payments.reduce((sum, p) => sum + p.amount, 0);
  if (owed <= 0) return back(token);

  const link = invoice.paymentLink;
  const provider = await paymentProviderFor(invoice.workspaceId);
  if (!link || link.closedAt || !provider.lookupLink || provider.name !== link.provider) return back(token, "?error=unpaid");

  const status = await provider.lookupLink(link.id).catch(() => null);
  if (status?.status !== "paid") return back(token, "?error=unpaid");

  // The gateway lists the payment it took; without one listed, the link
  // itself is the reference and the whole balance is what it said was paid.
  const payment = status.payments[0];
  const settled = await settleInvoice(invoice.workspaceId, number, {
    method: paymentMethodFrom(payment?.method),
    reference: payment?.id ?? `plink:${link.id}`,
    by: provider.name,
    amount: payment?.amount ?? owed,
    charged: true,
  });
  return back(token, settled.ok ? "" : `?error=${settled.reason}`);
}
