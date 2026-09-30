import { z } from "zod";

/**
 * When a meeting may go, decided arithmetically.
 *
 * This is the fact half of scheduling, and it is deliberately a pure function
 * over plain data: no database, no clock of its own, no model. A model may
 * read "avoid mornings" out of a sentence; it may not decide whether 14:00 on
 * Wednesday is free, because the owner's buffers, focus blocks and daily
 * ceiling are facts and a plausible-sounding answer to a factual question is
 * just a wrong answer said confidently (invariant 2).
 *
 * Everything here works in UTC instants and converts to the owner's local
 * wall clock only to answer questions that are about their day — "is this a
 * morning", "is this inside working hours", "how much have they already got
 * booked". Storing local times instead would put every daylight-saving
 * transition into the data.
 */

const MINUTE = 60_000;

/** A block of time that is already spoken for. */
export type Busy = { startsAt: Date; endsAt: Date };

export type Slot = { startsAt: Date; endsAt: Date };

/**
 * The constraints a request carries, parsed once and then obeyed.
 *
 * `avoidWindows` is in local minutes-from-midnight so "avoid mornings" is one
 * entry rather than one per candidate day, and so it keeps meaning the same
 * thing across a daylight-saving boundary.
 */
export const schedulingConstraintsSchema = z.object({
  /** Local minute ranges that are unacceptable, e.g. mornings as 0–720. */
  avoidWindows: z
    .array(z.object({ startMinute: z.number().int().min(0).max(1440), endMinute: z.number().int().min(0).max(1440) }))
    .default([]),
  /** Weekdays that are unacceptable at all, 0 = Sunday. */
  avoidWeekdays: z.array(z.number().int().min(0).max(6)).default([]),
  /** ISO dates bounding the search. */
  earliestIso: z.string().optional(),
  latestIso: z.string().optional(),
  /** Whether the owner's buffer rule applies. Defaults to yes; PRD §5. */
  requireBuffers: z.boolean().default(true),
});

export type SchedulingConstraints = z.infer<typeof schedulingConstraintsSchema>;


/** The owner's own rules, read off `PaProfile`. */
export type OwnerRules = {
  timezone: string;
  workdayStartMinute: number;
  workdayEndMinute: number;
  bufferMinutes: number;
  maxDailyMeetingMinutes: number;
  focusBlocks: { weekday: number; startMinute: number; endMinute: number; label?: string }[];
};

export const focusBlocksSchema = z
  .array(
    z.object({
      weekday: z.number().int().min(0).max(6),
      startMinute: z.number().int().min(0).max(1440),
      endMinute: z.number().int().min(0).max(1440),
      label: z.string().optional(),
    }),
  )
  .default([]);

/**
 * The owner's local wall clock for an instant, without pulling in a date
 * library.
 *
 * `Intl.DateTimeFormat` with a named zone is the only thing in the standard
 * library that knows what the offset was on a given date, which is exactly
 * the question a scheduler has to get right twice a year.
 */
export function localParts(at: Date, timezone: string): { weekday: number; minuteOfDay: number; ymd: string } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(at);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  // `hour` comes back as 24 rather than 00 at midnight in some ICU versions.
  const hour = Number(get("hour")) % 24;

  return {
    weekday: Math.max(0, weekdays.indexOf(get("weekday"))),
    minuteOfDay: hour * 60 + Number(get("minute")),
    ymd: `${get("year")}-${get("month")}-${get("day")}`,
  };
}

const overlaps = (a: Slot, b: Busy) => a.startsAt < b.endsAt && b.startsAt < a.endsAt;

/** Why a candidate slot was rejected, in the operator's own vocabulary. */
export type Rejection =
  | "outside_working_hours"
  | "focus_block"
  | "avoided_window"
  | "avoided_weekday"
  | "busy"
  | "buffer"
  | "daily_ceiling"
  | "outside_requested_range";

export type Candidate = { slot: Slot; ok: boolean; reason?: Rejection };

/**
 * Whether one slot is acceptable, and if not, which rule refused it.
 *
 * Returns the *first* failing rule in a deliberate order — the owner's own
 * working hours before the requester's preferences, because a slot outside
 * working hours is not a preference question. The reason travels with the
 * answer so a negotiation can say "Tuesday 09:00 is inside Dr. Chen's focus
 * block" rather than "no".
 */
