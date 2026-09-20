import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agent, createUser, createWorkspace, resetDatabase } from "./helpers";
import { prisma } from "@/server/lib/prisma";
import { _resetRateLimitsForTests, checkRateLimit, clientIp } from "@/server/lib/rate-limit";

/**
 * The public-endpoint budget (L-1 hardening). Two halves: the fixed-window
 * counter itself, and `corsRoute`'s use of it — a 429 that a cross-origin
 * widget cannot read is the same as no answer at all, so the CORS headers on
 * the rejection matter as much as the rejection.
 *
 * The bucket map is module state that outlives a single test, so every case
 * here starts from `_resetRateLimitsForTests()`.
 */

// `corsRoute`'s own constants, asserted against rather than imported: they
// are deliberately private to cors.ts, and a change to either should show up
// here as a failure rather than pass silently.
const WEBCHAT_LIMIT = 60;
const WEBCHAT_WINDOW_MS = 60_000;

beforeEach(_resetRateLimitsForTests);

describe("the fixed window", () => {
  // The window length is not what any of these cases is about — only how
  // many calls fit inside it, and where the clock is when they arrive.
  const hit = (key: string, limit: number) => checkRateLimit(key, limit, 60_000);
  const clockAt = (iso: string) => vi.setSystemTime(new Date(iso));

  // Three of the cases below drive the clock by hand; restoring it here
  // rather than in each of them keeps the arithmetic they are about in view.
  afterEach(() => vi.useRealTimers());

  it("allows exactly `limit` requests and refuses the next", () => {
    for (let i = 1; i <= 5; i++) {
      expect(hit("k", 5), `request ${i}`).toEqual({ allowed: true });
    }

    expect(hit("k", 5).allowed).toBe(false);
  });

  it("reports how long the caller must wait, rounded up to a whole second", () => {
    vi.useFakeTimers();
    clockAt("2026-09-17T12:00:00.000Z");
    hit("k", 1);

    clockAt("2026-09-17T12:00:30.500Z");
    expect(hit("k", 1)).toEqual({ allowed: false, retryAfterSeconds: 30 });
  });

  it("starts a fresh window once the old one has expired", () => {
    vi.useFakeTimers();
    clockAt("2026-09-17T12:00:00.000Z");
    hit("k", 1);
    expect(hit("k", 1).allowed).toBe(false);

    clockAt("2026-09-17T12:01:00.001Z");
    expect(hit("k", 1)).toEqual({ allowed: true });
  });

  // Fixed window, not rolling: a caller who keeps hammering a spent budget
  // does not push their own reset further away with every refused request,
  // so the window they are told to wait out is the one they actually wait.
  it("does not extend the window when it refuses", () => {
    vi.useFakeTimers();
    clockAt("2026-09-17T12:00:00.000Z");
    hit("k", 1);

    clockAt("2026-09-17T12:00:59.000Z");
    expect(hit("k", 1)).toEqual({ allowed: false, retryAfterSeconds: 1 });

    clockAt("2026-09-17T12:01:00.001Z");
    expect(hit("k", 1)).toEqual({ allowed: true });
  });

  it("counts each key separately, so one caller cannot spend another's budget", () => {
    hit("a", 1);
    expect(hit("a", 1).allowed).toBe(false);
    expect(hit("b", 1).allowed).toBe(true);
  });
});

describe("which caller a request is charged to", () => {
  const req = (headers: Record<string, string>) => new Request("http://localhost/v1/webchat/ws/message", { headers });

  it("prefers the first entry of x-forwarded-for, which is the client", () => {
    expect(clientIp(req({ "x-forwarded-for": "203.0.113.7, 70.41.3.18, 150.172.238.178" }))).toBe("203.0.113.7");
  });

  it("trims the whitespace a proxy leaves after the comma", () => {
    expect(clientIp(req({ "x-forwarded-for": " 203.0.113.7 , 70.41.3.18" }))).toBe("203.0.113.7");
  });

  // A proxy that sets the header but has nothing to put in it would otherwise
  // charge every such request to one empty-string bucket — every visitor
  // behind it sharing, and spending, one budget.
  it("ignores an x-forwarded-for with nothing in it", () => {
    expect(clientIp(req({ "x-forwarded-for": "", "x-real-ip": "198.51.100.4" }))).toBe("198.51.100.4");
  });

  it("falls back to x-real-ip, then to a single shared bucket", () => {
    expect(clientIp(req({ "x-real-ip": "198.51.100.4" }))).toBe("198.51.100.4");
    expect(clientIp(req({}))).toBe("unknown");
  });
});

