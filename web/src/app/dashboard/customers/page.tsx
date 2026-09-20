import { EmptyState, PageHead } from "@/components/dash/ui";
import { getCustomers } from "@/lib/dash";
import { CustomerTable } from "./customer-table";

export const metadata = { title: "Customers · Lipi AI" };

export default async function CustomersPage() {
  const data = await getCustomers();

  return (
    <>
      <PageHead
        title="Customers"
        blurb="One twin per customer, continuously updated by every conversation they have with you."
      />
      {data.customers.length === 0 ? (
        <EmptyState
          title="No customers yet"
          body="A customer twin is created the first time someone messages you. Nothing to import by hand."
          action={{ href: "/dashboard/train", label: "Send a test message" }}
        />
      ) : (
        <CustomerTable initial={data.customers} nextCursor={data.nextCursor} />
      )}
    </>
  );
}
