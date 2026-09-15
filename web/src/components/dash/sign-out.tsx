"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch } from "@/lib/client";

export function SignOut({ email }: { email: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    await apiFetch("auth/logout", { method: "POST" }).catch(() => {});
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="px-6">
      <p className="truncate text-[0.75rem] text-ink-subtle" title={email}>{email}</p>
      <button
        type="button"
        onClick={signOut}
        disabled={busy}
        className="mt-0.5 inline-flex min-h-9 cursor-pointer items-center text-[0.8125rem] text-ink-muted underline underline-offset-4 transition-colors hover:text-ink disabled:opacity-50"
      >
        {busy ? "Signing out…" : "Sign out"}
      </button>
    </div>
  );
}
