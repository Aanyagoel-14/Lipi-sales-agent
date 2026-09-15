import Link from "next/link";
import type { ReactNode } from "react";
import { LipiMark } from "@/components/site/icons";

export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center px-6">
          <Link href="/" className="flex min-h-11 items-center gap-2 font-medium tracking-tight">
            <LipiMark />
            <span className="text-[0.9375rem]">Lipi AI</span>
          </Link>
        </div>
      </header>
      <main className="relative flex flex-1 items-center overflow-hidden px-6 py-16">
        <div aria-hidden className="hero-columns pointer-events-none absolute inset-y-0 right-0 w-[55%]" />
        <div className="relative mx-auto w-full max-w-5xl">{children}</div>
      </main>
    </div>
  );
}
