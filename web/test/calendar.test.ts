import { beforeEach, describe, expect, it } from "vitest";
import { createUser, createWorkspace, resetDatabase } from "./helpers";
import { prisma } from "@/server/lib/prisma";
import { executeSkill } from "@/server/agents/execute";

/**
 * `Calendar_Negotiation`, end to end through the executor.
 *
 * The arithmetic is covered exhaustively in `scheduling.test.ts`; what is
 * asserted here is the part that persists — that a proposal is a row, that a
 * counter-offer is checked against the owner's rules rather than accepted
 * because the counterpart suggested it, and that confirming twice books one
 * meeting.
 *
 * PRD §6 Use Case 2 is the last case in the file, driven by its own sentence.
 */

let workspaceId: string;
let profileId: string;

/** A Wednesday, 09:00 UTC. Every date below is relative to this. */
const NOW = new Date("2026-09-23T09:00:00Z");

async function setup(over: Record<string, unknown> = {}) {
  const { user } = await createUser();
  const workspace = await createWorkspace({ userId: user.id, policy: "nothing" });
  workspaceId = workspace.id;

  const profile = await prisma.paProfile.create({
    data: {
      workspaceId,
      ownerName: "Dr. Chen",
      timezone: "Europe/London",
      workdayStartMinute: 9 * 60,
      workdayEndMinute: 18 * 60,
      bufferMinutes: 15,
      maxDailyMeetingMinutes: 300,
      focusBlocks: [],
      ...over,
    },
  });
  profileId = profile.id;
  return profile;
}

const propose = (args: Record<string, unknown>) =>
  executeSkill({
    workspaceId, skill: "Calendar_Negotiation", now: NOW,
    args: { action: "propose", owner: "Dr. Chen", counterpart: "Priya", purpose: "budget review", ...args },
  });

beforeEach(async () => {
  await resetDatabase();
});

describe("proposing", () => {
  it("records the negotiation and what was offered", async () => {
    await setup();
    const outcome = await propose({ durationMinutes: 45 });

    if (outcome.status === "refused") throw new Error(outcome.reason);
    const negotiation = await prisma.schedulingNegotiation.findFirstOrThrow();
    expect(negotiation.state).toBe("proposed");
    expect(negotiation.durationMinutes).toBe(45);
    expect(negotiation.counterpartName).toBe("Priya");
    expect((negotiation.proposedSlots as unknown[]).length).toBe(3);

    const events = await prisma.twinEvent.findMany();
    expect(events.map((e) => e.type)).toContain("pa_twin.proposed");
  });

  it("refuses to negotiate for an owner who has no profile", async () => {
    await setup();
    const outcome = await executeSkill({
      workspaceId, skill: "Calendar_Negotiation", now: NOW,
      args: { action: "propose", owner: "Nobody", counterpart: "Priya", purpose: "chat" },
    });

    expect(outcome).toMatchObject({ status: "refused" });
    if (outcome.status !== "refused") throw new Error("unreachable");
    expect(outcome.reason).toContain('No PA profile for "Nobody"');
    expect(await prisma.schedulingNegotiation.count()).toBe(0);
  });

  it("offers nothing and escalates when every slot is refused, naming what mostly refused it", async () => {
    // A focus block over every weekday, all day.
    await setup({
      focusBlocks: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMinute: 0, endMinute: 1440 })),
    });

    const outcome = await propose({ durationMinutes: 45 });

    expect(outcome.status).toBe("needs_approval");
    if (outcome.status === "refused") throw new Error("unreachable");
    expect(outcome.data.proposed).toEqual([]);
    expect(outcome.data.blockedMostlyBy).toBe("focus_block");
    expect(outcome.escalationReason).toContain("no slot satisfies the constraints");
  });

  // Explicit constraints are the caller's word; a sentence that happens to
  // contain "morning" must not overrule them.
  it("prefers explicit constraints over anything read from the request text", async () => {
    await setup();
    const outcome = await propose({
      durationMinutes: 30,
      request: "avoid mornings",
      constraints: { avoidWindows: [], requireBuffers: false },
    });

    if (outcome.status === "refused") throw new Error(outcome.reason);
    expect((outcome.data.constraints as { avoidWindows: unknown[] }).avoidWindows).toEqual([]);
  });
});

