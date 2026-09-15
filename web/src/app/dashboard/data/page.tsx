import { DataOnboarding } from "@/components/data-onboarding";
import { PageHead } from "@/components/dash/ui";
import { getProducts } from "@/lib/dash";

export const metadata = { title: "Data onboarding · Lipi AI" };

export default async function DataPage() {
  const { products } = await getProducts();
  return (
    <>
      <PageHead
        title="Data onboarding"
        blurb="Build the product and inventory twin from your real catalogue. Imported data is validated before it becomes available to agents."
      />
      <DataOnboarding initialProducts={products.length} />
    </>
  );
}
