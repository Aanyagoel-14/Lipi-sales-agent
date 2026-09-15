"use client";

import { useRef, useState } from "react";
import { channelLabel, channelSlot, type ChannelId } from "@/lib/channels";

/* ------------------------- conversation volume line ------------------------ */

const W = 760;
const H = 260;
const PAD = { top: 16, right: 74, bottom: 28, left: 38 };

export function VolumeChart({
  days,
  series,
}: {
  days: string[];
  series: { id: ChannelId; values: number[] }[];
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  // A new workspace has a flat-zero fortnight. Rounding that to a zero max
  // divides every coordinate into NaN and collapses the three ticks onto one
  // value, so the axis always keeps a floor.
  const peak = Math.max(0, ...series.flatMap((s) => s.values));
  const step = peak > 8 ? 20 : 4;
  const max = Math.max(step, Math.ceil(peak / step) * step);
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (days.length > 1 ? i / (days.length - 1) : 0) * plotW;
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;

  const ticks = [0, max / 2, max];

  // Direct-label the two largest series at the right edge; the legend covers the rest.
  const ranked = [...series].sort((a, b) => b.values.at(-1)! - a.values.at(-1)!);
  const labelled = new Set(ranked.slice(0, 2).map((s) => s.id));

  function onMove(event: React.MouseEvent) {
    const rect = wrap.current?.getBoundingClientRect();
    if (!rect) return;
    const frac = ((event.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((frac - PAD.left) / plotW) * (days.length - 1));
    setHover(i >= 0 && i < days.length ? i : null);
  }

  const label = (iso: string) =>
    new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" }).format(new Date(iso));

  return (
    <div>
      {/* The SVG scales with its box, and so does its 10px type: at 390px the
          chart renders at 45% and the axis labels land near 4px. Scrolling a
          chart held at a legible size beats shrinking it out of readability —
          the same trade the wide tables already make. */}
      <div className="-mx-5 overflow-x-auto px-5">
      <div
        ref={wrap}
        className="relative min-w-[32rem]"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Conversations per day by channel">
          {ticks.map((t, i) => (
            <g key={i}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke="var(--color-grid)" strokeWidth="1" />
              <text x={PAD.left - 8} y={y(t) + 4} textAnchor="end" className="tabular fill-ink-subtle text-[10px]">
                {t}
              </text>
            </g>
          ))}

          {days.map((d, i) =>
            i % 3 === 0 ? (
              <text key={d} x={x(i)} y={H - 8} textAnchor="middle" className="fill-ink-subtle text-[10px]">
                {label(d)}
              </text>
            ) : null,
          )}

          {hover !== null ? (
            <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + plotH} stroke="var(--color-line-strong)" strokeWidth="1" />
          ) : null}

          {series.map((s) => (
            <polyline
              key={s.id}
              points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(" ")}
              fill="none"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              stroke={`var(--color-series-${channelSlot[s.id]})`}
            />
          ))}

          {hover !== null
            ? series.map((s) => (
                <circle
                  key={s.id}
                  cx={x(hover)}
                  cy={y(s.values[hover]!)}
                  r="4.5"
                  fill={`var(--color-series-${channelSlot[s.id]})`}
                  stroke="var(--color-surface)"
                  strokeWidth="2"
                />
              ))
            : null}

          {series
            .filter((s) => labelled.has(s.id))
            .map((s) => (
              <text
                key={s.id}
                x={W - PAD.right + 8}
                y={y(s.values.at(-1)!) + 4}
                className="fill-ink-muted text-[10px]"
              >
                {channelLabel[s.id]}
              </text>
            ))}
        </svg>

        {hover !== null ? (
          <div
            className="pointer-events-none absolute top-0 z-10 w-44 -translate-x-1/2 rounded-xl border border-line bg-surface p-3 shadow-lift"
            style={{ left: `${(x(hover) / W) * 100}%` }}
          >
            <p className="mb-2 text-[0.6875rem] text-ink-subtle">{label(days[hover]!)}</p>
            {[...series]
              .sort((a, b) => b.values[hover]! - a.values[hover]!)
              .map((s) => (
                <p key={s.id} className="flex items-center gap-2 py-0.5 text-[0.75rem]">
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={{ background: `var(--color-series-${channelSlot[s.id]})` }}
                    aria-hidden
                  />
                  <span className="text-ink-muted">{channelLabel[s.id]}</span>
                  <span className="tabular ml-auto">{s.values[hover]}</span>
                </p>
              ))}
          </div>
        ) : null}
      </div>
      </div>

      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5">
        {series.map((s) => (
          <li key={s.id} className="flex items-center gap-2 text-[0.75rem] text-ink-muted">
            <span
              className="size-2 rounded-full"
              style={{ background: `var(--color-series-${channelSlot[s.id]})` }}
              aria-hidden
            />
            {channelLabel[s.id]}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------- intent mix ------------------------------- */

export function IntentChart({ data }: { data: { intent: string; count: number }[] }) {
  const [hover, setHover] = useState<string | null>(null);
  // Empty data yields -Infinity and an all-zero mix yields 0; both make the
  // bar width NaN.
  const max = Math.max(1, ...data.map((d) => d.count));

  return (
    <ul className="space-y-2.5">
      {data.map((d) => (
        <li
          key={d.intent}
          onMouseEnter={() => setHover(d.intent)}
          onMouseLeave={() => setHover(null)}
          className="grid grid-cols-[7.5rem_1fr_2.25rem] items-center gap-2.5 sm:grid-cols-[9.5rem_1fr_3rem] sm:gap-3"
        >
          {/* Wraps at small widths: a label clipped to "Return / exchan…" has
              stopped naming the thing it labels. Truncation resumes once the
              column is wide enough for it to stay unambiguous. */}
          <span className="min-w-0 text-[0.8125rem] leading-tight text-ink-muted sm:truncate">
            {d.intent}
          </span>
          <span className="relative block h-5 rounded-sm bg-chip/70">
            <span
              className="absolute inset-y-0 left-0 rounded-r-[4px] bg-series-1 transition-opacity"
              style={{ width: `${(d.count / max) * 100}%`, opacity: hover && hover !== d.intent ? 0.45 : 1 }}
            />
          </span>
          <span className="tabular text-right text-[0.8125rem]">{d.count}</span>
        </li>
      ))}
    </ul>
  );
}
