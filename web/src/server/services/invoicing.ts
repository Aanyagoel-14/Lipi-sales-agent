import { randomUUID } from "node:crypto";
import PDFDocument from "pdfkit";
import { toRupees } from "../lib/money";
import { prisma } from "../lib/prisma";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Turning an order into an invoice, and an invoice into a PDF.
 *
 * Invoicing is deliberately separate from the sell loop. The loop decides what
 * was bought and reserves it; this decides what is owed. Keeping them apart
 * means a reply that goes wrong cannot silently change a number the customer
 * is being asked to pay.
 *
 * Amounts are copied from the order at issue time rather than recomputed
 * later: an invoice is a record of what was agreed, so a price change next
 * week must not rewrite what someone already received.
 */

/** Net terms. Retail pays now; a wholesale or corporate buyer gets 15 days. */
const TERMS_DAYS: Record<string, number> = { Retail: 0, Wholesale: 15, Corporate: 15 };

const DAY = 86_400_000;

/**
 * Invoice numbers are per workspace and gap-free per year, because an
 * accountant reading a sequence with holes in it has to prove none are hidden.
 */
async function nextNumber(tx: Prisma.TransactionClient, workspaceId: string, year: number) {
  const prefix = `INV-${year}-`;
  const last = await tx.invoice.findFirst({
    where: { workspaceId, number: { startsWith: prefix } },
    orderBy: { number: "desc" },
    select: { number: true },
  });

  const seq = last ? Number(last.number.slice(prefix.length).split("-")[0]) + 1 : 1;
  // The workspace suffix keeps numbers unique across tenants, since `number`
  // is the primary key and two workspaces will both reach 0001.
  return `${prefix}${String(seq).padStart(4, "0")}-${workspaceId.slice(-4)}`;
}

/**
 * Issues the invoice for an order, or returns the one it already has.
 *
 * Idempotent on purpose: a customer asking twice for their invoice, or a
 * retried request, must not produce two demands for the same money.
 */
export async function invoiceForOrder(workspaceId: string, orderId: string, now = new Date()) {
  const existing = await prisma.invoice.findFirst({ where: { workspaceId, orderId } });
  if (existing) return { invoice: existing, created: false };

  const invoice = await prisma.$transaction(async (tx) => {
    // Re-check inside the transaction: two requests can pass the check above
    // at the same time, and the second must not issue a second invoice.
    const raced = await tx.invoice.findFirst({ where: { workspaceId, orderId } });
    if (raced) return raced;

    const order = await tx.order.findFirst({
      where: { id: orderId, workspaceId },
      include: { customer: { select: { id: true, segment: true } } },
    });
    if (!order) throw new Error(`Unknown order ${orderId}`);

    const terms = TERMS_DAYS[order.customer.segment] ?? 0;
    const created = await tx.invoice.create({
      data: {
        number: await nextNumber(tx, workspaceId, now.getUTCFullYear()),
        workspaceId,
        source: "manual",
        issuedOn: new Date(now.toISOString().slice(0, 10)),
        dueOn: new Date(new Date(now.getTime() + terms * DAY).toISOString().slice(0, 10)),
        amount: order.value,
        customerId: order.customerId,
        orderId: order.id,
      },
    });

    await tx.twinEvent.create({
      data: {
        id: `evt_${randomUUID().slice(0, 8)}`,
        workspaceId,
        occurredAt: now,
        type: "invoice.issued",
        twin: "order",
        payload: `${created.number} order=${order.id} amount=${toRupees(created.amount)} due=${created.dueOn.toISOString().slice(0, 10)}`,
      },
    });

    return created;
  });

  return { invoice, created: true };
}

const inr = (paise: number) => `INR ${toRupees(paise).toLocaleString("en-IN")}`;

/**
 * Renders the invoice as a PDF.
 *
 * Buffered rather than streamed to the response: a render that throws halfway
 * would otherwise have already sent a 200 and a broken file, and a customer
 * cannot tell a corrupt invoice from a real one.
 *
 * Built-in Helvetica only. Rupee glyphs are written as "INR" because the
 * standard PDF fonts have no ₹, and a box character on an invoice looks like
 * a defect.
 */
