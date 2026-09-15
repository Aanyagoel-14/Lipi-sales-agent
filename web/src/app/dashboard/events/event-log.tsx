"use client";

import { MoreButton, usePaged } from "@/components/dash/paged";
import { timeOf, type TwinEvent } from "@/lib/dash-types";

export function EventLog({ initial, nextCursor }: { initial: TwinEvent[]; nextCursor: string | null }) {
  const { rows, more, busy, error, done } = usePaged("events", "events", initial, nextCursor);

  return (
    <div className="rounded-2xl border border-line bg-surface">
      <div className="overflow-x-auto p-5">
        <table className="w-full font-mono text-[0.75rem]">
          <caption className="sr-only">Twin events, newest first</caption>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id} className="align-top">
                <td className="tabular whitespace-nowrap py-1.5 pr-4 text-ink-subtle">{timeOf(e.atIso)}</td>
                <td className="whitespace-nowrap py-1.5 pr-4 text-ink-subtle">{e.twin}</td>
                <td className="whitespace-nowrap py-1.5 pr-4 text-violet-ink">{e.type}</td>
                <td className="py-1.5 text-ink-muted">{e.payload}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <MoreButton onClick={more} busy={busy} error={error} done={done} count={rows.length} noun="event" />
    </div>
  );
}