export function evaluateSlot(
  slot: Slot,
  rules: OwnerRules,
  constraints: SchedulingConstraints,
  busy: Busy[],
  bookedMinutesByDay: Map<string, number>,
): Candidate {
  const start = localParts(slot.startsAt, rules.timezone);
  const durationMinutes = Math.round((slot.endsAt.getTime() - slot.startsAt.getTime()) / MINUTE);
  const endMinuteOfDay = start.minuteOfDay + durationMinutes;

  if (constraints.earliestIso && slot.startsAt < new Date(constraints.earliestIso)) {
    return { slot, ok: false, reason: "outside_requested_range" };
  }
  if (constraints.latestIso && slot.endsAt > new Date(constraints.latestIso)) {
    return { slot, ok: false, reason: "outside_requested_range" };
  }

  if (start.minuteOfDay < rules.workdayStartMinute || endMinuteOfDay > rules.workdayEndMinute) {
    return { slot, ok: false, reason: "outside_working_hours" };
  }

  if (constraints.avoidWeekdays.includes(start.weekday)) {
    return { slot, ok: false, reason: "avoided_weekday" };
  }

  for (const block of rules.focusBlocks) {
    if (block.weekday !== start.weekday) continue;
    if (start.minuteOfDay < block.endMinute && block.startMinute < endMinuteOfDay) {
      return { slot, ok: false, reason: "focus_block" };
    }
  }

  for (const window of constraints.avoidWindows) {
    if (start.minuteOfDay < window.endMinute && window.startMinute < endMinuteOfDay) {
      return { slot, ok: false, reason: "avoided_window" };
    }
  }

  // The buffer is the owner's, so it is applied to the *candidate*: a meeting
  // needs clear air either side of it, and checking the existing entries for
  // room instead would let two buffered meetings sit back to back.
  const padding = constraints.requireBuffers ? rules.bufferMinutes * MINUTE : 0;
  const padded: Slot = {
    startsAt: new Date(slot.startsAt.getTime() - padding),
    endsAt: new Date(slot.endsAt.getTime() + padding),
  };

  for (const entry of busy) {
    if (overlaps(slot, entry)) return { slot, ok: false, reason: "busy" };
    if (padding && overlaps(padded, entry)) return { slot, ok: false, reason: "buffer" };
  }

  const already = bookedMinutesByDay.get(start.ymd) ?? 0;
  if (already + durationMinutes > rules.maxDailyMeetingMinutes) {
    return { slot, ok: false, reason: "daily_ceiling" };
  }

  return { slot, ok: true };
}

/** How much of each local day is already given to meetings. */
export function bookedMinutesPerDay(busy: Busy[], timezone: string): Map<string, number> {
  const byDay = new Map<string, number>();
  for (const entry of busy) {
    const { ymd } = localParts(entry.startsAt, timezone);
    const minutes = Math.round((entry.endsAt.getTime() - entry.startsAt.getTime()) / MINUTE);
    byDay.set(ymd, (byDay.get(ymd) ?? 0) + minutes);
  }
  return byDay;
}

/**
 * Reasons that describe the *shape of a week* rather than the reason a
 * request failed.
 *
 * Over any horizon longer than a day, most of a 15-minute grid falls outside
 * working hours — that is arithmetic, not an obstacle. Counting it as the
 * dominant rejection makes the answer "no availability because most of the
 * week is not the working day", which is true, useless, and hides the reason
 * the operator could actually act on.
 */
const STRUCTURAL: Rejection[] = ["outside_working_hours", "outside_requested_range"];

/**
 * The reason worth telling a person, given a tally of refusals.
 *
 * Prefers a reason somebody could do something about — clear a focus block,
 * relax a preference, raise the daily ceiling — and falls back to the
 * structural ones only when nothing else refused anything at all, which is
 * the case where "the window you gave me contains no working hours" really is
 * the answer.
 */
export function dominantRejection(rejected: Record<Rejection, number>): Rejection | null {
  const ranked = (Object.entries(rejected) as [Rejection, number][])
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);

  return ranked.find(([reason]) => !STRUCTURAL.includes(reason))?.[0] ?? ranked[0]?.[0] ?? null;
}

/** Candidate start times, on a fixed grid, across the search window. */
export const SLOT_GRID_MINUTES = 15;

/**
 * Every slot that satisfies every rule, soonest first.
 *
 * Walks a 15-minute grid rather than trying to be clever: the search window is
 * days, not months, and a predictable grid is what makes a proposal
 * reproducible — the same request twice offers the same times, which matters
 * when the second one is a retry.
 */
