import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agent, createUser, createWorkspace, resetDatabase } from "./helpers";
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
const WEBCHAT_LIMIT = 30;
const WEBCHAT_WINDOW_MS = 60_000;

beforeEach(_resetRateLimitsForTests);

describe("the fixed window", () => {
  it("allows exactly `limit` requests and refuses the next", () => {
    for (let i = 1; i <= 5; i++) {
      expect(checkRateLimit("k", 5, 60_000), `request ${i}`).toEqual({ allowed: true });
    }

    const refused = checkRateLimit("k", 5, 60_000);
    expect(refused.allowed).toBe(false);
  });

  it("reports how long the caller must wait, rounded up to a whole second", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-17T12:00:00.000Z"));
      checkRateLimit("k", 1, 60_000);
      vi.setSystemTime(new Date("2026-09-17T12:00:30.500Z"));

      const refused = checkRateLimit("k", 1, 60_000);
      expect(refused).toEqual({ allowed: false, retryAfterSeconds: 30 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts a fresh window once the old one has expired", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-17T12:00:00.000Z"));
      checkRateLimit("k", 1, 60_000);
      expect(checkRateLimit("k", 1, 60_000).allowed).toBe(false);

      vi.setSystemTime(new Date("2026-09-17T12:01:00.001Z"));
      expect(checkRateLimit("k", 1, 60_000)).toEqual({ allowed: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts each key separately, so one caller cannot spend another's budget", () => {
    checkRateLimit("a", 1, 60_000);
    expect(checkRateLimit("a", 1, 60_000).allowed).toBe(false);
    expect(checkRateLimit("b", 1, 60_000).allowed).toBe(true);
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

  afterEach(_resetRateLimitsForTests);

  /** A cheap `corsRoute` call from one source address. */
  const poll = (ip: string) =>
    agent()
      .get(`/v1/webchat/${workspaceId}/updates`)
      .query({ visitorId: "visitor-rate-1", conversationId: "cnv_nothing" })
      .set("x-forwarded-for", ip);

  it("refuses the 31st request in the window with a Retry-After the widget can obey", async () => {
    for (let i = 1; i <= WEBCHAT_LIMIT; i++) await poll("198.51.100.10").expect(200);

    const refused = await poll("198.51.100.10").expect(429);
    expect(refused.body.error).toBe("Too many requests");

    const retryAfter = Number(refused.headers["retry-after"]);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(WEBCHAT_WINDOW_MS / 1000);
  });

  // Without these the browser drops the response and the widget sees a
  // network error, which is the one failure it cannot back off from.
  it("still carries the CORS headers on the refusal", async () => {
    for (let i = 1; i <= WEBCHAT_LIMIT; i++) await poll("198.51.100.11").expect(200);

    const refused = await poll("198.51.100.11").expect(429);
    expect(refused.headers["access-control-allow-origin"]).toBe("*");
    expect(refused.headers["access-control-allow-methods"]).toContain("GET");
    expect(refused.headers["access-control-allow-headers"]).toBe("Content-Type");
  });

  it("charges the budget per source address, not per workspace", async () => {
    for (let i = 1; i <= WEBCHAT_LIMIT; i++) await poll("198.51.100.12").expect(200);

    await poll("198.51.100.12").expect(429);
    await poll("198.51.100.13").expect(200);
  });

  // The counter runs before the handler, so a flood aimed at a workspace id
  // that does not exist is throttled on the same budget.
  it("throttles before the handler decides the request was invalid", async () => {
    const miss = () =>
      agent().get("/v1/webchat/ws_does_not_exist/updates")
        .query({ visitorId: "visitor-rate-1", conversationId: "cnv_nothing" })
        .set("x-forwarded-for", "198.51.100.14");

    for (let i = 1; i <= WEBCHAT_LIMIT; i++) await miss().expect(404);
    await miss().expect(429);
  });
});
