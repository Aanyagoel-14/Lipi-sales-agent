import type { ReactNode } from "react";

export function Panel({
  title,
  action,
  children,
  className = "",
  bodyClassName = "",
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`rounded-2xl border border-line bg-surface ${className}`}>
      {title ? (
        /* Wraps rather than overflows: a title plus a status pill does not fit
         * on one line at 390px, and `ml-auto` on a non-wrapping flex row pushed
         * the pill straight off the page. */
        <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line px-5 py-3">
          <h2 className="min-w-0 text-[0.875rem] font-medium">{title}</h2>
          {action ? <div className="ml-auto shrink-0">{action}</div> : null}
        </header>
      ) : null}
      <div className={bodyClassName || "p-5"}>{children}</div>
    </section>
  );
}

export function PageHead({ title, blurb, action }: { title: string; blurb?: string; action?: ReactNode }) {
  return (
    <div className="mb-7 flex flex-wrap items-end gap-4">
      <div className="min-w-0">
        <h1 className="text-[1.5rem] tracking-tight">{title}</h1>
        {blurb ? <p className="mt-1 text-[0.875rem] text-ink-muted">{blurb}</p> : null}
      </div>
      {action ? <div className="ml-auto">{action}</div> : null}
    </div>
  );
}

const toneMap = {
  neutral: "bg-chip text-ink-muted",
  violet: "bg-violet-soft text-violet-ink",
  teal: "bg-teal/10 text-teal",
  amber: "bg-amber-wash text-amber",
  magenta: "bg-magenta/10 text-magenta",
  critical: "bg-critical/10 text-critical",
} as const;

export function Tag({ children, tone = "neutral" }: { children: ReactNode; tone?: keyof typeof toneMap }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 font-mono text-[0.6875rem] leading-5 ${toneMap[tone]}`}>
      {children}
    </span>
  );
}

/** Status never rides on colour alone: every dot ships with its label. */
export function Status({ status }: { status: "done" | "needs_approval" | "scheduled" | "failed" }) {
  const map = {
    done: ["bg-teal-mark", "Done"],
    needs_approval: ["bg-amber-mark", "Needs approval"],
    scheduled: ["bg-violet", "Scheduled"],
    failed: ["bg-magenta-mark", "Failed"],
  } as const;
  const [dot, label] = map[status];
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[0.75rem] text-ink-muted">
      <span className={`size-1.5 rounded-full ${dot}`} aria-hidden />
      {label}
    </span>
  );
}

export function ChannelDot({ slot, label }: { slot: number; label: string }) {
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap text-[0.8125rem]">
      <span className={`size-2 rounded-full bg-series-${slot}`} aria-hidden />
      {label}
    </span>
  );
}

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-[0.8125rem]">
        <thead>
          <tr className="border-b border-line">
            {head.map((h) => (
              <th key={h} className="whitespace-nowrap px-5 py-2.5 text-[0.75rem] font-medium text-ink-subtle">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Row({ children }: { children: ReactNode }) {
  return <tr className="border-b border-line/60 last:border-0 hover:bg-chip/40">{children}</tr>;
}

export function Cell({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <td className={`px-5 py-3 align-middle ${className}`}>{children}</td>;
}

/**
 * What a screen says when it has nothing yet.
 *
 * A blank table reads as breakage. An empty state has to say what is missing,
 * why, and what to do about it — otherwise a new workspace looks like a bug.
 */
export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: { href: string; label: string };
}) {
  return (
    <div className="rounded-2xl border border-dashed border-line-strong bg-surface px-6 py-12 text-center">
      <p className="text-[0.9375rem] font-medium">{title}</p>
      <p className="mx-auto mt-2 max-w-md text-[0.875rem] text-ink-muted">{body}</p>
      {action ? (
        <a
          href={action.href}
          className="mt-5 inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-full bg-ink px-5 text-[0.875rem] font-medium text-white transition-colors hover:bg-ink/88"
        >
          {action.label}
        </a>
      ) : null}
    </div>
  );
}
