"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { apiJson } from "@/lib/client";
import type { Paged } from "@/lib/dash-types";

/**
 * Appends later pages of a cursor-paged list.
 *
 * The first page is server-rendered, so the table is complete and readable
 * before any JavaScript runs; this only handles the growth. Rows are appended
 * rather than replaced because the cursor is forward-only — there is no page
 * to go back to, only rows already on screen.
 */
export function usePaged<K extends string, T extends { id: string }>(
  path: string,
  key: K,
  initial: T[],
  initialCursor: string | null,
) {
  const [rows, setRows] = useState(initial);
  const [cursor, setCursor] = useState(initialCursor);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function more() {
    if (!cursor || busy) return;
    setBusy(true);
    setError(null);
    try {
      const body = await apiJson<Paged<K, T>>(`${path}?cursor=${encodeURIComponent(cursor)}`);
      const next = body[key] as T[];
      // Guard against a duplicate anchor row rendering twice if a write landed
      // between pages.
      setRows((current) => {
        const seen = new Set(current.map((r) => r.id));
        return [...current, ...next.filter((r) => !seen.has(r.id))];
      });
      setCursor(body.nextCursor);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return { rows, more, busy, error, done: cursor === null };
}

export function MoreButton({
  onClick,
  busy,
  error,
  done,
  count,
  noun,
}: {
  onClick: () => void;
  busy: boolean;
  error: string | null;
  done: boolean;
  count: number;
  noun: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-line px-5 py-3.5">
      <p aria-live="polite" className="text-[0.75rem] text-ink-subtle">
        {count} {count === 1 ? noun : `${noun}s`} loaded{done ? "" : ", more available"}
      </p>
      {done ? null : (
        <Button variant="secondary" size="sm" chevron={false} disabled={busy} onClick={onClick} className="ml-auto">
          {busy ? "Loading…" : "Load more"}
        </Button>
      )}
      {error ? (
        <p role="alert" className="text-[0.75rem] text-magenta">
          {error}
        </p>
      ) : null}
    </div>
  );
}
