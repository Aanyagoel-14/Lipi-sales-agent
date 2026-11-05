import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * env.ts validates at module load, so each case loads a fresh copy of it
 * against the process environment it sets up.
 */
const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
  vi.resetModules();
});

async function load(overrides: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return (await import("@/server/env")).env;
}

describe("PUBLIC_URL", () => {
  // Invoice links, Telegram's webhook and the widget snippet are all built
  // from it; at its localhost default they point at the customer's machine.
  it("refuses a localhost value in production", async () => {
    await expect(load({ NODE_ENV: "production", NEXT_PHASE: undefined, PUBLIC_URL: "http://localhost:3000" }))
      .rejects.toThrow(/PUBLIC_URL/);
  });

  // The image is built with placeholders; the real value arrives at start.
  it("is not checked while the production build runs", async () => {
    const env = await load({ NODE_ENV: "production", NEXT_PHASE: "phase-production-build", PUBLIC_URL: "http://localhost:3000" });
    expect(env.PUBLIC_URL).toBe("http://localhost:3000");
  });

  it("accepts the deployment's public origin, without the trailing slash it was given", async () => {
    const env = await load({ NODE_ENV: "production", NEXT_PHASE: undefined, PUBLIC_URL: "https://sellora.example.com/" });
    expect(env.PUBLIC_URL).toBe("https://sellora.example.com");
  });
});
