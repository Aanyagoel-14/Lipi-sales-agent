"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/client";

type Policy = "everything" | "money_only" | "nothing";

const options: { id: Policy; label: string; note: string }[] = [
  { id: "everything", label: "Review every reply", note: "Safest while the Twin is learning." },
  { id: "money_only", label: "Review money actions", note: "Quotes and purchase orders wait; factual replies can go out." },
  { id: "nothing", label: "Run autonomously", note: "Actions execute immediately and remain visible in the event log." },
];

export function PolicyForm({ initial, ready }: { initial: Policy; ready: boolean }) {
  const [policy, setPolicy] = useState(initial);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  async function save() {
    setState("saving");
    try {
      const res = await apiFetch("workspaces/current", { method: "PATCH", body: JSON.stringify({ approvalPolicy: policy }) });
      if (!res.ok) throw new Error();
      setState("saved");
    } catch { setState("error"); }
  }

  return (
    <section className="rounded-2xl border border-line bg-surface p-5">
      <div className="flex flex-wrap items-center gap-2">
        <div>
          <h3 className="text-[0.875rem] font-medium">Activation guardrail</h3>
          <p className="mt-1 text-[0.75rem] text-ink-subtle">Decide what the Twin may do after you have evaluated it.</p>
        </div>
        <span className={`ml-auto rounded-full px-2.5 py-1 font-mono text-[0.6875rem] ${ready ? "bg-teal/10 text-teal" : "bg-amber-wash text-amber"}`}>
          {ready ? "ready to evaluate" : "training incomplete"}
        </span>
      </div>
      <div className="mt-4 grid grid-cols-1 gap-2 lg:grid-cols-3">
        {options.map((option) => (
          <button key={option.id} type="button" onClick={() => { setPolicy(option.id); setState("idle"); }}
            className={`cursor-pointer rounded-xl border p-4 text-left ${policy === option.id ? "border-violet bg-violet-soft/40" : "border-line hover:border-line-strong"}`}>
            <span className="block text-[0.8125rem] font-medium">{option.label}</span>
            <span className="mt-1 block text-[0.75rem] text-ink-muted">{option.note}</span>
          </button>
        ))}
      </div>
      <div className="mt-4 flex items-center gap-3">
        <Button size="sm" onClick={save} disabled={state === "saving"}>{state === "saving" ? "Saving…" : "Save guardrail"}</Button>
        {state === "saved" ? <span className="text-[0.75rem] text-teal">Saved</span> : null}
        {state === "error" ? <span className="text-[0.75rem] text-magenta">Could not save</span> : null}
      </div>
    </section>
  );
}