export function findSlots(opts: {
  from: Date;
  to: Date;
  durationMinutes: number;
  rules: OwnerRules;
  constraints: SchedulingConstraints;
  busy: Busy[];
  limit?: number;
}): { slots: Slot[]; rejected: Record<Rejection, number> } {
  const { from, to, durationMinutes, rules, constraints, busy } = opts;
  const limit = opts.limit ?? 3;

  const bookedByDay = bookedMinutesPerDay(busy, rules.timezone);
  const rejected: Record<Rejection, number> = {
    outside_working_hours: 0, focus_block: 0, avoided_window: 0, avoided_weekday: 0,
    busy: 0, buffer: 0, daily_ceiling: 0, outside_requested_range: 0,
  };

  const slots: Slot[] = [];
  const step = SLOT_GRID_MINUTES * MINUTE;
  // Start on the grid, so a request made at 10:07 does not offer 10:07.
  const first = Math.ceil(from.getTime() / step) * step;

  for (let t = first; t + durationMinutes * MINUTE <= to.getTime(); t += step) {
    const slot: Slot = { startsAt: new Date(t), endsAt: new Date(t + durationMinutes * MINUTE) };
    const verdict = evaluateSlot(slot, rules, constraints, busy, bookedByDay);

    if (!verdict.ok) {
      rejected[verdict.reason!] += 1;
      continue;
    }

    slots.push(slot);
    if (slots.length >= limit) break;

    // Offers should be spread out rather than three consecutive quarter-hours
    // on the same afternoon, which is one option presented as three.
    t += 60 * MINUTE;
  }

  return { slots, rejected };
}

/**
 * "avoid mornings", "next week", "45 minutes" — read out of a sentence.
 *
 * Pattern-matched, not model-extracted, for the same reason contact details
 * are (`services/extract.ts`): a constraint the scheduler obeys is a fact,
 * and a model that infers "avoid mornings" from a sentence that did not say
 * it will book over somebody's school run. What cannot be matched is simply
 * absent, and an absent constraint is one the caller can still pass
 * explicitly.
 */
export function readConstraints(text: string, now: Date): { constraints: SchedulingConstraints; durationMinutes: number | null } {
  const lower = text.toLowerCase();
  const avoidWindows: SchedulingConstraints["avoidWindows"] = [];

  // Local minute boundaries for the words people actually use.
  if (/\bavoid\b[^.!?]*\bmornings?\b|\bno\b[^.!?]*\bmornings?\b|\bnot\b[^.!?]*\bmornings?\b/.test(lower)) {
    avoidWindows.push({ startMinute: 0, endMinute: 720 });
  }
  if (/\bavoid\b[^.!?]*\bafternoons?\b|\bno\b[^.!?]*\bafternoons?\b/.test(lower)) {
    avoidWindows.push({ startMinute: 720, endMinute: 1080 });
  }
  if (/\bavoid\b[^.!?]*\bevenings?\b|\bno\b[^.!?]*\bevenings?\b/.test(lower)) {
    avoidWindows.push({ startMinute: 1080, endMinute: 1440 });
  }

  const avoidWeekdays: number[] = [];
  if (/\b(weekdays only|no weekends|avoid weekends)\b/.test(lower)) avoidWeekdays.push(0, 6);

  // "45 minutes", "45 min", "1 hour", "an hour and a half".
  let durationMinutes: number | null = null;
  const minutes = lower.match(/\b(\d{1,3})\s*(?:minutes|minute|mins|min)\b/);
  const hours = lower.match(/\b(\d{1,2})(?:\.(\d))?\s*(?:hours|hour|hrs|hr)\b/);
  if (minutes) durationMinutes = Number(minutes[1]);
  else if (hours) durationMinutes = Math.round(Number(`${hours[1]}.${hours[2] ?? 0}`) * 60);
  else if (/\bhalf an hour\b/.test(lower)) durationMinutes = 30;
  else if (/\ban hour\b/.test(lower)) durationMinutes = 60;

  // "next week" is the seven days beginning the next Monday, in UTC terms
  // here; the caller resolves it against the owner's zone when it matters.
  let earliestIso: string | undefined;
  let latestIso: string | undefined;
  if (/\bnext week\b/.test(lower)) {
    const day = now.getUTCDay();
    const daysToNextMonday = ((8 - day) % 7) || 7;
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysToNextMonday));
    earliestIso = start.toISOString();
    latestIso = new Date(start.getTime() + 7 * 24 * 60 * MINUTE).toISOString();
  } else if (/\bthis week\b/.test(lower)) {
    earliestIso = now.toISOString();
    const day = now.getUTCDay();
    const daysToSunday = (7 - day) % 7 || 7;
    latestIso = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysToSunday)).toISOString();
  } else if (/\btomorrow\b/.test(lower)) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    earliestIso = start.toISOString();
    latestIso = new Date(start.getTime() + 24 * 60 * MINUTE).toISOString();
  }

  // Buffers are the owner's default and stay on unless explicitly waived,
  // which is the cautious reading: forgetting to say "keep buffers" must not
  // silently remove them.
  const requireBuffers = !/\b(no buffers?|back[- ]to[- ]back|without buffers?)\b/.test(lower);

  return {
    constraints: schedulingConstraintsSchema.parse({
      avoidWindows, avoidWeekdays, earliestIso, latestIso, requireBuffers,
    }),
    durationMinutes,
  };
}
