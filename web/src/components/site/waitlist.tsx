"use client";

import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { joinWaitlist } from "@/lib/api";

type State = { status: "idle" | "loading" | "done" | "error"; message?: string };

export function WaitlistForm() {
  const emailId = useId();
  const companyId = useId();
  const emailRef = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [state, setState] = useState<State>({ status: "idle" });

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setState({ status: "loading" });
    try {
      const result = await joinWaitlist({ email, company: company || undefined });
      setState({
        status: "done",
        message: result.alreadyRegistered
          ? "You're already on the list. We'll be in touch."
          : "You're in. We'll reach out within a day.",
      });
    } catch (error) {
      setState({ status: "error", message: (error as Error).message });
      emailRef.current?.focus();
    }
  }

  const field = "h-11 w-full rounded-full border border-line-strong bg-surface px-5 text-[0.9375rem] placeholder:text-ink-subtle focus-visible:border-violet focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-violet";

  return (
    <form onSubmit={onSubmit} noValidate className="w-full max-w-lg">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label htmlFor={emailId} className="mb-1.5 block text-[0.8125rem] text-ink-muted">
            Work email
          </label>
          <input
            id={emailId}
            ref={emailRef}
            type="email"
            name="email"
            autoComplete="email"
            spellCheck={false}
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
            aria-describedby={state.status === "error" ? `${emailId}-error` : undefined}
            aria-invalid={state.status === "error" || undefined}
            className={field}
          />
        </div>

        <div className="sm:w-40">
          <label htmlFor={companyId} className="mb-1.5 block text-[0.8125rem] text-ink-muted">
            Company
          </label>
          <input
            id={companyId}
            type="text"
            name="company"
            autoComplete="organization"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            placeholder="Optional"
            className={field}
          />
        </div>

        <Button type="submit" disabled={state.status === "loading"} className="shrink-0">
          {state.status === "loading" ? "Sending…" : "Get early access"}
        </Button>
      </div>

      <p aria-live="polite" className="mt-3 text-[0.8125rem]">
        {state.status === "error" ? (
          <span id={`${emailId}-error`} className="text-magenta">
            {state.message}
          </span>
        ) : state.status === "done" ? (
          <span className="text-teal">{state.message}</span>
        ) : (
          <span className="text-ink-subtle">No card, no setup call. We reply within a day.</span>
        )}
      </p>
    </form>
  );
}
