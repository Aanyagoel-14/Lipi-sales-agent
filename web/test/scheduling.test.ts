import { describe, expect, it } from "vitest";
import {
  bookedMinutesPerDay,
  dominantRejection,
  evaluateSlot,
  findSlots,
  localParts,
  readConstraints,
  schedulingConstraintsSchema,
  type OwnerRules,
} from "@/server/agents/scheduling";

/**
 * The arithmetic half of scheduling.
 *
 * Every case here is about a number, which is why none of them touches the
 * database or a model: whether 14:00 on Wednesday is free is a fact, and the
 * whole reason this module is pure is so that fact can be checked cheaply and
 * exhaustively. The negotiation skill's own tests cover what happens to the
 * answer afterwards.
 */

const LONDON = "Europe/London";

const rules = (over: Partial<OwnerRules> = {}): OwnerRules => ({
  timezone: LONDON,
  workdayStartMinute: 9 * 60,
  workdayEndMinute: 18 * 60,
  bufferMinutes: 15,
  maxDailyMeetingMinutes: 300,
  focusBlocks: [],
  ...over,
});

const slot = (startIso: string, minutes: number) => ({
  startsAt: new Date(startIso),
  endsAt: new Date(new Date(startIso).getTime() + minutes * 60_000),
});

const none = schedulingConstraintsSchema.parse({});

describe("the owner's local clock", () => {
  // Every daylight-saving bug in a scheduler is this function getting it
  // wrong, so it is asserted either side of a transition rather than once.
  it("reads a UTC instant as the owner's wall clock, across a DST boundary", () => {
    // 2026-03-29 is when the UK moves to BST.
    const winter = localParts(new Date("2026-03-28T10:00:00Z"), LONDON);
    const summer = localParts(new Date("2026-03-30T10:00:00Z"), LONDON);

    expect(winter.minuteOfDay).toBe(10 * 60);
    expect(summer.minuteOfDay).toBe(11 * 60);
    expect(winter.ymd).toBe("2026-03-28");
    expect(summer.ymd).toBe("2026-03-30");
  });

  it("names the weekday the owner would name", () => {
    // 2026-09-23 is a Wednesday.
    expect(localParts(new Date("2026-09-23T12:00:00Z"), LONDON).weekday).toBe(3);
  });
});

