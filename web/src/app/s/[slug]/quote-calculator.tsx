"use client";

import { useState } from "react";

/**
 * The quote calculator on a generated site (PRD §3 Phase 2).
 *
 * It collects the numbers the formula needs and asks the server what they
 * cost. The formula never reaches the browser: a visitor's page source would
 * otherwise carry the business's pricing maths, and anybody could read the
 * margin out of it.
 *
 * The variable names come from the stored structure, which got them from
 * parsing the formula — so the form asks for exactly what the maths reads,
 * and adding a term to the formula adds a field here with no other change.
 */
export function QuoteCalculator({ slug, variables }: { slug: string; variables: string[] }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [quote, setQuote] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setQuote(null);

    // Everything is sent as a number. A blank field is left out rather than
    // sent as zero, so the server's "no value was given" is what the visitor
    // sees instead of a confidently wrong price.
    const payload: Record<string, number> = {};
    for (const [name, raw] of Object.entries(values)) {
      if (raw.trim() === "") continue;
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) payload[name] = parsed;
    }

    try {
      const response = await fetch(`/v1/builder/sites/${encodeURIComponent(slug)}/quote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variables: payload }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(typeof body.error === "string" ? body.error : "That did not work.");
        return;
      }
      setQuote(body.amountMinorUnits as number);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid max-w-md gap-3">
      {variables.map((name) => (
        <label key={name} className="grid gap-1 text-[0.8125rem]">
          <span className="text-[var(--site-ink-muted)]">{name.replace(/_/g, " ").toLowerCase()}</span>
          <input
            inputMode="decimal"
            value={values[name] ?? ""}
            onChange={(event) => setValues((current) => ({ ...current, [name]: event.target.value }))}
            className="min-h-11 rounded-xl border border-[var(--site-border)] bg-[var(--site-surface)] px-3 font-mono tabular-nums text-[var(--site-ink)]"
          />
        </label>
      ))}

      <button
        type="submit"
        disabled={busy}
        className="min-h-11 rounded-full bg-[var(--site-primary)] px-5 font-medium text-[var(--site-primary-ink)] disabled:opacity-60"
      >
        {busy ? "Working…" : "Calculate"}
      </button>

      <p aria-live="polite" className="text-[0.9375rem]">
        {error ? (
          <span style={{ color: "var(--site-alert)" }}>{error}</span>
        ) : quote !== null ? (
          <span className="font-mono tabular-nums">
            {(quote / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}
          </span>
        ) : null}
      </p>
    </form>
  );
}
