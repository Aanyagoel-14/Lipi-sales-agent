import { z } from "zod";
import {
  dominantRejection,
  findSlots,
  focusBlocksSchema,
  readConstraints,
  schedulingConstraintsSchema,
  type OwnerRules,
  type SchedulingConstraints,
} from "../scheduling";
import type { SkillSpec } from "../types";

/**
 * `Calendar_Negotiation` (PRD §2 Step 01, §5 Personal PA Twin, §6 Use Case 2).
 *
 * Three moves, because a negotiation is not one request and one answer:
 *
 *   propose  read the constraints, find slots that satisfy every rule, and
 *            record what was offered
 *   counter  the counterpart named a time — check it against the same rules
 *            rather than against good manners
 *   confirm  write the entry onto the calendar and close the negotiation
 *
 * Which slots are acceptable is decided by `server/agents/scheduling.ts`,
 * arithmetically. Nothing here asks a model whether Wednesday works. The
 * model's job, when there is one, is to say the offer out loud.
 */

const MINUTE = 60_000;

/** How far ahead a proposal will look when the request names no window. */
const DEFAULT_HORIZON_DAYS = 14;

type Args =
  | { action: "propose"; owner: string; counterpart: string; purpose: string; durationMinutes?: number; request?: string; constraints?: unknown; counterpartHandle?: string }
  | { action: "counter"; negotiationId: string; startIso: string }
  | { action: "confirm"; negotiationId: string; startIso?: string };

export const calendarNegotiation: SkillSpec<Args> = {
  slug: "Calendar_Negotiation",
  label: "Calendar negotiation",
  description:
    "Proposes meeting times that satisfy the owner's working hours, focus blocks, buffers and daily ceiling; evaluates a counter-offer; books the agreed slot.",
  category: "scheduling",
  touchesMoney: false,
  parameters: z.discriminatedUnion("action", [
    z.object({
      action: z.literal("propose"),
      /** The `PaProfile.ownerName` whose calendar this is. */
      owner: z.string().min(1),
      counterpart: z.string().min(1),
      purpose: z.string().min(1),
      durationMinutes: z.number().int().min(5).max(480).optional(),
      /** The sentence the request arrived in, for constraint reading. */
      request: z.string().optional(),
      /** Explicit constraints, which win over anything read from `request`. */
      constraints: z.unknown().optional(),
      counterpartHandle: z.string().optional(),
    }),
    z.object({
      action: z.literal("counter"),
      negotiationId: z.string().min(1),
      startIso: z.iso.datetime(),
    }),
    z.object({
      action: z.literal("confirm"),
      negotiationId: z.string().min(1),
      /** Which of the proposed slots. Defaults to the first still-valid one. */
      startIso: z.iso.datetime().optional(),
    }),
  ]) as unknown as z.ZodType<Args>,

  async run(args, ctx) {
    if (args.action === "propose") return propose(args, ctx);
    if (args.action === "counter") return counter(args, ctx);
    return confirm(args, ctx);
  },
};

type Ctx = Parameters<typeof calendarNegotiation.run>[1];

/** The owner's rules, or a refusal that names what is missing. */
async function rulesFor(ctx: Ctx, ownerName: string) {
  const profile = await ctx.tx.paProfile.findFirst({
    where: { workspaceId: ctx.workspaceId, ownerName },
  });
  if (!profile) {
    throw new Error(
      `No PA profile for "${ownerName}" in this workspace — create one before negotiating on their behalf`,
    );
  }

  const rules: OwnerRules = {
    timezone: profile.timezone,
    workdayStartMinute: profile.workdayStartMinute,
    workdayEndMinute: profile.workdayEndMinute,
    bufferMinutes: profile.bufferMinutes,
    maxDailyMeetingMinutes: profile.maxDailyMeetingMinutes,
    focusBlocks: focusBlocksSchema.parse(profile.focusBlocks ?? []),
  };
  return { profile, rules };
}

/** Everything already on the calendar in a window, as opaque busy blocks. */
async function busyIn(ctx: Ctx, profileId: string, from: Date, to: Date) {
  const events = await ctx.tx.calendarEvent.findMany({
    where: { profileId, busy: true, endsAt: { gt: from }, startsAt: { lt: to } },
    select: { startsAt: true, endsAt: true },
    orderBy: { startsAt: "asc" },
  });
  return events.map((e) => ({ startsAt: e.startsAt, endsAt: e.endsAt }));
}