describe("countering", () => {
  it("accepts a counter-offer that fits the owner's rules", async () => {
    await setup();
    const proposal = await propose({ durationMinutes: 45 });
    if (proposal.status === "refused") throw new Error(proposal.reason);

    // 14:00 BST on the Thursday — inside hours, nothing booked.
    const outcome = await executeSkill({
      workspaceId, skill: "Calendar_Negotiation", now: NOW,
      args: {
        action: "counter",
        negotiationId: proposal.data.negotiationId as string,
        startIso: "2026-09-24T13:00:00.000Z",
      },
    });

    if (outcome.status === "refused") throw new Error(outcome.reason);
    expect(outcome.data.acceptable).toBe(true);
    const negotiation = await prisma.schedulingNegotiation.findFirstOrThrow();
    expect(negotiation.state).toBe("countered");
    expect((negotiation.proposedSlots as unknown[]).length).toBe(4);
  });

  // The whole reason the owner has rules. A time the counterpart suggested is
  // not thereby acceptable.
  it("refuses a counter-offer outside the owner's working hours", async () => {
    await setup();
    const proposal = await propose({ durationMinutes: 45 });
    if (proposal.status === "refused") throw new Error(proposal.reason);

    const outcome = await executeSkill({
      workspaceId, skill: "Calendar_Negotiation", now: NOW,
      args: {
        action: "counter",
        negotiationId: proposal.data.negotiationId as string,
        startIso: "2026-09-24T05:00:00.000Z", // 06:00 BST
      },
    });

    if (outcome.status === "refused") throw new Error(outcome.reason);
    expect(outcome.data.acceptable).toBe(false);
  });

  it("refuses a counter-offer that collides with the owner's buffer", async () => {
    await setup();
    await prisma.calendarEvent.create({
      data: {
        workspaceId, profileId, title: "Standup",
        startsAt: new Date("2026-09-24T13:50:00Z"), endsAt: new Date("2026-09-24T14:20:00Z"),
        source: "manual", busy: true,
      },
    });

    const proposal = await propose({ durationMinutes: 45 });
    if (proposal.status === "refused") throw new Error(proposal.reason);

    // Ends 13:45, ten minutes before a booking — inside the 15-minute buffer.
    const outcome = await executeSkill({
      workspaceId, skill: "Calendar_Negotiation", now: NOW,
      args: {
        action: "counter",
        negotiationId: proposal.data.negotiationId as string,
        startIso: "2026-09-24T13:00:00.000Z",
      },
    });

    if (outcome.status === "refused") throw new Error(outcome.reason);
    expect(outcome.data.acceptable).toBe(false);
  });
});

describe("confirming", () => {
  it("books the slot, closes the negotiation, and records both", async () => {
    await setup();
    const proposal = await propose({ durationMinutes: 45 });
    if (proposal.status === "refused") throw new Error(proposal.reason);
    const offered = proposal.data.proposed as { startIso: string; endIso: string }[];

    const outcome = await executeSkill({
      workspaceId, skill: "Calendar_Negotiation", now: NOW,
      args: { action: "confirm", negotiationId: proposal.data.negotiationId as string, startIso: offered[1]!.startIso },
    });

    if (outcome.status === "refused") throw new Error(outcome.reason);
    expect(outcome.data.newlyBooked).toBe(true);

    const event = await prisma.calendarEvent.findFirstOrThrow();
    expect(event.source).toBe("negotiated");
    expect(event.startsAt.toISOString()).toBe(offered[1]!.startIso);
    expect(event.title).toContain("budget review");

    const negotiation = await prisma.schedulingNegotiation.findFirstOrThrow();
    expect(negotiation.state).toBe("confirmed");
    expect(negotiation.eventId).toBe(event.id);

    const events = await prisma.twinEvent.findMany();
    expect(events.map((e) => e.type)).toContain("pa_twin.confirmed");
  });

  // Only a time that was actually put on the table may be confirmed —
  // otherwise confirmation steps around every rule the proposal enforces.
  it("refuses to book a time that was never offered", async () => {
    await setup();
    const proposal = await propose({ durationMinutes: 45 });
    if (proposal.status === "refused") throw new Error(proposal.reason);

    const outcome = await executeSkill({
      workspaceId, skill: "Calendar_Negotiation", now: NOW,
      args: {
        action: "confirm",
        negotiationId: proposal.data.negotiationId as string,
        startIso: "2026-09-24T02:00:00.000Z",
      },
    });

    expect(outcome).toMatchObject({ status: "refused" });
    if (outcome.status !== "refused") throw new Error("unreachable");
    expect(outcome.reason).toContain("was never offered");
    expect(await prisma.calendarEvent.count()).toBe(0);
  });

  it("is idempotent: confirming twice books one meeting", async () => {
    await setup();
    const proposal = await propose({ durationMinutes: 45 });
    if (proposal.status === "refused") throw new Error(proposal.reason);
    const negotiationId = proposal.data.negotiationId as string;

    const first = await executeSkill({
      workspaceId, skill: "Calendar_Negotiation", now: NOW,
      args: { action: "confirm", negotiationId },
    });
    const second = await executeSkill({
      workspaceId, skill: "Calendar_Negotiation", now: NOW,
      args: { action: "confirm", negotiationId },
    });

    if (first.status === "refused" || second.status === "refused") throw new Error("unreachable");
    expect(first.data.newlyBooked).toBe(true);
    expect(second.data.newlyBooked).toBe(false);
    expect(second.data.eventId).toBe(first.data.eventId);
    expect(await prisma.calendarEvent.count()).toBe(1);
  });
});

