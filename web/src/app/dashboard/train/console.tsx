"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/dash/ui";
import { apiFetch } from "@/lib/client";

type Result = {
  reply: string;
  replySent: boolean;
  extracted: Record<string, unknown> & { extractor: string };
  matched: { product: string; variant: string } | null;
  knowledgeUsed: { title: string; kind: string } | null;
  voiceViolations: string[];
  agentRuns: { agent: string; action: string; status: string }[];
  events: { type: string; payload: string }[];
};

/**
 * Exercises the real ingest loop inside a rolled-back transaction. The reply,
 * actions and events are real evaluation output; no test customer, order,
 * reservation or metric leaks into the operational dashboard.
 */
export function TestConsole() {
  const [text, setText] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("twin/test", {
        method: "POST",
        body: JSON.stringify({ channel: "webchat", handle: "console@lipi.test", name: "Console test", text }),
      });
      if (!res.ok) throw new Error(`Ingest failed (${res.status})`);
      setResult((await res.json()) as Result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border border-line bg-surface">
      <header className="border-b border-line px-5 py-3">
        <h2 className="text-[0.875rem] font-medium">Try a message</h2>
        <p className="mt-0.5 text-[0.75rem] text-ink-subtle">
          This runs the production loop against your real state, then rolls back every test change.
        </p>
      </header>

      <div className="space-y-3 p-5">
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") run(); }}
            placeholder="Ask the Twin something a real customer would ask"
            className="h-11 w-full rounded-full sm:flex-1 border border-line-strong bg-surface px-5 text-[0.875rem] focus-visible:border-violet focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-violet"
          />
          <Button onClick={run} disabled={busy || text.trim().length < 2}>
            {busy ? "Running…" : "Send"}
          </Button>
        </div>

        {error ? <p role="alert" className="text-[0.8125rem] text-magenta">{error}</p> : null}

        {result ? (
          <div className="space-y-4 pt-2">
            <div>
              <p className="mb-1.5 text-[0.75rem] text-ink-subtle">The twin replied</p>
              <p className="w-fit max-w-[36rem] whitespace-pre-line rounded-2xl bg-ink px-3.5 py-2.5 text-[0.8125rem] leading-relaxed text-white">
                {result.reply}
              </p>
              {!result.replySent ? (
                <p className="mt-2 text-[0.75rem] text-amber">
                  Held for approval, not sent. Your policy requires a human first.
                </p>
              ) : null}
              {result.voiceViolations.length ? (
                <p className="mt-2 text-[0.75rem] text-magenta">
                  Used a banned phrase: {result.voiceViolations.join(", ")}
                </p>
              ) : null}
            </div>

            <div className="flex flex-wrap gap-1.5">
              {Object.entries(result.extracted)
                .filter(([, v]) => v !== null && v !== undefined)
                .map(([k, v]) => (
                  <Tag key={k} tone={k === "extractor" ? "teal" : "neutral"}>
                    {k}: {String(v)}
                  </Tag>
                ))}
              {result.matched ? <Tag tone="violet">matched: {result.matched.variant}</Tag> : null}
              {result.knowledgeUsed ? <Tag tone="violet">knowledge: {result.knowledgeUsed.title}</Tag> : null}
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <p className="mb-2 text-[0.75rem] text-ink-subtle">Agents</p>
                <ul className="space-y-1.5">
                  {result.agentRuns.map((r) => (
                    <li key={r.agent + r.action} className="text-[0.8125rem]">
                      <span className="font-medium">{r.agent}</span>
                      <span className="text-ink-muted"> · {r.action}</span>
                      {r.status === "needs_approval" ? <Tag tone="amber">held</Tag> : null}
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="mb-2 text-[0.75rem] text-ink-subtle">Twin events written</p>
                <ul className="space-y-1 font-mono text-[0.6875rem]">
                  {result.events.map((e, i) => (
                    <li key={i} className="truncate">
                      <span className="text-violet-ink">{e.type}</span>{" "}
                      <span className="text-ink-muted">{e.payload}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
