import { PageHead } from "@/components/dash/ui";
import { getProducts } from "@/lib/dash";
import { ConnectorPanel } from "./connector-panel";

export const metadata = { title: "Inventory connectors · Lipi AI" };

export default async function ConnectorsPage() {
  const { products } = await getProducts();

  // What an operator picks from when mapping a SKU: real catalogue variants,
  // addressed by the id the mapping actually stores.
  const variants = products.flatMap((p) =>
    p.variants.map((v) => ({
      id: v.id,
      label: `${p.name} — ${v.optionA} / ${v.optionB}`,
    })),
  );

  return (
    <>
      <PageHead
        title="Inventory connectors"
        blurb="A CSV import is a snapshot. A connector is what keeps stock current, so the twin refuses to promise units it no longer has."
      />
      <ConnectorPanel variants={variants} />
    </>
  );
}