describe("evaluating one slot", () => {
  it("accepts a slot inside working hours with nothing in the way", () => {
    const verdict = evaluateSlot(slot("2026-09-23T13:00:00Z", 45), rules(), none, [], new Map());
    expect(verdict.ok).toBe(true);
  });

  it("refuses a slot that starts before the working day", () => {
    const verdict = evaluateSlot(slot("2026-09-23T06:00:00Z", 45), rules(), none, [], new Map());
    expect(verdict).toMatchObject({ ok: false, reason: "outside_working_hours" });
  });

  it("refuses a slot that would run past the end of the working day", () => {
    // 17:45 BST start, 45 minutes, ends 18:30 — the start is fine and the end
    // is not, which is the case a start-time-only check gets wrong.
    const verdict = evaluateSlot(slot("2026-09-23T16:45:00Z", 45), rules(), none, [], new Map());
    expect(verdict).toMatchObject({ ok: false, reason: "outside_working_hours" });
  });

  it("refuses a slot inside a focus block", () => {
    const verdict = evaluateSlot(
      slot("2026-09-23T13:00:00Z", 45),
      // Wednesday 13:00–15:00 local (BST, so 12:00–14:00 UTC).
      rules({ focusBlocks: [{ weekday: 3, startMinute: 13 * 60, endMinute: 15 * 60, label: "Deep work" }] }),
      none,
      [],
      new Map(),
    );
    expect(verdict).toMatchObject({ ok: false, reason: "focus_block" });
  });

  it("refuses a slot inside a window the requester asked to avoid", () => {
    const mornings = schedulingConstraintsSchema.parse({ avoidWindows: [{ startMinute: 0, endMinute: 720 }] });
    // 09:30 BST.
    const verdict = evaluateSlot(slot("2026-09-23T08:30:00Z", 45), rules(), mornings, [], new Map());
    expect(verdict).toMatchObject({ ok: false, reason: "avoided_window" });
  });

  it("refuses a slot that overlaps something already booked", () => {
    const busy = [{ startsAt: new Date("2026-09-23T13:30:00Z"), endsAt: new Date("2026-09-23T14:00:00Z") }];
    const verdict = evaluateSlot(slot("2026-09-23T13:00:00Z", 45), rules(), none, busy, new Map());
    expect(verdict).toMatchObject({ ok: false, reason: "busy" });
  });

  // The rule the PRD states outright (§5, "buffer rules (15 min)"). A slot
  // that merely does not overlap is not enough: the owner needs clear air
  // either side, and a scheduler that only checks overlap books them into
  // back-to-back meetings all day.
  it("refuses a slot that touches a booking without the buffer", () => {
    const busy = [{ startsAt: new Date("2026-09-23T13:45:00Z"), endsAt: new Date("2026-09-23T14:30:00Z") }];
    const verdict = evaluateSlot(slot("2026-09-23T13:00:00Z", 45), rules(), none, busy, new Map());
    expect(verdict).toMatchObject({ ok: false, reason: "buffer" });
  });

  it("accepts the same slot when buffers are explicitly waived", () => {
    const busy = [{ startsAt: new Date("2026-09-23T13:45:00Z"), endsAt: new Date("2026-09-23T14:30:00Z") }];
    const waived = schedulingConstraintsSchema.parse({ requireBuffers: false });
    expect(evaluateSlot(slot("2026-09-23T13:00:00Z", 45), rules(), waived, busy, new Map()).ok).toBe(true);
  });

  it("refuses a slot that would take the day past the meeting ceiling", () => {
    const booked = new Map([["2026-09-23", 280]]);
    const verdict = evaluateSlot(slot("2026-09-23T13:00:00Z", 45), rules(), none, [], booked);
    expect(verdict).toMatchObject({ ok: false, reason: "daily_ceiling" });
  });

  it("counts a day's booked minutes in the owner's zone, not the server's", () => {
    // 23:30 UTC on the 23rd is 00:30 local on the 24th — so this hour belongs
    // to the 24th's ceiling, and a server-local count would charge the 23rd.
    const byDay = bookedMinutesPerDay(
      [{ startsAt: new Date("2026-09-23T23:30:00Z"), endsAt: new Date("2026-09-24T00:30:00Z") }],
      LONDON,
    );
    expect(byDay.get("2026-09-24")).toBe(60);
    expect(byDay.get("2026-09-23")).toBeUndefined();
  });
});

describe("finding slots", () => {
  it("offers the soonest acceptable times, spread out rather than consecutive", () => {
    const { slots } = findSlots({
      from: new Date("2026-09-23T08:00:00Z"),
      to: new Date("2026-09-25T18:00:00Z"),
      durationMinutes: 45,
      rules: rules(),
      constraints: none,
      busy: [],
    });

    expect(slots).toHaveLength(3);
    // An hour of separation, so three offers are three choices.
    for (let i = 1; i < slots.length; i++) {
      const gap = slots[i]!.startsAt.getTime() - slots[i - 1]!.startsAt.getTime();
      expect(gap).toBeGreaterThanOrEqual(60 * 60_000);
    }
  });

  it("offers nothing, and says what mostly stopped it, when every slot is refused", () => {
    const { slots, rejected } = findSlots({
      from: new Date("2026-09-23T08:00:00Z"),
      to: new Date("2026-09-23T18:00:00Z"),
      durationMinutes: 45,
      // A focus block over the entire working Wednesday.
      rules: rules({ focusBlocks: [{ weekday: 3, startMinute: 0, endMinute: 1440 }] }),
      constraints: none,
      busy: [],
    });

    expect(slots).toEqual([]);
    expect(rejected.focus_block).toBeGreaterThan(0);
  });

  it("starts on the grid, so a request at 10:07 never offers 10:07", () => {
    const { slots } = findSlots({
      from: new Date("2026-09-23T09:07:00Z"),
      to: new Date("2026-09-23T18:00:00Z"),
      durationMinutes: 30,
      rules: rules(),
      constraints: none,
      busy: [],
      limit: 1,
    });

    expect(slots[0]!.startsAt.getUTCMinutes() % 15).toBe(0);
  });
});

