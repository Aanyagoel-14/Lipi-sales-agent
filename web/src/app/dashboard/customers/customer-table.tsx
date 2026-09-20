"use client";

import { MoreButton, usePaged } from "@/components/dash/paged";
import { Cell, ChannelDot, Row, Table, Tag } from "@/components/dash/ui";
import { channelLabel, channelSlot } from "@/lib/channels";
import { inr, num, type Customer } from "@/lib/dash-types";

export function CustomerTable({ initial, nextCursor }: { initial: Customer[]; nextCursor: string | null }) {
  const { rows, more, busy, error, done } = usePaged("customers", "customers", initial, nextCursor);

  // The API pages by last activity, which is the only order a cursor can walk
  // without skipping a row. Biggest spenders first is what an operator reads,
  // so the loaded rows are sorted here rather than in the query.
  const sorted = [...rows].sort((a, b) => b.lifetimeValueInr - a.lifetimeValueInr);

  return (
    <div className="rounded-2xl border border-line bg-surface">
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
      <MoreButton onClick={more} busy={busy} error={error} done={done} count={rows.length} noun="customer" />
    </div>
  );
}