async function propose(args: Extract<Args, { action: "propose" }>, ctx: Ctx) {
  const { profile, rules } = await rulesFor(ctx, args.owner);

  // Explicit constraints win over anything read from prose: a caller that
  // states a rule means it, and a sentence that happens to contain the word
  // "morning" must not overrule them.
  const read = readConstraints(args.request ?? "", ctx.now);
  const constraints: SchedulingConstraints =
    args.constraints === undefined
      ? read.constraints
      : schedulingConstraintsSchema.parse(args.constraints);

  const durationMinutes = args.durationMinutes ?? read.durationMinutes ?? 30;

  const from = constraints.earliestIso ? new Date(constraints.earliestIso) : ctx.now;
  const to = constraints.latestIso
    ? new Date(constraints.latestIso)
    : new Date(from.getTime() + DEFAULT_HORIZON_DAYS * 24 * 60 * MINUTE);

  const busy = await busyIn(ctx, profile.id, from, to);
  const { slots, rejected } = findSlots({ from, to, durationMinutes, rules, constraints, busy, limit: 3 });

  const proposedSlots = slots.map((slot) => ({
    startIso: slot.startsAt.toISOString(),
    endIso: slot.endsAt.toISOString(),
    offeredAt: ctx.now.toISOString(),
  }));

  const negotiation = await ctx.tx.schedulingNegotiation.create({
    data: {
      workspaceId: ctx.workspaceId,
      profileId: profile.id,
      counterpartName: args.counterpart,
      counterpartHandle: args.counterpartHandle ?? null,
      durationMinutes,
      purpose: args.purpose,
      constraints,
      proposedSlots,
      state: "proposed",
    },
  });

  ctx.record(
    "pa_twin.proposed",
    "calendar",
    `negotiation=${negotiation.id} owner=${profile.ownerName} with="${args.counterpart}" ` +
      `duration=${durationMinutes} offers=${slots.length}`,
  );

  // Nothing fits is an answer, and the reason it does not fit is the useful
  // half of it — "every slot next week is inside a focus block" is actionable
  // in a way that "no availability" is not.
  if (!slots.length) {
    const worst = dominantRejection(rejected);
    return {
      summary: `No slot for ${args.counterpart} fits ${profile.ownerName}'s rules`,
      data: {
        negotiationId: negotiation.id,
        proposed: [],
        durationMinutes,
        blockedMostlyBy: worst,
        rejectionCounts: rejected,
      },
      escalate: { reason: `no slot satisfies the constraints (mostly ${worst ?? "unknown"})` },
    };
  }

  return {
    summary: `Offered ${slots.length} slot${slots.length === 1 ? "" : "s"} to ${args.counterpart} for ${durationMinutes} minutes`,
    data: {
      negotiationId: negotiation.id,
      owner: profile.ownerName,
      timezone: profile.timezone,
      durationMinutes,
      proposed: proposedSlots,
      constraints,
      rejectionCounts: rejected,
    },
  };
}

