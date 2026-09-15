import { PageHead } from "@/components/dash/ui";
import { apiBaseUrl } from "@/lib/api";
import { apiHeaders } from "@/lib/session";
import { ProductForm, type Template } from "./product-form";

export const metadata = { title: "Add a product · Lipi AI" };

export default async function NewProductPage() {
  const res = await fetch(`${apiBaseUrl}/v1/catalogue/template`, {
    headers: await apiHeaders(),
    cache: "no-store",
  });
  const template = (await res.json()) as Template;

  return (
    <>
      <PageHead
        title="Add a product"
        blurb="Every intersection of the two axes becomes a sellable variant with its own stock. That is what the agents check before promising anything."
      />
      <ProductForm template={template} />
    </>
  );
}
