"use client";

import { StageAction } from "@/components/dash/actions";
import { MoreButton, usePaged } from "@/components/dash/paged";
import { Cell, ChannelDot, Row, Table, Tag } from "@/components/dash/ui";
import { channelLabel, channelSlot } from "@/lib/channels";
import { dayOf, inr, type Order } from "@/lib/dash-types";

const stageTone = {
  Quoted: "violet", Paid: "teal", Packed: "teal",
  Shipped: "teal", Delivered: "neutral", Returned: "magenta",
} as const;

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
                {o.blocked ? <span className="text-[0.6875rem] text-amber">{o.blocked}</span> : null}
              </div>
            </Cell>
            <Cell className="tabular whitespace-nowrap text-ink-subtle">{dayOf(o.createdIso)}</Cell>
            <Cell className="text-right">
              <StageAction id={o.id} stage={o.stage} />
            </Cell>
          </Row>
        ))}
      </Table>
      <MoreButton onClick={more} busy={busy} error={error} done={done} count={rows.length} noun="order" />
    </div>
  );
}
