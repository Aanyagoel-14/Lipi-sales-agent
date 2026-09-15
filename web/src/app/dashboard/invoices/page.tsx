import { Cell, EmptyState, PageHead, Panel, Row, Table, Tag } from "@/components/dash/ui";
import { dayOf, getInvoices, inr, timeOf, type AgeBucket, type Invoice } from "@/lib/dash";

export const metadata = { title: "Invoices & payments · Lipi AI" };

/** Ordinal severity. Each bucket is always labelled, so colour never carries it alone. */
const bucketMeta: Record<AgeBucket, { label: string; bar: string; ink: string }> = {
  not_due: { label: "Not yet due", bar: "bg-teal-mark", ink: "text-teal" },
  late_1_15: { label: "1–15 days late", bar: "bg-amber-mark", ink: "text-amber" },
  late_16_30: { label: "16–30 days late", bar: "bg-magenta-mark", ink: "text-magenta" },
  late_30_plus: { label: "30+ days late", bar: "bg-critical-mark", ink: "text-critical" },
};

const sourceLabel = { quickbooks: "QuickBooks", zoho: "Zoho", manual: "Manual" } as const;

function StatusTag({ invoice }: { invoice: Invoice }) {
  if (invoice.status === "paid") return <Tag tone="teal">Paid</Tag>;
  if (invoice.status === "awaiting") return <Tag>Awaiting</Tag>;
  if (invoice.status === "partial") return <Tag tone="amber">Partial</Tag>;
  return (
    <Tag tone={invoice.bucket === "late_30_plus" ? "critical" : "magenta"}>
      {invoice.daysLate}d overdue
    </Tag>
  );
}

