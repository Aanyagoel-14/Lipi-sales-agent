import { beforeEach, describe, expect, it } from "vitest";
import { createUser, createWorkspace, resetDatabase } from "./helpers";
import { prisma } from "@/server/lib/prisma";
import {
  EMPTY_TOUCH, firstTouchData, hasAttribution, type AttributionTouch,
} from "@/server/services/attribution";
import { sendVisitorMessage, upsertSession } from "@/server/services/webchat";

/**
 * Invariant 3: first touch is written once and never overwritten. The write
 * itself lives in `services/webchat.ts` (the one caller that knows what a
 * VisitorSession is), so both halves are exercised here — the pure shaping in
 * attribution.ts, and the copy onto the customer twin that uses it.
 */

const touchFrom = (o: Partial<AttributionTouch>): AttributionTouch => ({ ...EMPTY_TOUCH, ...o });

const GOOGLE = touchFrom({
  utmSource: "google", utmMedium: "cpc", utmCampaign: "spring-polos",
  utmTerm: "olive polo", utmContent: "ad-a", adClickId: "gclid-111",
  landingPage: "https://shop.test/polos?utm_source=google", referrer: "https://www.google.com/",
});

const RETARGET = touchFrom({
  utmSource: "facebook", utmMedium: "retargeting", utmCampaign: "winback",
  adClickId: "fbclid-999", landingPage: "https://shop.test/sale", referrer: "https://facebook.com/",
});

let workspaceId: string;

beforeEach(async () => {
  await resetDatabase();
  const { user } = await createUser();
  workspaceId = (await createWorkspace({ userId: user.id, policy: "nothing" })).id;
});

describe("what counts as a touch", () => {
  it("reads a bare direct visit as no attribution at all", () => {
    expect(hasAttribution(EMPTY_TOUCH)).toBe(false);
  });

  it("counts a referrer with no campaign as a touch", () => {
    expect(hasAttribution(touchFrom({ referrer: "https://news.test/" }))).toBe(true);
  });

  /**
   * DIVERGENCE, and the cause of the two pinned cases further down.
   *
   * `hasAttribution` walks `Object.entries(t)` rather than the eight keys of
   * `AttributionTouch`, so it answers "does this object have any non-null
   * property at all". Its one production caller with a row rather than a
   * literal — `sendVisitorMessage`, which passes the whole `VisitorSession` —
   * hands it an object whose `id`, `workspaceId`, `visitorId`, `createdAt`
   * and `lastSeenAt` are never null, so the answer is always true. Reported
   * on issue #7 rather than fixed here: the one-line repair (iterate the
   * known keys, or project the row to a touch at the call site) changes what
   * gets written for every direct visitor, which is a behavioural change.
   */
  it("answers true for any object with a non-null field, not just an attributed one", () => {
    const sessionShapedRow = {
      ...EMPTY_TOUCH, id: "vst_1", workspaceId: "ws_1", visitorId: "visitor-1",
      customerId: null, engagedAt: null, createdAt: new Date(), lastSeenAt: new Date(),
    };

    expect(hasAttribution(sessionShapedRow as unknown as AttributionTouch)).toBe(true);
  });

  // Otherwise every direct visitor gets eight null columns and a
  // `firstTouchAt` timestamp that credits nothing to anything.
  it("shapes no write at all for an empty touch", () => {
    expect(firstTouchData(EMPTY_TOUCH, new Date())).toEqual({});
  });

  it("carries every field plus firstTouchAt when there is something to credit", () => {
    const now = new Date("2026-09-17T10:00:00.000Z");
    expect(firstTouchData(GOOGLE, now)).toEqual({ ...GOOGLE, firstTouchAt: now });
  });

  /**
   * What keeps the divergence above cosmetic: `sendVisitorMessage` hands this
   * a whole `VisitorSession` row, and it projects the eight touch keys rather
   * than spreading what it was given. A spread would carry the session's own
   * `id` and `workspaceId` into a `Customer.update()` — re-keying one tenant's
   * customer row from another table's primary key.
   */
  it("projects the eight touch columns off a session row and none of its keys", () => {
    const now = new Date("2026-09-17T10:00:00.000Z");
    const sessionRow = {
      ...GOOGLE, id: "vst_1", workspaceId: "ws_other", visitorId: "visitor-1",
      customerId: "cus_other", engagedAt: now, createdAt: now, lastSeenAt: now,
    };

    const data = firstTouchData(sessionRow as unknown as AttributionTouch, now);

    expect(Object.keys(data).sort()).toEqual([...Object.keys(EMPTY_TOUCH), "firstTouchAt"].sort());
    expect(data).toEqual({ ...GOOGLE, firstTouchAt: now });
  });
});

