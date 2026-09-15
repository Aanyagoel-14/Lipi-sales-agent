import { EmptyState, PageHead, Panel, Tag } from "@/components/dash/ui";
import { getProducts, inr, type Product, type Variant } from "@/lib/dash";
import { getWorkspace } from "@/lib/train";

export const metadata = { title: "Inventory · Lipi AI" };

/**
 * Magnitude uses the validated single-hue violet ramp, light to dark.
 * Zero is a status, not a magnitude, so it gets the reserved status colour and
 * its own legend entry rather than a step on the ramp. The number is printed in
 * every cell, so the encoding is never colour-alone.
 *
 * Text colour per band is measured, not guessed: ink reads 12.3 / 8.6 / 4.9 on
 * the first three steps, and white reads 7.0 on the darkest.
 */
function cellStyle(stock: number) {
  if (stock === 0) return "bg-magenta/10 text-magenta";
  if (stock <= 5) return "bg-ramp-1/40 text-ink";
  if (stock <= 14) return "bg-ramp-2/60 text-ink";
  if (stock <= 24) return "bg-ramp-3/80 text-ink";
  return "bg-ramp-4/95 text-white";
}

/** Axes come from the product, so a parts twin reads Fitment x Grade. */
function Matrix({ product }: { product: Product }) {
  const [axisA, axisB] = product.axes;
  const optionsA = [...new Set(product.variants.map((v) => v.optionA))];
  const optionsB = [...new Set(product.variants.map((v) => v.optionB))];
  const at = (optionB: string, optionA: string): Variant | undefined =>
    product.variants.find((v) => v.optionB === optionB && v.optionA === optionA);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[0.8125rem]">
        <caption className="sr-only">
          Stock by {axisA} and {axisB} for {product.name}
        </caption>
        <thead>
          <tr>
            <th scope="col" className="pb-2 pr-4 text-left text-[0.6875rem] font-medium text-ink-subtle">
              {axisB}
            </th>
            {optionsA.map((a) => (
              <th key={a} scope="col" className="whitespace-nowrap px-1 pb-2 text-center text-[0.6875rem] font-medium text-ink-subtle">
                {a}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {optionsB.map((optionB) => (
            <tr key={optionB}>
              <th scope="row" className="whitespace-nowrap py-1 pr-4 text-left font-medium">
                {optionB}
              </th>
              {optionsA.map((optionA) => {
                const v = at(optionB, optionA);
                return (
                  <td key={optionA} className="p-0.5">
                    <span
                      className={`tabular flex h-9 items-center justify-center rounded-md text-[0.75rem] ${
                        v ? cellStyle(v.stock) : "bg-chip/40 text-ink-subtle"
                      }`}
                      title={v ? `${optionA} / ${optionB}: ${v.stock} in stock, ${v.reserved} reserved` : "Not stocked"}
                    >
                      {v ? v.stock : "–"}
                    </span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function InventoryPage() {
  const [data, workspace] = await Promise.all([getProducts(), getWorkspace()]);

  return (
    <>
      <PageHead
        action={
          <div className="flex items-center gap-2">
            {workspace?.catalogueSeeded ? <Tag tone="amber">Sample catalogue</Tag> : null}
            <a
              href="/dashboard/inventory/new"
              className="inline-flex min-h-11 cursor-pointer items-center rounded-full bg-ink px-5 text-[0.875rem] font-medium text-white transition-colors hover:bg-ink/88"
            >
              Add product
            </a>
          </div>
        }
        title="Inventory"
        blurb="Variant-native. Stock lives on the two axes your trade actually sells by, which is what makes a promise like “4 of those by Friday” answerable."
      />

      {data.products.length === 0 ? (
        <EmptyState
          title="No products yet"
          body="Agents can only promise stock that exists, so the twins need a catalogue before they can answer anything about availability."
          action={{ href: "/dashboard/inventory/new", label: "Add your first product" }}
        />
      ) : (
        <>
      <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-2xl border border-line bg-surface px-5 py-3">
        <span className="text-[0.75rem] text-ink-subtle">Units in stock</span>
        {[
          ["bg-magenta/10 border border-magenta/30", "0 (out)"],
          ["bg-ramp-1/40", "1–5"],
          ["bg-ramp-2/60", "6–14"],
          ["bg-ramp-3/80", "15–24"],
          ["bg-ramp-4/95", "25+"],
        ].map(([cls, label]) => (
          <span key={label} className="flex items-center gap-2 text-[0.75rem] text-ink-muted">
            <span className={`size-3.5 rounded ${cls}`} aria-hidden />
            {label}
          </span>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {data.products.map((p) => {
          const supplier = data.suppliers.find((s) => s.id === p.supplierId);
          const total = p.variants.reduce((a, v) => a + v.stock, 0);
          return (
            <Panel
              key={p.id}
              title={p.name}
              action={
                <div className="flex items-center gap-2">
                  <Tag>{p.category}</Tag>
                  <Tag tone={total < 40 ? "amber" : "neutral"}>{total} units</Tag>
                </div>
              }
            >
              <Matrix product={p} />
              <dl className="mt-4 flex flex-wrap gap-x-7 gap-y-2 border-t border-line pt-4">
                {[
                  ["Price", inr(p.priceInr)],
                  ["Margin", `${p.marginPct}%`],
                  ["Lead time", `${p.leadTimeDays}d`],
                  ["Supplier", supplier?.name ?? "–"],
                  ["On-time", supplier ? `${supplier.onTimePct}%` : "–"],
                  ...Object.entries(p.attributes ?? {}),
                ].map(([k, v]) => (
                  <div key={k}>
                    <dt className="text-[0.6875rem] text-ink-subtle">{k}</dt>
                    <dd className="tabular text-[0.8125rem]">{v}</dd>
                  </div>
                ))}
              </dl>
            </Panel>
          );
        })}
      </div>
        </>
      )}
    </>
  );
}