export async function renderInvoicePdf(workspaceId: string, number: string): Promise<{ filename: string; body: Buffer }> {
  const invoice = await prisma.invoice.findFirst({
    where: { number, workspaceId },
    include: {
      workspace: { select: { name: true } },
      customer: { select: { name: true, handle: true, segment: true } },
      order: { include: { product: { select: { name: true, category: true } } } },
      payments: true,
    },
  });
  if (!invoice) throw new Error(`Unknown invoice ${number}`);

  const paid = invoice.payments.reduce((a, p) => a + p.amount, 0);
  const owed = invoice.amount - paid;

  const doc = new PDFDocument({ size: "A4", margin: 50, info: { Title: invoice.number } });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const line = (y: number) => doc.moveTo(50, y).lineTo(545, y).strokeColor("#e5e5e5").stroke();

  doc.fillColor("#111").font("Helvetica-Bold").fontSize(20).text(invoice.workspace.name, 50, 50);
  doc.font("Helvetica").fontSize(9).fillColor("#666").text("Tax invoice", 50, 74);

  doc.font("Helvetica-Bold").fontSize(11).fillColor("#111").text(invoice.number, 380, 50, { width: 165, align: "right" });
  doc.font("Helvetica").fontSize(9).fillColor("#666")
    .text(`Issued ${invoice.issuedOn.toISOString().slice(0, 10)}`, 380, 66, { width: 165, align: "right" })
    .text(`Due ${invoice.dueOn.toISOString().slice(0, 10)}`, 380, 79, { width: 165, align: "right" });

  line(104);

  doc.fillColor("#666").fontSize(8).text("BILLED TO", 50, 118);
  doc.fillColor("#111").font("Helvetica-Bold").fontSize(11).text(invoice.customer.name, 50, 132);
  doc.font("Helvetica").fontSize(9).fillColor("#666")
    .text(invoice.customer.handle, 50, 148)
    .text(`${invoice.customer.segment} account`, 50, 161);

  if (invoice.order) {
    doc.fillColor("#666").fontSize(8).text("ORDER", 380, 118, { width: 165, align: "right" });
    doc.fillColor("#111").font("Helvetica").fontSize(9)
      .text(invoice.order.id, 380, 132, { width: 165, align: "right" })
      .text(`via ${invoice.order.channel}`, 380, 145, { width: 165, align: "right" });
  }

  /* ------------------------------------------------------------ line items */
  let y = 200;
  doc.fillColor("#666").fontSize(8);
  doc.text("DESCRIPTION", 50, y).text("QTY", 330, y, { width: 50, align: "right" })
    .text("UNIT", 390, y, { width: 70, align: "right" }).text("AMOUNT", 470, y, { width: 75, align: "right" });
  y += 14;
  line(y);
  y += 12;

  if (invoice.order) {
    const o = invoice.order;
    const unit = Math.round(o.value / Math.max(o.qty, 1));
    doc.fillColor("#111").font("Helvetica").fontSize(10).text(o.product.name, 50, y, { width: 270 });
    doc.fillColor("#666").fontSize(8).text(o.variant, 50, y + 13, { width: 270 });
    doc.fillColor("#111").fontSize(10)
      .text(String(o.qty), 330, y, { width: 50, align: "right" })
      .text(inr(unit), 390, y, { width: 70, align: "right" })
      .text(inr(o.value), 470, y, { width: 75, align: "right" });
    y += 34;
  } else {
    // An invoice can exist without an order behind it (imported from Zoho or
    // QuickBooks). Showing the amount alone is honest; inventing a line is not.
    doc.fillColor("#111").fontSize(10).text(`Invoice ${invoice.number}`, 50, y, { width: 270 })
      .text(inr(invoice.amount), 470, y, { width: 75, align: "right" });
    y += 24;
  }

  line(y);
  y += 12;

  const total = (label: string, value: string, bold = false) => {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 11 : 10).fillColor(bold ? "#111" : "#666")
      .text(label, 330, y, { width: 130, align: "right" })
      .text(value, 470, y, { width: 75, align: "right" });
    y += bold ? 20 : 16;
  };

  total("Total", inr(invoice.amount), true);
  if (paid > 0) {
    total("Paid", `- ${inr(paid)}`);
    total("Balance due", inr(owed), true);
  }

  doc.font("Helvetica").fontSize(8).fillColor("#999")
    .text(
      owed <= 0 ? "Paid in full. Thank you." : `Payable by ${invoice.dueOn.toISOString().slice(0, 10)}.`,
      50, y + 24,
    )
    .text("Generated by the Lipi AI twin.", 50, y + 38);

  doc.end();

  return { filename: `${invoice.number}.pdf`, body: await done };
}
