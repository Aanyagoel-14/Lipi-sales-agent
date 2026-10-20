"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/client";

function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (path: string, init: RequestInit) => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(path, init);
      const body = (await res.json().catch(() => null)) as
        { error?: string; delivered?: boolean; reason?: string } | null;
      if (!res.ok) throw new Error(body?.error ?? "That did not work");
      router.refresh();
      return body;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  };

  return { run, busy, error };
}

export function ApprovalDecision({ id }: { id: string }) {
  const { run, busy, error } = useAction();

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        <Button size="sm" chevron={false} disabled={busy} onClick={() => run(`approvals/${id}/approve`, { method: "POST" })}>
          Approve
        </Button>
        <Button size="sm" variant="secondary" chevron={false} disabled={busy} onClick={() => run(`approvals/${id}/reject`, { method: "POST" })}>
          Reject
        </Button>
      </div>
      {error ? <span className="text-[0.6875rem] text-magenta">{error}</span> : null}
    </div>
  );
}

const PAYMENT_METHODS = [
  ["upi", "UPI"], ["bank_transfer", "Bank transfer"], ["cash", "Cash"], ["card", "Card"],
] as const;
type PaymentMethod = (typeof PAYMENT_METHODS)[number][0];

/** The one stage each may step to next; the route holds the full table. */
const NEXT: Record<string, string> = {
  Confirmed: "Packed", Paid: "Packed", Packed: "Shipped", Shipped: "Delivered", Delivered: "Returned",
};
const OPEN = ["Inquiry", "Quoted", "Confirmed"];

type OrderLike = { id: string; stage: string; payment: string; payLink?: string };

/**
 * What the operator may do with an order, by where it is. An unpaid order
 * can be paid (the payment is recorded and the stock taken, exactly as the
 * link does it) or cancelled; a paid or confirmed one moves on through
 * fulfilment. The pay link is there to hand to a customer who lost it.
 */
export function OrderActions({ order }: { order: OrderLike }) {
  const { run, busy, error } = useAction();
  const [method, setMethod] = useState<PaymentMethod>("upi");
  const [copied, setCopied] = useState(false);

  const move = (stage: string, extra: Record<string, unknown> = {}) =>
    run(`orders/${order.id}/stage`, { method: "POST", body: JSON.stringify({ stage, ...extra }) });

  const next = NEXT[order.stage];
  const open = OPEN.includes(order.stage);
  const canPay = open && order.payment !== "paid";
  if (!next && !open) return <span className="text-[0.6875rem] text-ink-subtle">closed</span>;

  const copy = async () => {
    if (!order.payLink) return;
    try {
      await navigator.clipboard.writeText(order.payLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access refused; the link is still on the invoice page.
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        {canPay ? (
          <>
            <select
              value={method}
              onChange={(e) => setMethod(e.target.value as PaymentMethod)}
              disabled={busy}
              aria-label="Payment method"
              className="rounded-md border border-line bg-surface px-1.5 py-1 text-[0.6875rem] text-ink"
            >
              {PAYMENT_METHODS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            <Button size="sm" chevron={false} disabled={busy} onClick={() => move("Paid", { method })}>
              {busy ? "…" : "Record payment"}
            </Button>
          </>
        ) : null}
        {next ? (
          <Button size="sm" variant="secondary" chevron={false} disabled={busy} onClick={() => move(next)}>
            {busy ? "…" : `Mark ${next}`}
          </Button>
        ) : null}
        {order.payLink ? (
          <Button size="sm" variant="secondary" chevron={false} disabled={busy} onClick={copy}>
            {copied ? "Copied" : "Copy pay link"}
          </Button>
        ) : null}
        {open ? (
          <Button size="sm" variant="secondary" chevron={false} disabled={busy} onClick={() => move("Cancelled")}>
            Cancel
          </Button>
        ) : null}
      </div>
      {error ? <span className="text-[0.6875rem] text-magenta">{error}</span> : null}
    </div>
  );
}

export function ReplyBox({ conversationId }: { conversationId: string }) {
  const { run, busy, error } = useAction();
  const [text, setText] = useState("");
  const [note, setNote] = useState<string | null>(null);

  async function send() {
    const body = await run(`conversations/${conversationId}/reply`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    if (body) {
      setText("");
      // Whether it actually left the building depends on the channel, and the
      // provider's own reason is more use than a guess about why.
      setNote(body.delivered
        ? "Sent."
        : `Saved to the thread, not delivered${body.reason ? `: ${body.reason}` : "."}`);
    }
  }

  return (
    <div className="border-t border-line p-4">
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          value={text}
          onChange={(e) => { setText(e.target.value); setNote(null); }}
          onKeyDown={(e) => { if (e.key === "Enter" && text.trim()) send(); }}
          placeholder="Reply as the twin…"
          className="h-11 w-full rounded-full sm:flex-1 border border-line-strong bg-surface px-5 text-[0.8125rem] placeholder:text-ink-subtle focus-visible:border-violet focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-violet"
        />
        <Button disabled={busy || text.trim().length === 0} onClick={send}>
          {busy ? "Sending…" : "Send"}
        </Button>
      </div>
      <p aria-live="polite" className="mt-2 text-[0.75rem]">
        {error ? <span className="text-magenta">{error}</span>
         : note ? <span className="text-ink-subtle">{note}</span>
         : null}
      </p>
    </div>
  );
}
