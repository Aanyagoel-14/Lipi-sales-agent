"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/dash/markdown";
import { Tag } from "@/components/dash/ui";
import { apiFetch, apiJson } from "@/lib/client";

type Turn = { role: "user" | "assistant"; content: string };

type SellResponse = {
  reply: string;
  voicedBy: "openrouter" | "template";
  conversationId: string;
  customer: { id: string; name: string; isNew: boolean };
  matched: { product: string; variant: string } | null;
  order: { id: string; valueInr: number; stage: string } | null;
  invoice: { number: string; amountInr: number; dueIso: string; url: string } | null;
  intent: string;
  held: boolean;
  degraded?: string;
};

const OPENERS = [
  "What do you have in stock?",
  "I need 2 blue XL polos",
  "How much for 50 units?",
  "Can you send me the invoice?",
];

/**
 * The customer's side of the twin, on the operator's own dashboard.
 *
 * This is not a simulation. It runs the same loop a WhatsApp message runs, so
 * a purchase here reserves real stock, creates a real order and raises a real
 * invoice. That is the point: a sandbox that reserved nothing would prove
 * nothing about whether the twin can actually sell.
 */
export function Storefront() {
  const [name, setName] = useState("Ravi Menon");
  const [handle, setHandle] = useState("+91 98 111 2233");
  const [identityLocked, setLocked] = useState(false);

  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<SellResponse | null>(null);
  const [orders, setOrders] = useState<SellResponse[]>([]);
  const [downloading, setDownloading] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns, busy]);

  async function send(message: string) {
    const said = message.trim();
    if (!said || busy) return;

    const next: Turn[] = [...turns, { role: "user", content: said }];
    setTurns(next);
    setText("");
    setBusy(true);
    setError(null);
    setLocked(true);

    try {
      const res = await apiJson<SellResponse>("twin/sell", {
        method: "POST",
        // History excludes the message being sent; the API appends it.
        body: JSON.stringify({ text: said, handle, name, channel: "webchat", history: turns.slice(-10) }),
      });
      setLast(res);
      setTurns([...next, { role: "assistant", content: res.reply }]);
      if (res.order) setOrders((prev) => [res, ...prev.filter((o) => o.order?.id !== res.order?.id)]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Fetched rather than linked. A plain link to the API origin drops the
   * session cookie once the two are on different domains, and the customer
   * gets a 401 where they expected their invoice.
   */
  async function downloadInvoice(url: string, number: string) {
    setDownloading(number);
    setError(null);
    try {
      const res = await apiFetch(url.replace(/^\/v1\//, ""));
      if (!res.ok) throw new Error(`Could not fetch invoice (${res.status})`);

      const blobUrl = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = `${number}.pdf`;
      a.click();
      URL.revokeObjectURL(blobUrl);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDownloading(null);
    }
  }

  function reset() {
    setTurns([]);
    setLast(null);
    setOrders([]);
    setLocked(false);
    setError(null);
  }

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_20rem]">
      <section className="flex min-h-[34rem] flex-col rounded-2xl border border-line bg-surface">
        <header className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3">
          <h2 className="text-[0.875rem] font-medium">Storefront chat</h2>
          {last ? (
            <Tag tone={last.voicedBy === "openrouter" ? "violet" : "amber"}>
              {last.voicedBy === "openrouter" ? "spoken by the model" : "composed reply"}
            </Tag>
          ) : null}
          {turns.length ? (
            <button
              onClick={reset}
              className="ml-auto cursor-pointer text-[0.75rem] text-ink-muted underline-offset-2 hover:text-ink hover:underline"
            >
              New customer
            </button>
          ) : null}
        </header>

        <div className="grid grid-cols-1 gap-3 border-b border-line px-5 py-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-[0.75rem] text-ink-subtle">Customer name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={identityLocked}
              className="h-10 w-full rounded-lg border border-line-strong bg-surface px-3 text-[0.8125rem] disabled:opacity-60 focus-visible:border-violet focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-violet"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[0.75rem] text-ink-subtle">Phone or handle</span>
            <input
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              disabled={identityLocked}
              className="h-10 w-full rounded-lg border border-line-strong bg-surface px-3 text-[0.8125rem] disabled:opacity-60 focus-visible:border-violet focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-violet"
            />
          </label>
          {identityLocked ? (
            <p className="text-[0.6875rem] text-ink-subtle sm:col-span-2">
              Locked for this conversation — the handle is what identifies the customer twin. Start a new customer to
              change it.
            </p>
          ) : null}
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          {!turns.length ? (
            <div className="space-y-3">
              <p className="text-[0.8125rem] text-ink-muted">
                Talk to the twin the way a customer would. It sells from your real catalogue, so anything bought here
                reserves real stock and appears in Orders.
              </p>
              <div className="flex flex-wrap gap-2">
                {OPENERS.map((o) => (
                  <button
                    key={o}
                    onClick={() => send(o)}
                    className="cursor-pointer rounded-full bg-chip px-3.5 py-2 text-[0.8125rem] text-ink-muted transition-colors hover:bg-chip-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet"
                  >
                    {o}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {turns.map((turn, i) => (
            <div key={i} className={turn.role === "user" ? "flex justify-end" : ""}>
              <div
                className={`max-w-[34rem] rounded-2xl px-3.5 py-2.5 text-[0.8125rem] leading-relaxed ${
                  turn.role === "user" ? "bg-violet text-white" : "bg-chip text-ink"
                }`}
              >
                {/* What the customer typed is text; what the twin says is markdown. */}
                {turn.role === "user" ? (
                  <p className="whitespace-pre-line">{turn.content}</p>
                ) : (
                  <Markdown>{turn.content}</Markdown>
                )}
              </div>
            </div>
          ))}

          {busy ? <p className="text-[0.8125rem] text-ink-subtle">The twin is checking stock…</p> : null}
          {error ? (
            <p role="alert" className="text-[0.8125rem] text-magenta">
              {error}
            </p>
          ) : null}
          {last?.held ? (
            <p className="text-[0.75rem] text-amber">
              Your approval policy holds every reply, so a real customer would not have received that yet.
            </p>
          ) : null}
          {last?.degraded ? (
            <p className="text-[0.75rem] text-amber">
              Answered from the composed reply — {last.degraded}
            </p>
          ) : null}
          <div ref={endRef} />
        </div>

        <div className="flex flex-col gap-2 border-t border-line p-4 sm:flex-row">
          <label className="sr-only" htmlFor="customer-message">
            Message the twin as a customer
          </label>
          <input
            id="customer-message"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(text);
              }
            }}
            placeholder="I need 2 blue XL polos"
            className="h-11 w-full rounded-full sm:flex-1 border border-line-strong bg-surface px-5 text-[0.875rem] focus-visible:border-violet focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-violet"
          />
          <Button onClick={() => send(text)} disabled={busy || text.trim().length < 2 || !handle.trim()}>
            {busy ? "Sending…" : "Send"}
          </Button>
        </div>
      </section>

      {/* ------------------------------------------------ what the chat did */}
      <aside className="space-y-4">
        <section className="rounded-2xl border border-line bg-surface p-5">
          <h2 className="mb-3 text-[0.875rem] font-medium">What the twin did</h2>
          {last ? (
            <dl className="space-y-2 text-[0.8125rem]">
              <div className="flex justify-between gap-3">
                <dt className="text-ink-subtle">Read as</dt>
                <dd className="font-mono text-[0.75rem]">{last.intent}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-ink-subtle">Matched</dt>
                <dd className="text-right">{last.matched ? last.matched.variant : "nothing"}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-ink-subtle">Customer</dt>
                <dd className="text-right">
                  {last.customer.name}
                  {last.customer.isNew ? <Tag tone="teal">new</Tag> : null}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="text-[0.8125rem] text-ink-subtle">Send a message to see what the twin extracted.</p>
          )}
        </section>

        <section className="rounded-2xl border border-line bg-surface p-5">
          <h2 className="mb-3 text-[0.875rem] font-medium">Orders placed here</h2>
          {!orders.length ? (
            <p className="text-[0.8125rem] text-ink-subtle">
              Nothing bought yet. Ask for a quantity of something you stock.
            </p>
          ) : (
            <ul className="space-y-3">
              {orders.map((o) => (
                <li key={o.order!.id} className="rounded-xl bg-chip p-3">
                  <p className="font-mono text-[0.6875rem] text-ink-muted">{o.order!.id}</p>
                  <p className="mt-1 text-[0.8125rem]">
                    {o.matched?.product} · {o.matched?.variant}
                  </p>
                  <p className="mt-0.5 text-[0.875rem] font-medium">₹{o.order!.valueInr.toLocaleString("en-IN")}</p>
                  {o.invoice ? (
                    <>
                      <p className="mt-2 font-mono text-[0.6875rem] text-ink-muted">{o.invoice.number}</p>
                      <button
                        onClick={() => downloadInvoice(o.invoice!.url, o.invoice!.number)}
                        disabled={downloading === o.invoice.number}
                        className="mt-2 w-full cursor-pointer rounded-lg bg-ink px-3 py-2 text-[0.75rem] font-medium text-white transition-colors hover:bg-ink/88 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet"
                      >
                        {downloading === o.invoice.number ? "Preparing…" : "Download invoice PDF"}
                      </button>
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      </aside>
    </div>
  );
}
