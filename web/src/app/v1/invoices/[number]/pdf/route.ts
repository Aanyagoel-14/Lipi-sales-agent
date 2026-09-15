import { HttpError, route } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { renderInvoicePdf } from "@/server/services/invoicing";

// PDFKit is a Node library and draws on Node streams; the edge runtime has
// neither.
export const runtime = "nodejs";

/** The invoice as a PDF, rendered on demand rather than stored. */
export const GET = route<{ number: string }>(async (_req, { number }) => {
  const workspaceId = await resolveWorkspaceId();

  const invoice = await prisma.invoice.findFirst({ where: { number, workspaceId }, select: { number: true } });
  if (!invoice) throw new HttpError(404, "Invoice not found");

  const { filename, body } = await renderInvoicePdf(workspaceId, number);

  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(body.length),
      // `inline` so the browser previews it; the filename still applies on save.
      "Content-Disposition": `inline; filename="${filename}"`,
    },
  });
});
