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

const STAGES = ["Quoted", "Paid", "Packed", "Shipped", "Delivered"] as const;

export function StageAction({ id, stage }: { id: string; stage: string }) {
  const { run, busy, error } = useAction();
  const index = STAGES.indexOf(stage as (typeof STAGES)[number]);
  const next = index >= 0 && index < STAGES.length - 1 ? STAGES[index + 1] : null;

  if (!next) return <span className="text-[0.6875rem] text-ink-subtle">no next stage</span>;

  return (
    <div className="flex flex-col gap-1">
      <Button size="sm" variant="secondary" chevron={false} disabled={busy}
        onClick={() => run(`orders/${id}/stage`, { method: "POST", body: JSON.stringify({ stage: next }) })}>
        {busy ? "…" : `Mark ${next}`}
      </Button>
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
