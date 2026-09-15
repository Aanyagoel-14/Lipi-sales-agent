import { EmptyState, PageHead } from "@/components/dash/ui";
import { getOrders } from "@/lib/dash";
import { OrderTable } from "./order-table";

export const metadata = { title: "Orders · Lipi AI" };

export default async function OrdersPage() {
  const data = await getOrders();

  return (
    <>
      <PageHead
        title="Orders"
        blurb="One object per order, from the first message through to delivery or return."
      />
      {data.orders.length === 0 ? (
        <EmptyState
          title="No orders yet"
          body="Orders are created by the agents when a customer asks to buy something that is in stock."
          action={{ href: "/dashboard/inventory", label: "Check your stock" }}
        />
      ) : (
        <OrderTable initial={data.orders} nextCursor={data.nextCursor} />
      )}
    </>
  );
}
