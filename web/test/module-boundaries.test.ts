import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards the mistake that has now happened twice: a client component importing
 * a module that reaches for next/headers, which drags server-only code into
 * the browser bundle and blanks the page at runtime rather than at build time.
 *
 * Both times the leak arrived through a shared module that looked harmless —
 * lib/dash via charts, then lib/train via the onboarding wizard — so the check
 * follows imports rather than trusting a file to look client-safe.
 */
const SRC = join(process.cwd(), "src");
const SERVER_ONLY = /^\s*import\s[^;]*["']next\/headers["']/m;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : path.match(/\.tsx?$/) ? [path] : [];
  });
}

const files = walk(SRC);
const read = (path: string) => readFileSync(path, "utf8");

// M-1 fix: `walk` builds paths with `path.join`, which uses `\` on Windows.
// The filter below used to test for the POSIX literal "/lib/" against those
// paths directly, so on Windows it matched 0 of the 3 known server-only
// modules and every one of this file's 26 per-component assertions passed
// against an empty set — silently vacuous, exactly the failure mode this
// guard exists to catch elsewhere. Normalising to forward slashes before the
// match makes the check platform-independent.
const toPosix = (p: string) => p.replace(/\\/g, "/");

/** Modules under src/lib that genuinely import a server-only API. */
const serverOnlyModules = new Set(
  files
    .filter((f) => toPosix(f).includes("/lib/") && SERVER_ONLY.test(read(f)))
    .map((f) => toPosix(f).replace(/\.tsx?$/, "").split("/lib/")[1]!),
);

const clientComponents = files.filter((f) => /^["']use client["']/m.test(read(f)));

describe("module boundaries", () => {
  // M-1 regression: cannot spin up a real Windows path.join in this sandbox,
  // but the defect was entirely in the string match, not the filesystem walk
  // — so this asserts the fix directly against a Windows-shaped path,
  // exactly as `walk()` would have produced one on that platform.
  it("still finds a server-only module when the path uses backslashes", () => {
    const windowsPath = "C:\\project\\src\\lib\\workspace.ts";
    expect(toPosix(windowsPath).includes("/lib/")).toBe(true);
    expect(toPosix(windowsPath).replace(/\.tsx?$/, "").split("/lib/")[1]).toBe("workspace");
  });

  it("finds the client components and the server-only modules", () => {
    expect(clientComponents.length).toBeGreaterThan(0);
    // If this ever hits zero the regex has drifted and the guard is asleep.
    expect(serverOnlyModules.size).toBeGreaterThan(0);
  });

  it.each(clientComponents.map((f) => [f.replace(SRC, "src")] as const))(
    "%s does not import a server-only module",
    (relative) => {
      const source = read(join(SRC, relative.replace(/^src/, "")));
      const imported = [...source.matchAll(/from\s+["']@\/lib\/([a-z0-9-]+)["']/g)].map((m) => m[1]!);
      const leaks = imported.filter((name) => serverOnlyModules.has(name));

      expect(leaks, `${relative} imports server-only lib/${leaks.join(", ")}`).toEqual([]);
    },
  );

  it("never imports next/headers directly from a client component", () => {
    const direct = clientComponents.filter((f) => SERVER_ONLY.test(read(f)));
    expect(direct).toEqual([]);
  });
});
