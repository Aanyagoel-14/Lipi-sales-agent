import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { invoiceNumberFrom } from "@/server/lib/crypto";
import { paymentProvider } from "@/server/lib/payments";
import { toRupees } from "@/server/lib/money";
import { prisma } from "@/server/lib/prisma";

/**
 * The customer's invoice, at the link the twin sends them.
 *
 * No account and no dashboard: the signed token in the URL is the whole
 * credential (`invoiceToken`), so this page shows one invoice and nothing
 * else about the business. It is where they pay — the button posts to
 * `./pay`, which hands off to whichever provider the deployment has — and
 * where they come back to see that it worked.
 */

type Props = {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Invoice", robots: { index: false, follow: false } };

const inr = (paise: number) => `₹${toRupees(paise).toLocaleString("en-IN")}`;
const day = (date: Date) => date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

const NOTICE: Record<string, string> = {
  sold_out: "Sorry — this item sold out before payment. You have not been charged.",
  unavailable: "Online payment isn't available for this invoice yet. Please reply in the chat and we'll help you pay.",
  failed: "The payment page could not be opened. Please try again in a moment.",
};

export default async function InvoicePage({ params, searchParams }: Props) {
  const { token } = await params;
  const query = await searchParams;
  const number = invoiceNumberFrom(token);
  if (!number) notFound();

  const invoice = await prisma.invoice.findUnique({
    where: { number },
    include: {
      workspace: { select: { name: true } },
      customer: { select: { name: true, handle: true } },
      order: { include: { product: { select: { name: true } } } },
      payments: true,
    },
  });
  if (!invoice) notFound();

  const paid = invoice.payments.reduce((sum, p) => sum + p.amount, 0);
  const owed = invoice.amount - paid;
  const provider = paymentProvider();
  const test = provider.name === "demo";
  const error = typeof query.error === "string" ? NOTICE[query.error] : undefined;
  const { order } = invoice;

  return (
    <main className="min-h-screen bg-ground px-4 py-10 text-ink">
      <div className="mx-auto max-w-md">
        {test ? (
          <p className="mb-4 rounded-md bg-amber-wash px-3 py-2 text-center text-sm text-ink">
            TEST MODE — no real money is taken on this page.
          </p>
        ) : null}

        <section className="rounded-xl border border-line bg-surface p-6 shadow-sm">
          <header className="mb-6 flex items-start justify-between gap-4">
            <div>
              <p className="text-sm text-ink-muted">{invoice.workspace.name}</p>
              <h1 className="text-xl font-semibold">Invoice {invoice.number}</h1>
              <p className="text-sm text-ink-muted">Issued {day(invoice.issuedOn)} · Due {day(invoice.dueOn)}</p>
            </div>
            <span className={`rounded-full px-3 py-1 text-xs font-medium ${owed <= 0 ? "bg-teal text-surface" : "bg-chip text-ink"}`}>
              {owed <= 0 ? "Paid" : "Unpaid"}
            </span>
          </header>

          <p className="mb-1 text-sm text-ink-muted">Billed to</p>
          {/* Until they say who they are, the name on file is their account
              id, which is not a thing to print on an invoice. */}
          <p className="mb-6">{invoice.customer.name === invoice.customer.handle ? "Customer" : invoice.customer.name}</p>

          {order ? (
            <div className="mb-6 flex justify-between border-y border-line py-3">
              <span>{order.qty} × {order.product.name} <span className="text-ink-muted">({order.variant})</span></span>
              <span>{inr(order.value)}</span>
            </div>
          ) : null}

          <dl className="mb-6 space-y-1 text-sm">
            <div className="flex justify-between"><dt className="text-ink-muted">Total</dt><dd>{inr(invoice.amount)}</dd></div>
            {paid > 0 ? <div className="flex justify-between"><dt className="text-ink-muted">Paid</dt><dd>{inr(paid)}</dd></div> : null}
            <div className="flex justify-between text-base font-semibold"><dt>Amount due</dt><dd>{inr(Math.max(owed, 0))}</dd></div>
          </dl>

          {error ? <p className="mb-4 rounded-md bg-chip px-3 py-2 text-sm">{error}</p> : null}

          {owed <= 0 ? (
            <p className="rounded-md bg-chip px-3 py-3 text-center text-sm">
              Payment received — thank you. Your order is confirmed and we&apos;ll let you know when it ships.
            </p>
          ) : provider.configured() ? (
            <form action={`/i/${token}/pay`} method="post">
              <button type="submit" className="w-full rounded-lg bg-violet px-4 py-3 font-medium text-surface hover:opacity-90">
                Pay {inr(owed)}{test ? " (test)" : ""}
              </button>
            </form>
          ) : (
            <p className="rounded-md bg-chip px-3 py-3 text-center text-sm">{NOTICE.unavailable}</p>
          )}

          <a href={`/i/${token}/pdf`} className="mt-4 block text-center text-sm text-ink-muted underline">
            Download PDF
          </a>
        </section>
      </div>
    </main>
  );
}
