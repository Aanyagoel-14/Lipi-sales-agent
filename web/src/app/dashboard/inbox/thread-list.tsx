"use client";

import { MoreButton, usePaged } from "@/components/dash/paged";
import { channelLabel, channelSlot } from "@/lib/channels";
import { timeOf, type ConversationSummary } from "@/lib/dash-types";

export function ThreadList({
  initial,
  nextCursor,
  activeId,
}: {
  initial: ConversationSummary[];
  nextCursor: string | null;
  activeId: string;
}) {
  const { rows, more, busy, error, done } = usePaged(
    "conversations", "conversations", initial, nextCursor,
  );

  return (
    <div className="rounded-2xl border border-line bg-surface">
      <div className="border-b border-line px-5 py-3">
        <h2 className="text-[0.875rem] font-medium">All channels</h2>
      </div>
      {/* A list panel, not the page. Fifty rows rendered inline pushed the
          panels below it thousands of pixels down on a phone; it scrolls in
          place instead, at both sizes. */}
      <ul className="max-h-[26rem] divide-y divide-line/60 overflow-y-auto xl:max-h-[34rem]">
        {rows.map((c) => (
          <li
            key={c.id}
            aria-current={c.id === activeId ? "true" : undefined}
            className={`flex gap-3 px-5 py-3 ${c.id === activeId ? "bg-violet-soft/50" : ""}`}
          >
            <span
              className="mt-1.5 size-2 shrink-0 rounded-full"
              style={{ background: `var(--color-series-${channelSlot[c.channel]})` }}
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-baseline gap-2">
                <p className="min-w-0 truncate text-[0.8125rem] font-medium">{c.customer?.name ?? c.customerId}</p>
                <span className="tabular ml-auto shrink-0 text-[0.6875rem] text-ink-subtle">
                  {timeOf(c.lastAtIso)}
                </span>
              </div>
              {/* The preview is the last message, which is all the list loads. */}
              <p className="min-w-0 truncate text-[0.75rem] text-ink-subtle">{c.lastMessage?.text ?? c.subject}</p>
              <p className="mt-1 text-[0.6875rem] text-ink-subtle">
                {channelLabel[c.channel]} · {c.messageCount} message{c.messageCount === 1 ? "" : "s"}
              </p>
            </div>
            {c.unread ? <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-violet" aria-hidden /> : null}
          </li>
        ))}
      </ul>
      <MoreButton onClick={more} busy={busy} error={error} done={done} count={rows.length} noun="thread" />
    </div>
  );
}
