"use client";

import Link from "next/link";
import { MoreButton, usePaged } from "@/components/dash/paged";
import { channelLabel, channelSlot } from "@/lib/channels";
import { timeOf, type ConversationSummary } from "@/lib/dash-types";

/**
 * The channel rail and the thread list — the left pane of the PRD's
 * split-pane workspace (§7.1).
 *
 * Two things were wrong here and both were the same kind of wrong: the rows
 * were inert `<li>`s and the page always rendered `conversations[0]`, so the
 * list looked like a selector and selected nothing. A keyboard user could not
 * reach a second thread at all.
 *
 * Selection is a link and a search parameter rather than client state,
 * deliberately. The thread's messages are fetched on the server by id — the
 * list carries previews only — so selecting one is a navigation, and a
 * navigation is what gives it a URL an operator can send to a colleague, a
 * back button that works, and rows that are real links for anything that
 * reads the page rather than looks at it.
 */

type Props = {
  initial: ConversationSummary[];
  nextCursor: string | null;
  activeId: string;
  /** The channel currently filtered to, or null for all of them. */
  channel: string | null;
  /** Channels this workspace has actually had a conversation on. */
  channels: string[];
};

const hrefFor = (params: { thread?: string; channel?: string | null }) => {
  const search = new URLSearchParams();
  if (params.channel) search.set("channel", params.channel);
  if (params.thread) search.set("thread", params.thread);
  return search.size ? `/dashboard/inbox?${search}` : "/dashboard/inbox";
};

export function ThreadList({ initial, nextCursor, activeId, channel, channels }: Props) {
  // Re-keyed on the filter so switching channels starts a fresh page rather
  // than appending the new feed to the old one's rows.
  const { rows, more, busy, error, done } = usePaged(
    "conversations",
    "conversations",
    initial,
    nextCursor,
    channel ? { channel } : undefined,
  );

  return (
    <div className="rounded-2xl border border-line bg-surface">
      <div className="border-b border-line px-5 py-3">
        <h2 className="text-[0.875rem] font-medium">
          {channel ? channelLabel[channel as keyof typeof channelLabel] : "All channels"}
        </h2>

        {/* The rail. Only channels this workspace has actually heard from —
            offering a filter that can only ever return nothing is a control
            that teaches an operator to distrust the others. */}
        {channels.length > 1 ? (
          <nav className="mt-2.5 flex flex-wrap gap-1.5" aria-label="Filter by channel">
            <FilterChip href={hrefFor({})} active={!channel} label="All" />
            {channels.map((name) => (
              <FilterChip
                key={name}
                href={hrefFor({ channel: name })}
                active={channel === name}
                label={channelLabel[name as keyof typeof channelLabel] ?? name}
                slot={channelSlot[name as keyof typeof channelSlot]}
              />
            ))}
          </nav>
        ) : null}
      </div>

      {/* A list panel, not the page. Fifty rows rendered inline pushed the
          panels below it thousands of pixels down on a phone; it scrolls in
          place instead, at both sizes. */}
      <ul className="max-h-[26rem] divide-y divide-line/60 overflow-y-auto xl:max-h-[34rem]">
        {rows.map((c) => {
          const active = c.id === activeId;
          return (
            <li key={c.id} aria-current={active ? "true" : undefined}>
              <Link
                href={hrefFor({ thread: c.id, channel })}
                // `scroll: false` because below xl the transcript sits *above*
                // this list, and jumping to the top of the document on every
                // selection would put the thread off screen.
                scroll={false}
                className={`flex w-full gap-3 px-5 py-3 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-violet ${
                  active ? "bg-violet-soft/50" : "hover:bg-chip"
                }`}
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
              </Link>
            </li>
          );
        })}
      </ul>
      <MoreButton onClick={more} busy={busy} error={error} done={done} count={rows.length} noun="thread" />
    </div>
  );
}

function FilterChip({
  href,
  active,
  label,
  slot,
}: {
  href: string;
  active: boolean;
  label: string;
  slot?: number;
}) {
  return (
    <Link
      href={href}
      scroll={false}
      aria-current={active ? "true" : undefined}
      className={`inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-[0.75rem] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet ${
        active ? "bg-ink text-white" : "bg-chip text-ink-muted hover:bg-chip-hover"
      }`}
    >
      {slot ? (
        <span
          className="size-1.5 rounded-full"
          style={{ background: active ? "currentColor" : `var(--color-series-${slot})` }}
          aria-hidden
        />
      ) : null}
      {label}
    </Link>
  );
}