export default async function InvoicesPage() {
  const data = await getInvoices();

  const { ageing, invoices, payments } = data;
  const pct = (n: number) => (ageing.totalOutstanding ? (n / ageing.totalOutstanding) * 100 : 0);

  return (
    <>
      <PageHead
        title="Invoices &amp; payments"
        blurb="A record of what you billed elsewhere and what has actually landed. Lipi does not issue invoices and does not move money."
      />

      {invoices.length === 0 ? (
        <EmptyState
          title="No invoices recorded"
          body="Lipi records what you billed elsewhere and what has landed. Nothing appears here until an order is invoiced in your accounting tool."
          action={{ href: "/dashboard/orders", label: "See open orders" }}
        />
      ) : (
        <>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.7fr_1fr]">
        <Panel title="Outstanding by age">
          <p className="tabular text-[2rem] leading-none tracking-tight">{inr(ageing.totalOutstanding)}</p>
          <p className="mt-1.5 text-[0.8125rem] text-ink-muted">
            across {ageing.rows.reduce((a, r) => a + r.invoices, 0)} open invoices
          </p>

          {/* 2px surface gaps keep adjacent segments legible where hues meet. */}
          <div className="mt-5 flex h-2.5 gap-0.5 overflow-hidden rounded-full">
            {ageing.rows
              .filter((r) => r.amountInr > 0)
              .map((r) => (
                <span
                  key={r.bucket}
                  className={bucketMeta[r.bucket].bar}
                  style={{ width: `${pct(r.amountInr)}%` }}
                  aria-hidden
                />
              ))}
          </div>

          <ul className="mt-5 grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
            {ageing.rows.map((r) => (
              <li key={r.bucket} className="flex items-baseline gap-2.5">
                <span className={`mt-1 size-2 shrink-0 rounded-full ${bucketMeta[r.bucket].bar}`} aria-hidden />
                <span className="text-[0.8125rem] text-ink-muted">{bucketMeta[r.bucket].label}</span>
                <span className="tabular ml-auto text-[0.875rem] font-medium">{inr(r.amountInr)}</span>
                <span className="tabular w-20 shrink-0 whitespace-nowrap text-right text-[0.75rem] text-ink-subtle">
                  {r.invoices} {r.invoices === 1 ? "invoice" : "invoices"}
                </span>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="Collection">
          <dl className="space-y-5">
            {[
              ["Average days to pay", `${ageing.avgDaysToPay} days`, "from issue to full settlement"],
              ["Settled invoices", String(ageing.settledCount), "no balance remaining"],
              ["Oldest arrear", `${invoices[0]?.daysLate ?? 0} days`, invoices[0]?.customerName ?? "–"],
            ].map(([label, value, note]) => (
              <div key={label}>
                <dt className="text-[0.75rem] text-ink-subtle">{label}</dt>
                <dd className="tabular mt-0.5 text-[1.375rem] leading-none tracking-tight">{value}</dd>
                <p className="mt-1 text-[0.75rem] text-ink-subtle">{note}</p>
              </div>
            ))}
          </dl>
        </Panel>
      </div>

      <div className="mt-4">
        <Panel
          title="Invoices"
          action={<span className="text-[0.75rem] text-ink-subtle">Each one links back to where it was raised</span>}
          bodyClassName=""
        >
          <Table head={["Invoice", "Customer", "Order", "Raised in", "Issued", "Due", "Amount", "Received", "Owed", "Status"]}>
            {invoices.map((i) => (
              <Row key={i.number}>
                <Cell className="font-mono text-[0.75rem]">{i.number}</Cell>
                <Cell className="font-medium">{i.customerName}</Cell>
                <Cell className="font-mono text-[0.75rem] text-ink-subtle">{i.orderId ?? "–"}</Cell>
                <Cell><Tag>{sourceLabel[i.source]}</Tag></Cell>
                <Cell className="tabular whitespace-nowrap text-ink-subtle">{dayOf(i.issuedIso)}</Cell>
                <Cell className={`tabular whitespace-nowrap ${i.daysLate > 0 ? "text-magenta" : "text-ink-subtle"}`}>
                  {dayOf(i.dueIso)}
                </Cell>
                <Cell className="tabular">{inr(i.amountInr)}</Cell>
                <Cell className="tabular text-ink-muted">{i.receivedInr ? inr(i.receivedInr) : "–"}</Cell>
                <Cell className={`tabular font-medium ${i.owedInr > 0 ? "" : "text-ink-subtle"}`}>
                  {i.owedInr > 0 ? inr(i.owedInr) : "–"}
                </Cell>
                <Cell><StatusTag invoice={i} /></Cell>
              </Row>
            ))}
          </Table>
        </Panel>
      </div>

      <div className="mt-4">
        <Panel
          title="Payments received"
          action={<span className="text-[0.75rem] text-ink-subtle">Logged by hand as money lands</span>}
          bodyClassName=""
        >
          <Table head={["Received", "Customer", "Against", "Method", "Reference", "Logged by", "Amount", "Balance after"]}>
            {payments.map((p) => (
              <Row key={p.id}>
                <Cell className="tabular whitespace-nowrap">
                  {dayOf(p.receivedIso)}
                  <span className="ml-2 text-ink-subtle">{timeOf(p.receivedIso)}</span>
                </Cell>
                <Cell className="font-medium">{p.customerName}</Cell>
                <Cell className="font-mono text-[0.75rem]">{p.invoiceNumber}</Cell>
                <Cell className="text-ink-muted">{p.method}</Cell>
                <Cell className="font-mono text-[0.75rem] text-ink-subtle">{p.reference ?? "–"}</Cell>
                <Cell className="text-ink-muted">{p.loggedBy}</Cell>
                <Cell className="tabular font-medium text-teal">{inr(p.amountInr)}</Cell>
                <Cell className="tabular">
                  {p.balanceAfterInr > 0 ? (
                    <span className="text-magenta">{inr(p.balanceAfterInr)}</span>
                  ) : (
                    <span className="text-ink-subtle">settled</span>
                  )}
                </Cell>
              </Row>
            ))}
          </Table>
        </Panel>
      </div>
        </>
      )}
    </>
  );
}
