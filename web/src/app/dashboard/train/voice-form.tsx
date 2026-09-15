"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/client";
import type { Formality, Length, Voice } from "@/lib/twin-types";

const formalities: { id: Formality; label: string; sample: string }[] = [
  { id: "formal", label: "Formal", sample: "I will confirm availability and revert." },
  { id: "neutral", label: "Neutral", sample: "Checking availability now." },
  { id: "friendly", label: "Friendly", sample: "Let me check that for you!" },
];

const lengths: { id: Length; label: string; note: string }[] = [
  { id: "terse", label: "Terse", note: "The fact, nothing else" },
  { id: "balanced", label: "Balanced", note: "Fact, supporting detail, next step" },
  { id: "detailed", label: "Detailed", note: "Everything, for complex orders" },
];

/** Mirrors the server's composeReply so the operator sees the effect before saving. */
function previewReply(v: Voice) {
  const parts = ["Reserved 2 × Polo Classic in Olive, L."];
  const detail = "₹1,196 each, ₹2,392 total.";
  const question = "Want the invoice?";

  const out: string[] = [];
  if (v.greeting && v.formality !== "formal") out.push(v.greeting);
  out.push(...parts);
  if (v.length !== "terse") out.push(detail, question);
  else out.push(question);

  let text = out.join(" ");
  if (v.formality === "formal") {
    text = text.replace(/\bWant the\b/g, "Would you like the").replace(/\bI'll\b/g, "I will");
  }
  if (v.useEmoji) text += " 👍";
  if (v.signOff) text += `\n${v.signOff}`;
  return text;
}

export function VoiceForm({ initial }: { initial: Voice }) {
  const [voice, setVoice] = useState<Voice>(initial);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  const set = <K extends keyof Voice>(k: K, val: Voice[K]) => {
    setVoice((v) => ({ ...v, [k]: val }));
    setState("idle");
  };

  async function save() {
    setState("saving");
    try {
      const res = await apiFetch("twin/voice", { method: "PUT", body: JSON.stringify(voice) });
      if (!res.ok) throw new Error(`Could not save (${res.status})`);
      setState("saved");
      setMessage("Voice saved. New replies use it immediately.");
    } catch (e) {
      setState("error");
      setMessage((e as Error).message);
    }
  }

  const chip = (active: boolean) =>
    `cursor-pointer rounded-full px-3 py-1.5 text-[0.8125rem] transition-colors ${
      active ? "bg-ink text-white" : "bg-chip text-ink-muted hover:text-ink"
    }`;

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_20rem]">
      <div className="space-y-6 rounded-2xl border border-line bg-surface p-6">
        <fieldset>
          <legend className="text-[0.8125rem] font-medium">Formality</legend>
          <div className="mt-3 flex flex-wrap gap-2">
            {formalities.map((f) => (
              <button key={f.id} type="button" onClick={() => set("formality", f.id)} className={chip(voice.formality === f.id)}>
                {f.label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[0.75rem] text-ink-subtle">
            {formalities.find((f) => f.id === voice.formality)?.sample}
          </p>
        </fieldset>

        <fieldset>
          <legend className="text-[0.8125rem] font-medium">Reply length</legend>
          <div className="mt-3 flex flex-wrap gap-2">
            {lengths.map((l) => (
              <button key={l.id} type="button" onClick={() => set("length", l.id)} className={chip(voice.length === l.id)}>
                {l.label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[0.75rem] text-ink-subtle">{lengths.find((l) => l.id === voice.length)?.note}</p>
        </fieldset>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Greeting" hint="Dropped automatically when formal">
            <input
              value={voice.greeting ?? ""}
              onChange={(e) => set("greeting", e.target.value || null)}
              placeholder="Hi!"
              className={input}
            />
          </Field>
          <Field label="Sign-off" hint="Appended to every reply">
            <input
              value={voice.signOff ?? ""}
              onChange={(e) => set("signOff", e.target.value || null)}
              placeholder="— Nair Apparel"
              className={input}
            />
          </Field>
        </div>

        <label className="flex cursor-pointer items-center gap-3">
          <input
            type="checkbox"
            checked={voice.useEmoji}
            onChange={(e) => set("useEmoji", e.target.checked)}
            className="size-4 accent-violet"
          />
          <span className="text-[0.8125rem]">Allow an emoji in replies</span>
        </label>

        <ListField
          label="Never say"
          hint="Flagged in the event log if an agent tries"
          values={voice.neverSay}
          onChange={(v) => set("neverSay", v)}
          placeholder="guaranteed"
        />

        <ListField
          label="Always do"
          hint="Reminders the agents carry into every reply"
          values={voice.alwaysSay}
          onChange={(v) => set("alwaysSay", v)}
          placeholder="confirm stock before promising a date"
        />

        <div className="flex flex-wrap items-center gap-3 border-t border-line pt-5">
          <Button onClick={save} disabled={state === "saving"}>
            {state === "saving" ? "Saving…" : "Save voice"}
          </Button>
          <p aria-live="polite" className="text-[0.8125rem]">
            {state === "saved" ? <span className="text-teal">{message}</span> : null}
            {state === "error" ? <span className="text-magenta">{message}</span> : null}
          </p>
        </div>
      </div>

      <aside className="lg:sticky lg:top-8">
        <div className="rounded-2xl border border-line bg-surface p-5">
          <p className="text-[0.8125rem] font-medium">How a reply reads</p>
          <p className="mt-1 text-[0.75rem] text-ink-subtle">Same facts, your voice.</p>
          <p className="mt-4 whitespace-pre-line rounded-2xl bg-ink px-3.5 py-2.5 text-[0.8125rem] leading-relaxed text-white">
            {previewReply(voice)}
          </p>
        </div>
      </aside>
    </div>
  );
}

const input =
  "mt-1.5 h-10 w-full rounded-full border border-line-strong bg-surface px-4 text-[0.8125rem] placeholder:text-ink-subtle focus-visible:border-violet focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-violet";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[0.8125rem] font-medium">{label}</span>
      {hint ? <span className="ml-2 text-[0.75rem] text-ink-subtle">{hint}</span> : null}
      {children}
    </label>
  );
}

function ListField({
  label, hint, values, onChange, placeholder,
}: {
  label: string; hint: string; values: string[]; onChange: (v: string[]) => void; placeholder: string;
}) {
  const [draft, setDraft] = useState("");

  const add = () => {
    const v = draft.trim();
    if (!v || values.includes(v)) return;
    onChange([...values, v]);
    setDraft("");
  };

  return (
    <div>
      <span className="text-[0.8125rem] font-medium">{label}</span>
      <span className="ml-2 text-[0.75rem] text-ink-subtle">{hint}</span>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {values.map((v) => (
          <span key={v} className="inline-flex items-center gap-1.5 rounded-full bg-chip px-2.5 py-1 text-[0.75rem]">
            {v}
            <button
              type="button"
              onClick={() => onChange(values.filter((x) => x !== v))}
              aria-label={`Remove ${v}`}
              className="cursor-pointer text-ink-subtle hover:text-ink"
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          placeholder={placeholder}
          className="h-10 flex-1 rounded-full border border-line-strong bg-surface px-4 text-[0.8125rem] placeholder:text-ink-subtle focus-visible:border-violet focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-violet"
        />
        <Button variant="secondary" chevron={false} size="sm" onClick={add} className="h-10">
          Add
        </Button>
      </div>
    </div>
  );
}