describe("PRD §6 Use Case 2 — the Personal Assistant", () => {
  // The PRD's own sentence, unedited, driving the whole negotiation.
  const REQUEST =
    "Find 45 minutes with Dr. Chen next week for budget review, avoid mornings, and maintain 15-min buffers.";

  it("books a 45-minute afternoon slot next week that honours the buffers", async () => {
    const profile = await setup();

    // A morning meeting and an afternoon one, so the answer has to route
    // around something real rather than an empty calendar.
    await prisma.calendarEvent.createMany({
      data: [
        {
          workspaceId, profileId: profile.id, title: "Clinic",
          startsAt: new Date("2026-09-28T13:00:00Z"), endsAt: new Date("2026-09-28T15:00:00Z"),
          source: "manual", busy: true,
        },
      ],
    });

    const proposal = await executeSkill({
      workspaceId, skill: "Calendar_Negotiation", now: NOW,
      args: {
        action: "propose",
        owner: "Dr. Chen",
        counterpart: "the budget holder",
        purpose: "budget review",
        request: REQUEST,
      },
    });

    if (proposal.status === "refused") throw new Error(proposal.reason);
    const offered = proposal.data.proposed as { startIso: string; endIso: string }[];
    expect(offered.length).toBeGreaterThan(0);
    expect(proposal.data.durationMinutes).toBe(45);

    for (const slot of offered) {
      const start = new Date(slot.startIso);
      const end = new Date(slot.endIso);

      // 45 minutes, as asked.
      expect(end.getTime() - start.getTime()).toBe(45 * 60_000);

      // Next week: the week beginning Monday 2026-09-28.
      expect(start >= new Date("2026-09-28T00:00:00Z")).toBe(true);
      expect(start < new Date("2026-10-05T00:00:00Z")).toBe(true);

      // Not a morning, in Dr. Chen's own zone.
      const localHour = Number(
        new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", hour12: false })
          .format(start),
      ) % 24;
      expect(localHour).toBeGreaterThanOrEqual(12);

      // Fifteen minutes clear of the clinic, either side.
      const clinicStart = new Date("2026-09-28T13:00:00Z").getTime();
      const clinicEnd = new Date("2026-09-28T15:00:00Z").getTime();
      const clear = end.getTime() + 15 * 60_000 <= clinicStart || start.getTime() - 15 * 60_000 >= clinicEnd;
      expect(clear, `slot ${slot.startIso} must clear the clinic by the buffer`).toBe(true);
    }

    const confirmed = await executeSkill({
      workspaceId, skill: "Calendar_Negotiation", now: NOW,
      args: { action: "confirm", negotiationId: proposal.data.negotiationId as string },
    });

    if (confirmed.status === "refused") throw new Error(confirmed.reason);
    const booked = await prisma.calendarEvent.findFirstOrThrow({ where: { source: "negotiated" } });
    expect(booked.startsAt.toISOString()).toBe(offered[0]!.startIso);

    // And the whole thing is in the audit trail.
    const trail = await prisma.twinEvent.findMany({ orderBy: { occurredAt: "asc" } });
    expect(trail.map((e) => e.type)).toEqual(
      expect.arrayContaining(["pa_twin.proposed", "pa_twin.confirmed", "skill.executed"]),
    );
  });
});