describe("first touch on the customer twin", () => {
  it("is written exactly once, when the customer row is created", async () => {
    await upsertSession({ workspaceId, visitorId: "visitor-aaaa-1", touch: GOOGLE });
    const first = await sendVisitorMessage({ workspaceId, visitorId: "visitor-aaaa-1", text: "do you have olive polos" });

    const customer = await prisma.customer.findFirstOrThrow({ where: { workspaceId, id: first.customer.id } });
    expect(first.customer.isNew).toBe(true);
    expect(customer.utmSource).toBe("google");
    expect(customer.utmCampaign).toBe("spring-polos");
    expect(customer.adClickId).toBe("gclid-111");
    expect(customer.firstTouchAt).not.toBeNull();
  });

  // The retargeting case the module was written for: a click a month later
  // must not take credit for a relationship that already exists.
  it("is not overwritten by a later visit carrying different parameters", async () => {
    await upsertSession({ workspaceId, visitorId: "visitor-aaaa-2", touch: GOOGLE });
    const first = await sendVisitorMessage({ workspaceId, visitorId: "visitor-aaaa-2", text: "hello" });
    const stampedAt = (await prisma.customer.findFirstOrThrow({ where: { workspaceId, id: first.customer.id } })).firstTouchAt;

    await upsertSession({ workspaceId, visitorId: "visitor-aaaa-2", touch: RETARGET });
    const second = await sendVisitorMessage({ workspaceId, visitorId: "visitor-aaaa-2", text: "hello again" });

    expect(second.customer.id).toBe(first.customer.id);
    expect(second.customer.isNew).toBe(false);

    const customer = await prisma.customer.findFirstOrThrow({ where: { workspaceId, id: first.customer.id } });
    expect(customer.utmSource).toBe("google");
    expect(customer.utmMedium).toBe("cpc");
    expect(customer.adClickId).toBe("gclid-111");
    expect(customer.firstTouchAt).toEqual(stampedAt);

    // The session row is the source that copy reads from, so it must not
    // have moved either.
    const session = await prisma.visitorSession.findFirstOrThrow({ where: { workspaceId, visitorId: "visitor-aaaa-2" } });
    expect(session.utmSource).toBe("google");
    expect(session.utmCampaign).toBe("spring-polos");
  });

  // Pinned, not endorsed. attribution.ts says a direct visit must not "stamp
  // a customer with eight null columns and a `firstTouchAt` that means
  // nothing" — and that is exactly what happens, because the `hasAttribution`
  // guard above cannot tell a bare session row from an attributed one. The
  // eight columns are correctly null; `firstTouchAt` should be too.
  it("stamps a firstTouchAt on a direct visitor with nothing to credit it to", async () => {
    await upsertSession({ workspaceId, visitorId: "visitor-aaaa-3", touch: EMPTY_TOUCH });
    const result = await sendVisitorMessage({ workspaceId, visitorId: "visitor-aaaa-3", text: "hello" });

    const customer = await prisma.customer.findFirstOrThrow({ where: { workspaceId, id: result.customer.id } });
    expect(customer.utmSource).toBeNull();
    expect(customer.referrer).toBeNull();
    expect(customer.adClickId).toBeNull();
    expect(customer.firstTouchAt).not.toBeNull(); // DIVERGENCE: should be null
  });

  // The path that behaves as documented: no session row at all, so the guard
  // sees a real `EMPTY_TOUCH` literal and writes nothing.
  it("leaves the twin unstamped when the message arrives before any session", async () => {
    const result = await sendVisitorMessage({ workspaceId, visitorId: "visitor-aaaa-5", text: "hello" });

    const customer = await prisma.customer.findFirstOrThrow({ where: { workspaceId, id: result.customer.id } });
    expect(customer.firstTouchAt).toBeNull();
    expect(customer.utmSource).toBeNull();
  });

  // Invariant 5: the touch is read from the session in *this* workspace, so
  // the same visitorId arriving in a second tenant brings no campaign with it.
  it("does not carry a touch from one workspace's session into another's customer", async () => {
    const { user } = await createUser("other@test.local");
    const other = (await createWorkspace({ userId: user.id, name: "Other Co", policy: "nothing" })).id;

    await upsertSession({ workspaceId, visitorId: "visitor-aaaa-6", touch: GOOGLE });
    const result = await sendVisitorMessage({ workspaceId: other, visitorId: "visitor-aaaa-6", text: "hello" });

    const customer = await prisma.customer.findFirstOrThrow({ where: { workspaceId: other, id: result.customer.id } });
    expect(customer.utmSource).toBeNull();
    expect(customer.firstTouchAt).toBeNull();

    // And the first workspace's own session is untouched by the visit.
    const origin = await prisma.visitorSession.findFirstOrThrow({ where: { workspaceId, visitorId: "visitor-aaaa-6" } });
    expect(origin.utmSource).toBe("google");
    expect(origin.customerId).toBeNull();
  });

  // EMPTY_TOUCH whole, rather than whichever subset of the eight columns the
  // caller happened to send — a half-filled row reads as a real campaign.
  it("stores a direct visit as eight nulls, not a partial row", async () => {
    await upsertSession({ workspaceId, visitorId: "visitor-aaaa-4", touch: EMPTY_TOUCH });

    const session = await prisma.visitorSession.findFirstOrThrow({ where: { workspaceId, visitorId: "visitor-aaaa-4" } });
    for (const field of Object.keys(EMPTY_TOUCH) as (keyof AttributionTouch)[]) {
      expect(session[field]).toBeNull();
    }
  });
});
