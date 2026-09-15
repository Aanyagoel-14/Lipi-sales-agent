"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/dash/ui";
import { apiFetch } from "@/lib/client";
import type { KnowledgeEntry } from "@/lib/twin-types";

const field =
  "h-10 w-full rounded-full border border-line-strong bg-surface px-4 text-[0.8125rem] placeholder:text-ink-subtle focus-visible:border-violet focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-violet";

/**
 * What the twin may assert.
 *
 * Knowledge starts empty. A plausible default returns window is still a false
 * promise if the operator never confirmed it.
 */
export function KnowledgeStep() {
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    apiFetch("twin/knowledge")
      .then((r) => (r.ok ? r.json() : { knowledge: [] }))
      .then((d: { knowledge: KnowledgeEntry[] }) => setEntries(d.knowledge))
      .catch(() => setEntries([]));

  useEffect(() => { void load(); }, []);

  async function mutate(path: string, init: RequestInit) {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(path, init);
      if (!res.ok) {
        const b = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(b?.error ?? "That did not work");
      }
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h1 className="max-w-[20ch] text-[1.875rem] tracking-tight">What may your twin promise?</h1>
      <p className="mt-2.5 max-w-md text-[0.9375rem] text-ink-muted">
        Add only facts your business has confirmed. Anything written here may be stated to a customer as fact.
      </p>

      <ul className="mt-8 divide-y divide-line/60 rounded-2xl border border-line bg-surface">
        {entries.map((e) => (
          <li key={e.id} className="flex gap-3 px-5 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <Tag tone="violet">{e.kind}</Tag>
                <p className="min-w-0 truncate text-[0.8125rem] font-medium">{e.title}</p>
              </div>
              <p className="mt-1 text-[0.8125rem] text-ink-muted">{e.body}</p>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => mutate(`twin/knowledge/${e.id}`, { method: "DELETE" })}
              className="h-fit cursor-pointer text-[0.75rem] text-ink-subtle hover:text-magenta disabled:opacity-50"
            >
              Remove
            </button>
          </li>
        ))}
        {entries.length === 0 ? (
          <li className="px-5 py-6 text-[0.8125rem] text-ink-subtle">
            Nothing yet. Your twin will decline policy questions until you add something.
          </li>
        ) : null}
      </ul>

      <div className="mt-3 space-y-2.5">
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a fact, e.g. Returns window" className={field} />
        <input value={body} onChange={(e) => setBody(e.target.value)} placeholder="Unworn items can be returned within 14 days…" className={field} />
        <Button size="sm" disabled={busy || title.trim().length < 2 || body.trim().length < 4}
          onClick={() => mutate("twin/knowledge", {
            method: "POST",
            body: JSON.stringify({ kind: "policy", title, body }),
          }).then(() => { setTitle(""); setBody(""); })}>
          Add
        </Button>
      </div>

      {error ? <p role="alert" className="mt-3 text-[0.8125rem] text-magenta">{error}</p> : null}
    </section>
  );
}
