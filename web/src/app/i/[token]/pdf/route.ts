import { invoiceNumberFrom } from "@/server/lib/crypto";
import { prisma } from "@/server/lib/prisma";
import { renderInvoicePdf } from "@/server/services/invoicing";

/** The customer's copy of their invoice as a PDF, behind the same signed token as the page. */

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const number = invoiceNumberFrom(token);
  if (!number) return new Response(null, { status: 404 });

  const invoice = await prisma.invoice.findUnique({ where: { number }, select: { workspaceId: true } });
  if (!invoice) return new Response(null, { status: 404 });

  const { filename, body } = await renderInvoicePdf(invoice.workspaceId, number);
  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${filename}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
