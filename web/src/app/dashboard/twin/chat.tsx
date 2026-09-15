"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/dash/markdown";
import { Tag } from "@/components/dash/ui";
import { apiJson } from "@/lib/client";

type Turn = { role: "user" | "assistant"; content: string };

type ChatResponse = {
  reply: string;
  source: "openrouter" | "rules";
  model: string | null;
  facts: {
    products: number;
    unitsAvailable: number;
    lowStock: number;
    openOrders: number;
    pipelineInr: number;
    pendingApprovals: number;
  };
  degraded?: string;
};

const SUGGESTIONS = [
  "What is running low and what should I reorder first?",
  "Which orders are still open, and what are they worth?",
  "Which variant is my slowest mover?",
  "Anything waiting on my approval?",
];

/**
 * The operator's side of the twin.
 *
 * The thread lives here rather than on the server: the API grounds every turn
 * in a fresh read of the business, so the useful history is the questions, not
 * the answers. It also means asking the twin something never lands in the
 * tables the dashboard reports customer activity from.
 */
export function TwinChat() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<ChatResponse | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns, busy]);

  async function send(question: string) {
    const asked = question.trim();
    if (!asked || busy) return;

    const next: Turn[] = [...turns, { role: "user", content: asked }];
    setTurns(next);
    setText("");
    setBusy(true);
    setError(null);

    try {
      const res = await apiJson<ChatResponse>("twin/chat", {
        method: "POST",
        body: JSON.stringify({ messages: next }),
      });
      setMeta(res);
      setTurns([...next, { role: "assistant", content: res.reply }]);
    } catch (e) {
      // The question stays on screen so it can be retried without retyping.
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex min-h-[32rem] flex-col rounded-2xl border border-line bg-surface">
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3">
        <h2 className="text-[0.875rem] font-medium">Ask the twin</h2>
        {meta ? (
          <>
            <Tag tone={meta.source === "openrouter" ? "violet" : "amber"}>
              {meta.source === "openrouter" ? (meta.model ?? "model") : "snapshot only"}
            </Tag>
            <span className="ml-auto text-[0.75rem] text-ink-subtle">
              {meta.facts.unitsAvailable.toLocaleString("en-IN")} units · {meta.facts.lowStock} low ·{" "}
              {meta.facts.openOrders} open orders · ₹{meta.facts.pipelineInr.toLocaleString("en-IN")}
            </span>
          </>
        ) : (
          <span className="ml-auto text-[0.75rem] text-ink-subtle">Grounded in your live stock and orders</span>
        )}
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto p-5">
        {!turns.length ? (
          <div className="space-y-3">
            <p className="text-[0.8125rem] text-ink-muted">
              It reads your catalogue, stock levels, orders, customers and taught policies before every answer. It
              cannot change anything from here.
            </p>
            <div className="flex flex-wrap gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  className="cursor-pointer rounded-full bg-chip px-3.5 py-2 text-left text-[0.8125rem] text-ink-muted transition-colors hover:bg-chip-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {turns.map((turn, i) => (
          <div key={i} className={turn.role === "user" ? "flex justify-end" : ""}>
            <div
              className={`max-w-[40rem] rounded-2xl px-3.5 py-2.5 text-[0.8125rem] leading-relaxed ${
                turn.role === "user" ? "bg-ink text-white" : "bg-chip text-ink"
              }`}
            >
              {turn.role === "user" ? (
                <p className="whitespace-pre-line">{turn.content}</p>
              ) : (
                <Markdown>{turn.content}</Markdown>
              )}
            </div>
          </div>
        ))}

        {busy ? <p className="text-[0.8125rem] text-ink-subtle">Reading your business…</p> : null}
        {error ? (
          <p role="alert" className="text-[0.8125rem] text-magenta">
            {error}
          </p>
        ) : null}
        {meta?.degraded ? (
          <p className="text-[0.75rem] text-amber">
            The model was unreachable, so that answer came straight from the snapshot ({meta.degraded}).
          </p>
        ) : null}
        <div ref={endRef} />
      </div>

      <div className="flex flex-col gap-2 border-t border-line p-4 sm:flex-row">
        <label className="sr-only" htmlFor="twin-question">
          Ask your twin about the business
        </label>
        <input
          id="twin-question"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(text);
            }
          }}
          placeholder="How many cobalt XL do I have left?"
          className="h-11 w-full rounded-full sm:flex-1 border border-line-strong bg-surface px-5 text-[0.875rem] focus-visible:border-violet focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-violet"
        />
        <Button onClick={() => send(text)} disabled={busy || text.trim().length < 2}>
          {busy ? "Thinking…" : "Ask"}
        </Button>
      </div>
    </section>
  );
}
