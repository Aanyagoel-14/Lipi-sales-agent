import { ReplyBox } from "@/components/dash/actions";
import { EmptyState, PageHead, Panel, Tag } from "@/components/dash/ui";
import { channelLabel, getConversation, getConversations, inr, timeOf, type QuoteCard } from "@/lib/dash";
import type { DeliveryState } from "@/lib/dash-types";
import { ThreadList } from "./thread-list";

export const metadata = { title: "Inbox · Lipi AI" };

/**
 * A quote is data the Sales Agent produced from the twins, not a sentence it
 * wrote. Rendering it as a card keeps the bubble short and keeps the figures
 * scannable and aligned.
 */
function QuoteAttachment({ quote }: { quote: QuoteCard }) {
  return (
    <div className="w-full max-w-[22rem] rounded-xl border border-line bg-surface p-3.5">
      <div className="flex items-baseline gap-2">
        <p className="text-[0.8125rem] font-medium">{quote.product}</p>
        <p className="text-[0.75rem] text-ink-subtle">{quote.variant}</p>
        <span className="ml-auto"><Tag tone="violet">quote</Tag></span>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-y-2">
        {[
          ["Quantity", String(quote.qty)],
          ["Unit price", inr(quote.unitInr)],
          ["Dispatch", quote.dispatch],
          ["Delivery", quote.eta],
        ].map(([k, v]) => (
          <div key={k}>
            <dt className="text-[0.6875rem] text-ink-subtle">{k}</dt>
            <dd className="tabular text-[0.8125rem]">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-3 flex items-baseline border-t border-line pt-2.5">
        <span className="text-[0.75rem] text-ink-muted">Total</span>
        <span className="tabular ml-auto text-[0.9375rem] font-medium">{inr(quote.totalInr)}</span>
      </div>
    </div>
  );
}

/**
 * What became of an agent message. A drafted reply used to look exactly like
 * a delivered one here, which is the one thing a shared inbox must not do:
 * an operator reading the thread has no other way to know the customer never
 * saw it. `sent` is left unlabelled — that is the expected case, and marking
 * it would put a badge on every line.
 */
const DELIVERY: Record<Exclude<DeliveryState, "sent">, string> = {
  pending: "sending…",
  failed: "not delivered",
  held: "awaiting approval",
};

export default async function InboxPage() {
  const data = await getConversations();

  // May be empty: a new workspace has had no conversations yet.
  const summary = data.conversations[0];
  // The list carries previews only, so the open thread is fetched by id. One
  // thread's messages, not every thread's.
  const active = summary ? (await getConversation(summary.id)).conversation : null;

  return (
    <>
      <PageHead
        title="Inbox"
        blurb="Every channel in one thread list. The twin panel updates as the conversation does."
      />

      {!active ? (
        <EmptyState
          title="No conversations yet"
          body="Once a channel is connected, every message your customers send lands here and updates the twins. You can try the loop now without waiting for a real message."
          action={{ href: "/dashboard/train", label: "Send a test message" }}
        />
      ) : (
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[20rem_1fr_18rem]">
        {/* Stacked, the list would sit above the thread it selects, so reading
            one message means scrolling past fifty. The panes keep their visual
            order at xl and invert below it. */}
        <div className="order-2 xl:order-none">
          <ThreadList
            initial={data.conversations}
            nextCursor={data.nextCursor}
            activeId={active.id}
          />
        </div>

        <div className="order-1 space-y-4 xl:order-none">
          <Panel
            title={`${active.customer?.name ?? active.customerId} · ${channelLabel[active.channel]}`}
            action={<Tag tone="violet">{active.intent}</Tag>}
          >
            <div className="space-y-4">
              {active.messages.map((m, i) => {
                const agent = m.from === "agent";
                return (
                  <div key={i} className={`flex flex-col gap-1.5 ${agent ? "items-end" : "items-start"}`}>
                    <p
                      className={`w-fit max-w-[34ch] rounded-2xl px-3.5 py-2 text-[0.8125rem] leading-relaxed ${
                        agent ? "bg-ink text-white" : "bg-chip text-ink"
                      }`}
                    >
                      {m.text}
                    </p>

                    {m.quote ? <QuoteAttachment quote={m.quote} /> : null}

                    <p className="tabular text-[0.6875rem] text-ink-subtle">
                      {agent ? "Sales Agent" : active.customer?.name} · {timeOf(m.atIso)}
                      {m.delivery && m.delivery !== "sent" ? (
                        <>
                          {" · "}
                          <span
                            className={m.delivery === "failed" ? "text-magenta" : undefined}
                            title={m.deliveryError ?? undefined}
                          >
                            {DELIVERY[m.delivery]}
                          </span>
                        </>
                      ) : null}
                    </p>
                  </div>
                );
              })}
            </div>
            <ReplyBox conversationId={active.id} />
          </Panel>

          <Panel title="Extracted by the conversation intelligence layer">
            <div className="flex flex-wrap gap-1.5">
              {active.signals.map((s) => (
                <Tag key={s.label} tone={s.tone}>
                  {s.label}
                </Tag>
              ))}
            </div>
          </Panel>
        </div>

        <Panel title="Customer Twin" bodyClassName="" className="order-3 xl:order-none">
          {active.customer ? (
            <div className="divide-y divide-line/60">
              <dl className="grid grid-cols-2 gap-y-3 px-5 py-4">
                {[
                  ["Segment", active.customer.segment],
                  ["Lifetime value", inr(active.customer.lifetimeValueInr)],
                  ["Orders", String(active.customer.orders)],
                  ["Return rate", `${active.customer.returnRatePct}%`],
                  ["Price sensitivity", active.customer.priceSensitivity],
                  ["Style", active.customer.negotiationStyle],
                ].map(([k, v]) => (
                  <div key={k}>
                    <dt className="text-[0.6875rem] text-ink-subtle">{k}</dt>
                    <dd className="tabular text-[0.8125rem]">{v}</dd>
                  </div>
                ))}
              </dl>
              <div className="px-5 py-4">
                <p className="mb-2 text-[0.6875rem] text-ink-subtle">Size profile</p>
                <div className="flex flex-wrap gap-1.5">
                  {active.customer.sizeProfile.map((s) => (
                    <Tag key={s} tone="violet">{s}</Tag>
                  ))}
                </div>
              </div>
              <div className="px-5 py-4">
                <p className="text-[0.6875rem] text-ink-subtle">Predicted next purchase</p>
                <p className="mt-0.5 text-[0.8125rem]">{active.customer.predictedNext}</p>
              </div>
            </div>
          ) : null}
        </Panel>
      </div>
      )}
    </>
  );
}
