"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/client";

const field =
  "h-11 w-full rounded-full border border-line-strong bg-surface px-5 text-[0.9375rem] placeholder:text-ink-subtle focus-visible:border-violet focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-violet";

export function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signup = mode === "signup";

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const res = await apiFetch(`auth/${mode}`, {
        method: "POST",
        body: JSON.stringify(signup ? { name, email, password } : { email, password }),
      });

      const body = (await res.json().catch(() => null)) as { error?: string; workspaceIds?: string[] } | null;
      if (!res.ok) throw new Error(body?.error ?? "Something went wrong");

      // A new account has no workspace yet, so it starts at onboarding.
      router.push((body?.workspaceIds?.length ?? 0) > 0 ? "/dashboard" : "/onboarding");
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="w-full max-w-sm">
      <h1 className="text-[1.75rem] tracking-tight">{signup ? "Create your workspace" : "Welcome back"}</h1>
      <p className="mt-2 text-[0.9375rem] text-ink-muted">
        {signup ? "A few details, then we build your twin." : "Sign in to your twin."}
      </p>

      <div className="mt-8 space-y-3">
        {signup ? (
          <label className="block">
            <span className="mb-1.5 block text-[0.8125rem] text-ink-muted">Your name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" placeholder="Sam Nair" className={field} />
          </label>
        ) : null}

        <label className="block">
          <span className="mb-1.5 block text-[0.8125rem] text-ink-muted">Work email</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" spellCheck={false} placeholder="you@company.com" className={field} />
        </label>

        <label className="block">
          <span className="mb-1.5 block text-[0.8125rem] text-ink-muted">Password</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} autoComplete={signup ? "new-password" : "current-password"} placeholder={signup ? "At least 8 characters" : ""} className={field} />
        </label>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={busy}>
          {busy ? "Working…" : signup ? "Create account" : "Sign in"}
        </Button>
        <p aria-live="polite" className="text-[0.8125rem]">
          {error ? <span className="text-magenta">{error}</span> : null}
        </p>
      </div>

      <p className="mt-8 text-[0.8125rem] text-ink-muted">
        {signup ? "Already have an account? " : "No account yet? "}
        <Link href={signup ? "/login" : "/signup"} className="text-ink underline underline-offset-4">
          {signup ? "Sign in" : "Create one"}
        </Link>
      </p>
    </form>
  );
}
