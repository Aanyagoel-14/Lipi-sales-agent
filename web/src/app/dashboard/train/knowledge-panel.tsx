"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/dash/ui";
import { apiFetch } from "@/lib/client";
import type { KnowledgeEntry, KnowledgeKind, VoiceExample } from "@/lib/twin-types";

const kinds: KnowledgeKind[] = ["policy", "faq", "sizing", "shipping", "warranty", "pricing"];

export function KnowledgePanel({ entries, examples }: { entries: KnowledgeEntry[]; examples: VoiceExample[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<KnowledgeKind>("policy");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [says, setSays] = useState("");
  const [replies, setReplies] = useState("");

  async function call(path: string, init: RequestInit) {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(path, init);
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const addEntry = () =>
    call("twin/knowledge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, title, body }),
    }).then(() => { setTitle(""); setBody(""); });

  const addExample = () =>
    call("twin/examples", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customerSays: says, twinReplies: replies }),
    }).then(() => { setSays(""); setReplies(""); });

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <section className="rounded-2xl border border-line bg-surface">
        <header className="border-b border-line px-5 py-3">
          <h2 className="text-[0.875rem] font-medium">What the twin may assert</h2>
          <p className="mt-0.5 text-[0.75rem] text-ink-subtle">
            Agents answer from these. Anything not here, they will not claim.
          </p>
        </header>

        <ul className="divide-y divide-line/60">
          {entries.length === 0 ? (
            <li className="px-5 py-6 text-[0.8125rem] text-ink-subtle">
              Nothing taught yet. The twin will decline policy questions until you add something.
            </li>
          ) : null}
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
                onClick={() => call(`twin/knowledge/${e.id}`, { method: "DELETE" })}
                className="h-fit cursor-pointer text-[0.75rem] text-ink-subtle hover:text-magenta disabled:opacity-50"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>

        <div className="space-y-2.5 border-t border-line p-5">
          <div className="flex flex-wrap gap-1.5">
            {kinds.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setKind(k)}
                className={`cursor-pointer rounded-full px-2.5 py-1 font-mono text-[0.6875rem] transition-colors ${
                  kind === k ? "bg-ink text-white" : "bg-chip text-ink-muted hover:text-ink"
                }`}
              >
                {k}
              </button>
            ))}
          </div>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Returns window"
            className={field}
          />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Unworn items can be returned within 14 days…"
            rows={3}
            className={`${field} h-auto rounded-2xl py-2.5`}
          />
          <Button size="sm" onClick={addEntry} disabled={busy || title.trim().length < 2 || body.trim().length < 4}>
            Teach the twin
          </Button>
        </div>
      </section>

      <section className="rounded-2xl border border-line bg-surface">
        <header className="border-b border-line px-5 py-3">
          <h2 className="text-[0.875rem] font-medium">How it should sound</h2>
          <p className="mt-0.5 text-[0.75rem] text-ink-subtle">
            Example pairs. These teach phrasing, never facts.
          </p>
        </header>

        <ul className="divide-y divide-line/60">
          {examples.map((x) => (
            <li key={x.id} className="flex gap-3 px-5 py-3">
              <div className="min-w-0 flex-1 space-y-1.5">
                <p className="w-fit max-w-[90%] rounded-2xl bg-chip px-3 py-1.5 text-[0.8125rem]">{x.customerSays}</p>
                <p className="ml-auto w-fit max-w-[90%] rounded-2xl bg-ink px-3 py-1.5 text-[0.8125rem] text-white">
                  {x.twinReplies}
                </p>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => call(`twin/examples/${x.id}`, { method: "DELETE" })}
                className="h-fit cursor-pointer text-[0.75rem] text-ink-subtle hover:text-magenta disabled:opacity-50"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>

        <div className="space-y-2.5 border-t border-line p-5">
          <input value={says} onChange={(e) => setSays(e.target.value)} placeholder="A customer says…" className={field} />
          <input value={replies} onChange={(e) => setReplies(e.target.value)} placeholder="We would reply…" className={field} />
          <Button size="sm" onClick={addExample} disabled={busy || says.trim().length < 2 || replies.trim().length < 2}>
            Add example
          </Button>
        </div>
      </section>

      {error ? (
        <p role="alert" className="text-[0.8125rem] text-magenta xl:col-span-2">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const field =
  "h-10 w-full rounded-full border border-line-strong bg-surface px-4 text-[0.8125rem] placeholder:text-ink-subtle focus-visible:border-violet focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-violet";
