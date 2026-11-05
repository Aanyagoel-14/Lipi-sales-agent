"use client";

import { useState } from "react";

/** The key the chat widget keeps its visitor id under (`public/static/widget.js`). */
const STORAGE_KEY = "lipi_visitor_id";

function visitorId(): string {
  const mint = () => (crypto.randomUUID ? crypto.randomUUID() : `vis-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
  try {
    const existing = localStorage.getItem(STORAGE_KEY);
    if (existing) return existing;
    const fresh = mint();
    localStorage.setItem(STORAGE_KEY, fresh);
    return fresh;
  } catch {
    return mint();
  }
}

/**
 * The contact block.
 *
 * It saves through the widget's own public endpoints, as the same visitor the
 * chat panel uses, so a lead captured from a generated site lands on the same
 * customer twin, with the same `form` provenance, as one captured in the chat.
 * A plain HTML form cannot do this: the contact route takes JSON naming the
 * visitor and the field, and a urlencoded post was refused with a 422 page.
 */
export function ContactForm({ workspaceId }: { workspaceId: string }) {
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    const value = String(form.get("value") ?? "").trim();
    setState("sending");
    setError(null);

    const id = visitorId();
    const post = (path: string, payload: object) =>
      fetch(`/v1/webchat/${workspaceId}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visitorId: id, ...payload }),
      });

    try {
      // The visitor has to exist before a detail can be written onto them.
      const session = await post("session", {});
      if (!session.ok) throw new Error("Could not reach the shop. Please try again.");

      // Which box it is is the visitor's own word; whether it really is one
      // is checked on the server, which refuses rather than guessing.
      const saved = await post("contact", { field: value.includes("@") ? "email" : "phone", value });
      if (!saved.ok) {
        const body = (await saved.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Could not save that. Please check it and try again.");
      }
      if (name) await post("contact", { field: "name", value: name });
      setState("sent");
    } catch (e) {
      setError((e as Error).message);
      setState("idle");
    }
  }

  if (state === "sent") {
    return <p role="status" className="text-[0.9375rem] text-[var(--site-ink)]">Thanks — we have your details and will be in touch.</p>;
  }

  return (
    <form onSubmit={submit} className="grid max-w-md gap-3">
      <label className="grid gap-1 text-[0.8125rem]">
        <span className="text-[var(--site-ink-muted)]">Your name</span>
        <input
          name="name"
          className="min-h-11 rounded-xl border border-[var(--site-border)] bg-[var(--site-surface)] px-3 text-[var(--site-ink)]"
        />
      </label>
      <label className="grid gap-1 text-[0.8125rem]">
        <span className="text-[var(--site-ink-muted)]">Email or phone</span>
        <input
          name="value"
          required
          className="min-h-11 rounded-xl border border-[var(--site-border)] bg-[var(--site-surface)] px-3 text-[var(--site-ink)]"
        />
      </label>
      <button
        type="submit"
        disabled={state === "sending"}
        className="min-h-11 rounded-full bg-[var(--site-primary)] px-5 font-medium text-[var(--site-primary-ink)] disabled:opacity-60"
      >
        {state === "sending" ? "Sending…" : "Send"}
      </button>
      {error ? <p role="alert" className="text-[0.8125rem] text-[var(--site-ink)]">{error}</p> : null}
    </form>
  );
}