async function counter(args: Extract<Args, { action: "counter" }>, ctx: Ctx) {
  const negotiation = await ctx.tx.schedulingNegotiation.findFirst({
    where: { id: args.negotiationId, workspaceId: ctx.workspaceId },
  });
  if (!negotiation) throw new Error(`Unknown negotiation ${args.negotiationId}`);
  if (negotiation.state === "confirmed") throw new Error("That negotiation is already confirmed");

  const profile = await ctx.tx.paProfile.findFirstOrThrow({ where: { id: negotiation.profileId } });
  const rules: OwnerRules = {
    timezone: profile.timezone,
    workdayStartMinute: profile.workdayStartMinute,
    workdayEndMinute: profile.workdayEndMinute,
    bufferMinutes: profile.bufferMinutes,
    maxDailyMeetingMinutes: profile.maxDailyMeetingMinutes,
    focusBlocks: focusBlocksSchema.parse(profile.focusBlocks ?? []),
  };

  const startsAt = new Date(args.startIso);
  const endsAt = new Date(startsAt.getTime() + negotiation.durationMinutes * MINUTE);
  const constraints = schedulingConstraintsSchema.parse(negotiation.constraints ?? {});

  // The counter-offer is checked against the same arithmetic the proposal
  // was. A time the counterpart suggested is not thereby acceptable — that is
  // the whole reason the owner has rules.
  const busy = await busyIn(ctx, profile.id, new Date(startsAt.getTime() - 24 * 60 * MINUTE), new Date(endsAt.getTime() + 24 * 60 * MINUTE));
  const { slots } = findSlots({
    from: startsAt,
    to: endsAt,
    durationMinutes: negotiation.durationMinutes,
    rules,
    // The counterpart naming a time overrides *their own* stated preference
    // (they may have changed their mind) but never the owner's rules, which
    // `findSlots` applies from `rules` regardless.
    constraints: { ...constraints, avoidWindows: [], avoidWeekdays: [], earliestIso: undefined, latestIso: undefined },
    busy,
    limit: 1,
  });

  const acceptable = slots.length > 0 && slots[0]!.startsAt.getTime() === startsAt.getTime();

  await ctx.tx.schedulingNegotiation.update({
    where: { id: negotiation.id },
    data: {
      state: "countered",
      proposedSlots: [
        ...(negotiation.proposedSlots as { startIso: string; endIso: string; offeredAt: string }[]),
        { startIso: startsAt.toISOString(), endIso: endsAt.toISOString(), offeredAt: ctx.now.toISOString() },
      ],
    },
  });

  ctx.record(
    "pa_twin.countered",
    "calendar",
    `negotiation=${negotiation.id} at=${startsAt.toISOString()} acceptable=${acceptable}`,
  );

  return {
    summary: acceptable
      ? `${startsAt.toISOString()} works for ${profile.ownerName}`
      : `${startsAt.toISOString()} does not fit ${profile.ownerName}'s rules`,
    data: {
      negotiationId: negotiation.id,
      startIso: startsAt.toISOString(),
      endIso: endsAt.toISOString(),
      acceptable,
    },
  };
}

async function confirm(args: Extract<Args, { action: "confirm" }>, ctx: Ctx) {
  const negotiation = await ctx.tx.schedulingNegotiation.findFirst({
    where: { id: args.negotiationId, workspaceId: ctx.workspaceId },
    include: { profile: true },
  });
  if (!negotiation) throw new Error(`Unknown negotiation ${args.negotiationId}`);
  if (negotiation.state === "confirmed") {
    // Idempotent: a retried confirmation returns the booking it already made
    // rather than putting a second entry on the calendar.
    return {
      summary: `Already confirmed with ${negotiation.counterpartName}`,
      data: {
        negotiationId: negotiation.id,
        eventId: negotiation.eventId,
        startIso: negotiation.agreedStart?.toISOString() ?? null,
        endIso: negotiation.agreedEnd?.toISOString() ?? null,
        newlyBooked: false,
      },
    };
  }

  const offered = negotiation.proposedSlots as { startIso: string; endIso: string }[];
  const chosen = args.startIso
    ? offered.find((slot) => slot.startIso === args.startIso)
    : offered[0];
  // Only a time that was actually put on the table may be confirmed. Booking
  // an arbitrary instant here would let a confirmation step around every rule
  // the proposal step exists to enforce.
  if (!chosen) {
    throw new Error(
      args.startIso
        ? `${args.startIso} was never offered in negotiation ${negotiation.id}`
        : `Negotiation ${negotiation.id} has no offered slot to confirm`,
    );
  }

  const startsAt = new Date(chosen.startIso);
  const endsAt = new Date(chosen.endIso);

  const event = await ctx.tx.calendarEvent.create({
    data: {
      workspaceId: ctx.workspaceId,
      profileId: negotiation.profileId,
      title: `${negotiation.purpose} — ${negotiation.counterpartName}`,
      startsAt,
      endsAt,
      source: "negotiated",
      busy: true,
    },
  });

  await ctx.tx.schedulingNegotiation.update({
    where: { id: negotiation.id },
    data: { state: "confirmed", agreedStart: startsAt, agreedEnd: endsAt, eventId: event.id },
  });

  ctx.record(
    "pa_twin.confirmed",
    "calendar",
    `negotiation=${negotiation.id} event=${event.id} start=${startsAt.toISOString()} end=${endsAt.toISOString()}`,
  );

  return {
    summary: `Booked ${negotiation.purpose} with ${negotiation.counterpartName} at ${startsAt.toISOString()}`,
    data: {
      negotiationId: negotiation.id,
      eventId: event.id,
      startIso: startsAt.toISOString(),
      endIso: endsAt.toISOString(),
      owner: negotiation.profile.ownerName,
      timezone: negotiation.profile.timezone,
      newlyBooked: true,
    },
  };
}
