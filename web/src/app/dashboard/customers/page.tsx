import { Cell, ChannelDot, EmptyState, PageHead, Panel, Row, Table, Tag } from "@/components/dash/ui";
import { channelLabel, channelSlot, getCustomers, inr, num } from "@/lib/dash";

export const metadata = { title: "Customers · Lipi AI" };

export default async function CustomersPage() {
  const data = await getCustomers();

  const sorted = [...data.customers].sort((a, b) => b.lifetimeValueInr - a.lifetimeValueInr);

  return (
    <>
      <PageHead
        title="Customers"
        blurb="One twin per customer, continuously updated by every conversation they have with you."
      />
      {sorted.length === 0 ? (
        <EmptyState
          title="No customers yet"
          body="A customer twin is created the first time someone messages you. Nothing to import by hand."
          action={{ href: "/dashboard/train", label: "Send a test message" }}
        />
      ) : (
      <Panel bodyClassName="">
        <Table head={["Customer", "Channel", "Segment", "Lifetime value", "Orders", "Avg order", "Returns", "Predicted next"]}>
          {sorted.map((c) => (
            <Row key={c.id}>
              <Cell>
                <p className="font-medium">{c.name}</p>
                <p className="font-mono text-[0.6875rem] text-ink-subtle">{c.handle}</p>
              </Cell>
              <Cell><ChannelDot slot={channelSlot[c.channel]} label={channelLabel[c.channel]} /></Cell>
              <Cell className="text-ink-muted">{c.segment}</Cell>
              <Cell className="tabular font-medium">{inr(c.lifetimeValueInr)}</Cell>
              <Cell className="tabular text-ink-muted">{num(c.orders)}</Cell>
              <Cell className="tabular text-ink-muted">{inr(c.avgOrderInr)}</Cell>
              <Cell>
                <Tag tone={c.returnRatePct > 15 ? "magenta" : c.returnRatePct > 8 ? "amber" : "neutral"}>
                  {c.returnRatePct}%
                </Tag>
              </Cell>
              <Cell className="text-ink-muted">{c.predictedNext}</Cell>
            </Row>
          ))}
        </Table>
      </Panel>
      )}
    </>
  );
}
