"use client";

import { OrderActions } from "@/components/dash/actions";
import { MoreButton, usePaged } from "@/components/dash/paged";
import { Cell, ChannelDot, Row, Table, Tag } from "@/components/dash/ui";
import { channelLabel, channelSlot } from "@/lib/channels";
import { dayOf, inr, type Order } from "@/lib/dash-types";

const stageTone = {
  Inquiry: "neutral", Quoted: "violet", Confirmed: "violet", Paid: "teal", Packed: "teal",
  Shipped: "teal", Delivered: "neutral", Returned: "magenta", Cancelled: "neutral",
} as const;

const timeOf = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });

/** Money first, then stock: the two things an operator wants to know about an order at a glance. */
function paymentLine(o: Order) {
  switch (o.payment) {
    case "paid": return `Paid ${inr(o.paidInr)}`;
    case "partly_paid": return `Paid ${inr(o.paidInr)} of ${inr(o.valueInr)}`;
    case "on_terms": return o.dueIso ? `On terms · due ${dayOf(o.dueIso)}` : "On terms";
    default: return o.invoiceNumber ? `Unpaid · ${o.invoiceNumber}` : "Unpaid";
  }
}

function stockLine(o: Order) {
  switch (o.stock) {
    case "reserved": return `${o.qty} reserved`;
    case "held": return o.reservedUntilIso ? `${o.qty} held until ${timeOf(o.reservedUntilIso)}` : `${o.qty} held`;
    case "shipped": return "Shipped out";
    case "released": return "Stock released";
    default: return "Nothing held yet";
  }
}

export function OrderTable({ initial, nextCursor }: { initial: Order[]; nextCursor: string | null }) {
  const { rows, more, busy, error, done } = usePaged("orders", "orders", initial, nextCursor);

  return (
    <div className="rounded-2xl border border-line bg-surface">
      <Table head={["Order", "Customer", "Product", "Variant", "Qty", "Value", "Channel", "Stage", "Created", ""]}>
        {rows.map((o) => (
          <Row key={o.id}>
            <Cell className="font-mono text-[0.75rem]">{o.id}</Cell>
            <Cell className="font-medium">{o.customerName}</Cell>
            <Cell className="text-ink-muted">{o.productName}</Cell>
            <Cell className="text-ink-muted">{o.variant}</Cell>
            <Cell className="tabular">{o.qty}</Cell>
            <Cell className="tabular font-medium">{inr(o.valueInr)}</Cell>
            <Cell><ChannelDot slot={channelSlot[o.channel]} label={channelLabel[o.channel]} /></Cell>
            <Cell>
              <div className="flex flex-col items-start gap-1">
                <Tag tone={stageTone[o.stage]}>{o.stage}</Tag>
                <span className={`text-[0.6875rem] ${o.payment === "paid" ? "text-teal" : "text-ink-muted"}`}>{paymentLine(o)}</span>
                <span className="text-[0.6875rem] text-ink-subtle">{stockLine(o)}</span>
                {o.blocked ? <span className="text-[0.6875rem] text-amber">{o.blocked}</span> : null}
              </div>
            </Cell>
            <Cell className="tabular whitespace-nowrap text-ink-subtle">{dayOf(o.createdIso)}</Cell>
            <Cell className="text-right">
              <OrderActions order={o} />
            </Cell>
          </Row>
        ))}
      </Table>
      <MoreButton onClick={more} busy={busy} error={error} done={done} count={rows.length} noun="order" />
    </div>
  );
}