describe("the budget as a webchat caller meets it", () => {
  let workspaceId: string;

  beforeEach(async () => {
    await resetDatabase();
    const { user } = await createUser();
    workspaceId = (await createWorkspace({ userId: user.id })).id;
  });

  /** A cheap `corsRoute` call from one source address. */
  const poll = (ip: string, ws = workspaceId) =>
    agent()
      .get(`/v1/webchat/${ws}/updates`)
      .query({ visitorId: "visitor-rate-1", conversationId: "cnv_nothing" })
      .set("x-forwarded-for", ip);

  /** The endpoint the budget exists for: every one of these runs a full
   *  `ingest()` — an extraction call, a transaction, a lead-score recompute. */
  const say = (ip: string, visitorId = "visitor-rate-2") =>
    agent()
      .post(`/v1/webchat/${workspaceId}/message`)
      .send({ visitorId, text: "do you have olive polos" })
      .set("x-forwarded-for", ip);

  /** Spend what is left of this address's budget on cheap polls, so that the
   *  next request the case makes is the one that has to be refused. */
  const spendBudget = async (ip: string, alreadySpent = 0) => {
    for (let i = alreadySpent + 1; i <= WEBCHAT_LIMIT; i++) await poll(ip).expect(200);
  };

  it("refuses the request past the budget with a Retry-After the widget can obey", async () => {
    await spendBudget("198.51.100.10");

    const refused = await poll("198.51.100.10").expect(429);
    expect(refused.body.error).toBe("Too many requests");

    const retryAfter = Number(refused.headers["retry-after"]);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(WEBCHAT_WINDOW_MS / 1000);
  });

  // Without these the browser drops the response and the widget sees a
  // network error, which is the one failure it cannot back off from.
  it("still carries the CORS headers on the refusal", async () => {
    await spendBudget("198.51.100.11");

    const refused = await poll("198.51.100.11").expect(429);
    expect(refused.headers["access-control-allow-origin"]).toBe("*");
    expect(refused.headers["access-control-allow-methods"]).toContain("GET");
    expect(refused.headers["access-control-allow-headers"]).toBe("Content-Type");
  });

  it("charges the budget per source address, not per workspace", async () => {
    await spendBudget("198.51.100.12");

    await poll("198.51.100.12").expect(429);
    await poll("198.51.100.13").expect(200);
  });

  // One key per source address, not one per route, so the cheap endpoint
  // cannot be used to drain a budget the expensive one then ignores — and,
  // more to the point, `/message` is metered at all. Swap its `corsRoute`
  // for a plain `route()` and this is the only case that notices.
  it("spends one budget across all three routes, so a poll flood closes /message too", async () => {
    await spendBudget("198.51.100.20");

    const refused = await say("198.51.100.20").expect(429);
    expect(refused.headers["access-control-allow-origin"]).toBe("*");
    await agent().post(`/v1/webchat/${workspaceId}/session`)
      .send({ visitorId: "visitor-rate-2" })
      .set("x-forwarded-for", "198.51.100.20")
      .expect(429);

    // The refusal lands ahead of the handler, which is the whole point:
    // no ingest ran, so the flood bought no LLM call and no fake lead.
    expect(await prisma.customer.count({ where: { workspaceId } })).toBe(0);
    expect(await prisma.message.count({ where: { conversation: { workspaceId } } })).toBe(0);
  });

  it("counts a visitor's own messages against the budget, not only their polls", async () => {
    const spent = 5;
    for (let i = 1; i <= spent; i++) await say("198.51.100.21").expect(201);
    await spendBudget("198.51.100.21", spent);

    await poll("198.51.100.21").expect(429);
    expect(await prisma.message.count({ where: { conversation: { workspaceId }, from: "customer" } })).toBe(spent);
  });

  // Capture happens at page load now, so every visitor spends requests and
  // not only the ones who chat — and an office or carrier NAT puts all of
  // them behind one address. Three visitors, each loading a page and then
  // polling for a minute, is 48 requests the old budget of 30 refused.
  it("leaves room for several visitors behind one shared address", async () => {
    const office = "198.51.100.30";

    for (const visitorId of ["visitor-office-1", "visitor-office-2", "visitor-office-3"]) {
      await agent().post(`/v1/webchat/${workspaceId}/session`)
        .send({ visitorId })
        .set("x-forwarded-for", office)
        .expect(201);
      for (let poll = 0; poll < 15; poll++) await agent()
        .get(`/v1/webchat/${workspaceId}/updates`)
        .query({ visitorId, conversationId: "cnv_nothing" })
        .set("x-forwarded-for", office)
        .expect(200);
    }
  });

  // The bucket key is the source address and nothing else. The workspace id
  // is in the URL and is chosen by the caller, so keying by it would hand an
  // abuser a fresh budget per id they type — see rate-limit.ts on why only
  // the transport-level value is trusted here.
  it("does not hand out a fresh budget per workspace id in the URL", async () => {
    const { user } = await createUser("second@test.local");
    const second = (await createWorkspace({ userId: user.id, name: "Second Co" })).id;

    await spendBudget("198.51.100.15");

    await poll("198.51.100.15", second).expect(429);
  });

  // The counter runs before the handler, so a flood aimed at a workspace id
  // that does not exist is throttled on the same budget.
  it("throttles before the handler decides the request was invalid", async () => {
    const miss = () => poll("198.51.100.14", "ws_does_not_exist");

    for (let i = 1; i <= WEBCHAT_LIMIT; i++) await miss().expect(404);
    await miss().expect(429);
  });
});
