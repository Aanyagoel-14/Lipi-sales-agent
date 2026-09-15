"use client";

import { useState } from "react";
import type { Formality, Length, Voice } from "@/lib/twin-types";

const formalities: { id: Formality; label: string }[] = [
  { id: "formal", label: "Formal" },
  { id: "neutral", label: "Neutral" },
  { id: "friendly", label: "Friendly" },
];

const lengths: { id: Length; label: string }[] = [
  { id: "terse", label: "Terse" },
  { id: "balanced", label: "Balanced" },
  { id: "detailed", label: "Detailed" },
];

const chip = (active: boolean) =>
  `cursor-pointer rounded-full px-3.5 py-1.5 text-[0.8125rem] transition-colors ${
    active ? "bg-ink text-white" : "bg-chip text-ink-muted hover:text-ink"
  }`;

/** Mirrors the server's composeReply, so the choice is visible before it is saved. */
function preview(v: Voice) {
  const out: string[] = [];
  if (v.greeting && v.formality !== "formal") out.push(v.greeting);
  out.push("Reserved 2 for you.");
  if (v.length !== "terse") out.push("₹1,196 each, ₹2,392 total.");
  out.push("Want the invoice?");
  let text = out.join(" ");
  if (v.formality === "formal") text = text.replace(/\bWant the\b/g, "Would you like the");
  if (v.useEmoji) text += " 👍";
  if (v.signOff) text += `\n${v.signOff}`;
  return text;
}

export function VoiceStep({
  voice,
  onChange,
}: {
  voice: Voice;
  onChange: React.Dispatch<React.SetStateAction<Voice>>;
}) {
  // Functional update, not a spread of the current prop: two changes in quick
  // succession both read the same stale value otherwise, and the second
  // silently reverts the first.
  const set = <K extends keyof Voice>(k: K, val: Voice[K]) =>
    onChange((current) => ({ ...current, [k]: val }));
  const [signOff, setSignOff] = useState(voice.signOff ?? "");

  return (
    <section>
      <h1 className="max-w-[20ch] text-[1.875rem] tracking-tight">How should your twin sound?</h1>
      <p className="mt-2.5 max-w-md text-[0.9375rem] text-ink-muted">
        This governs phrasing only. What it is allowed to claim comes next, and the two are kept apart on purpose.
      </p>

      <div className="mt-8 space-y-6">
        <div>
          <p className="text-[0.8125rem] font-medium">Formality</p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            {formalities.map((f) => (
              <button key={f.id} type="button" onClick={() => set("formality", f.id)} className={chip(voice.formality === f.id)}>
                {f.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className="text-[0.8125rem] font-medium">Reply length</p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            {lengths.map((l) => (
              <button key={l.id} type="button" onClick={() => set("length", l.id)} className={chip(voice.length === l.id)}>
                {l.label}
              </button>
            ))}
          </div>
        </div>

        <label className="block max-w-sm">
          <span className="text-[0.8125rem] font-medium">Sign-off</span>
          <input
            value={signOff}
            onChange={(e) => { setSignOff(e.target.value); set("signOff", e.target.value || null); }}
            placeholder="— Your business"
            className="mt-1.5 h-10 w-full rounded-full border border-line-strong bg-surface px-4 text-[0.8125rem] placeholder:text-ink-subtle focus-visible:border-violet focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-violet"
          />
        </label>

        <label className="flex cursor-pointer items-center gap-3">
          <input type="checkbox" checked={voice.useEmoji} onChange={(e) => set("useEmoji", e.target.checked)} className="size-4 accent-violet" />
          <span className="text-[0.8125rem]">Allow an emoji in replies</span>
        </label>

        <div>
          <p className="text-[0.75rem] text-ink-subtle">A reply would read</p>
          <p className="mt-2 w-fit max-w-[32rem] whitespace-pre-line rounded-2xl bg-ink px-3.5 py-2.5 text-[0.8125rem] leading-relaxed text-white">
            {preview(voice)}
          </p>
        </div>
      </div>
    </section>
  );
}
