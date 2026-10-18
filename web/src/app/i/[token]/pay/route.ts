import { invoiceNumberFrom } from "@/server/lib/crypto";
import { env } from "@/server/env";
import { paymentProvider } from "@/server/lib/payments";
import { prisma } from "@/server/lib/prisma";
import { settleInvoice } from "@/server/services/checkout";

/**
 * The invoice page's Pay button.
 *
 * With the demo provider the invoice is settled here and now, through the
 * same `settleInvoice` a real provider's webhook will call. With a real
 * provider this opens its checkout for the amount still owed and sends the
 * customer there. Either way the answer is a redirect, because this is a
 * plain form post from a page the customer is looking at.
 */

export const dynamic = "force-dynamic";

// Relative, so it lands on whatever origin the customer used: behind a
// tunnel or a proxy, `req.url` can name the internal host instead.
const back = (_req: Request, token: string, query = "") =>
  new Response(null, { status: 303, headers: { Location: `/i/${token}${query}` } });

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const number = invoiceNumberFrom(token);
  if (!number) return new Response(null, { status: 404 });

  const invoice = await prisma.invoice.findUnique({
    where: { number },
    include: { payments: true, order: { include: { product: { select: { name: true } } } } },
  });
  if (!invoice) return new Response(null, { status: 404 });

  const owed = invoice.amount - invoice.payments.reduce((sum, p) => sum + p.amount, 0);
  if (owed <= 0) return back(req, token);

  const provider = paymentProvider();

  if (provider.name === "demo") {
    const settled = await settleInvoice(invoice.workspaceId, number, {
      method: "upi", reference: `DEMO-${Date.now()}`, by: "demo checkout",
    });
    return back(req, token, settled.ok ? "" : `?error=${settled.reason}`);
  }

  if (!provider.configured()) return back(req, token, "?error=unavailable");

  const checkout = await provider.createCheckoutLink({
    workspaceId: invoice.workspaceId,
    amount: owed,
    currency: env.STRIPE_CURRENCY,
    description: invoice.order ? `${invoice.order.qty} × ${invoice.order.product.name}` : `Invoice ${number}`,
    reference: number,
  });
  return checkout.ok ? Response.redirect(checkout.link.url, 303) : back(req, token, "?error=failed");
}
