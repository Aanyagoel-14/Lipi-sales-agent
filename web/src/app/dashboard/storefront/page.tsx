import { PageHead } from "@/components/dash/ui";
import { Storefront } from "./storefront";

export const metadata = { title: "Storefront · Lipi AI" };

export default function StorefrontPage() {
  return (
    <>
      <PageHead
        title="Storefront"
        blurb="The customer's side of the twin, so you can buy from your own business. It runs the same loop a WhatsApp message runs — real stock, real orders, real invoices — so what you see here is what a customer would get."
      />
      <Storefront />
    </>
  );
}