describe("reading constraints out of a sentence", () => {
  const now = new Date("2026-09-23T09:00:00Z"); // a Wednesday

  // The PRD's own request, verbatim (§6 Use Case 2).
  it("reads the PRD's scheduling request", () => {
    const { constraints, durationMinutes } = readConstraints(
      "Find 45 minutes with Dr. Chen next week for budget review, avoid mornings, and maintain 15-min buffers.",
      now,
    );

    expect(durationMinutes).toBe(45);
    expect(constraints.avoidWindows).toEqual([{ startMinute: 0, endMinute: 720 }]);
    expect(constraints.requireBuffers).toBe(true);
    // "next week" begins the following Monday, 2026-09-28.
    expect(constraints.earliestIso?.slice(0, 10)).toBe("2026-09-28");
    expect(constraints.latestIso?.slice(0, 10)).toBe("2026-10-05");
  });

  it("reads an hour written as words or as digits", () => {
    expect(readConstraints("book an hour", now).durationMinutes).toBe(60);
    expect(readConstraints("book 1 hour", now).durationMinutes).toBe(60);
    expect(readConstraints("half an hour please", now).durationMinutes).toBe(30);
    expect(readConstraints("1.5 hours", now).durationMinutes).toBe(90);
  });

  // Buffers are the owner's rule, so silence means they stay. Only an
  // explicit waiver removes them.
  it("keeps buffers unless they are explicitly waived", () => {
    expect(readConstraints("find me 30 minutes", now).constraints.requireBuffers).toBe(true);
    expect(readConstraints("30 minutes, back-to-back is fine", now).constraints.requireBuffers).toBe(false);
  });

  it("reads nothing out of a sentence that says nothing", () => {
    const { constraints, durationMinutes } = readConstraints("hello", now);
    expect(durationMinutes).toBeNull();
    expect(constraints.avoidWindows).toEqual([]);
    expect(constraints.earliestIso).toBeUndefined();
  });
});

describe("naming the reason a search failed", () => {
  // Over any horizon longer than a day most of a 15-minute grid falls outside
  // working hours. Reporting that as the reason is true, useless, and hides
  // the one the operator could act on.
  it("prefers a reason somebody could act on over the shape of the week", () => {
    expect(
      dominantRejection({
        outside_working_hours: 400, outside_requested_range: 0, focus_block: 12,
        avoided_window: 3, avoided_weekday: 0, busy: 0, buffer: 0, daily_ceiling: 0,
      }),
    ).toBe("focus_block");
  });

  it("falls back to the structural reason when nothing else refused anything", () => {
    expect(
      dominantRejection({
        outside_working_hours: 400, outside_requested_range: 10, focus_block: 0,
        avoided_window: 0, avoided_weekday: 0, busy: 0, buffer: 0, daily_ceiling: 0,
      }),
    ).toBe("outside_working_hours");
  });

  it("has nothing to say when nothing was refused", () => {
    expect(
      dominantRejection({
        outside_working_hours: 0, outside_requested_range: 0, focus_block: 0,
        avoided_window: 0, avoided_weekday: 0, busy: 0, buffer: 0, daily_ceiling: 0,
      }),
    ).toBeNull();
  });
});
