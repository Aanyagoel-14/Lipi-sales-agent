import type { ReactNode } from "react";

export function Section({
  children,
  className = "",
  id,
}: {
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} className={`scroll-mt-20 px-6 py-20 md:py-28 ${className}`}>
      <div className="mx-auto w-full max-w-6xl">{children}</div>
    </section>
  );
}

export function Pill({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "violet" | "teal" | "amber" | "magenta";
}) {
  const tones = {
    neutral: "bg-chip text-ink-muted",
    violet: "bg-violet-soft text-violet-ink",
    teal: "bg-teal/10 text-teal",
    amber: "bg-amber-wash text-amber",
    magenta: "bg-magenta/10 text-magenta",
  } as const;

  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 font-mono text-[0.6875rem] leading-5 ${tones[tone]}`}
    >
      {children}
    </span>
  );
}
