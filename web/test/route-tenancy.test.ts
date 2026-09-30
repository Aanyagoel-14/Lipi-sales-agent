import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every route says whose data it is touching.
 *
 * Tenant isolation in this codebase is one choke point — `resolveWorkspaceId()`
 * in `server/lib/workspace.ts` — plus a `where: { workspaceId }` written by
 * hand in each handler. That is a good design and it has one structural hole:
 * **nothing requires a new route to call it.** `route()` does not demand it,
 * there is no Prisma extension or row-level security, and `test/tenancy.test.ts`
 * covers named endpoints by hand — so a route added next month that forgets
 * the call passes CI and serves another tenant's rows.
 *
 * This closes that hole the only way it can be closed without changing the
 * architecture: by reading every route module and insisting each one either
 * resolves a tenant, requires a user, verifies a provider signature, or is on
 * the list below **with a reason written next to it**.
 *
 * It cannot prove a handler uses the id it resolved. What it can prove is that
 * nobody added a route without thinking about the question, which is the
 * failure that actually happens.
 */

const APP = join(process.cwd(), "src", "app");

const toPosix = (p: string) => p.replace(/\\/g, "/");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : entry === "route.ts" ? [path] : [];
  });
}

/** `…/src/app/v1/customers/[id]/route.ts` -> `/v1/customers/[id]` */
const pathOf = (file: string) =>
  toPosix(file).split("/src/app")[1]!.replace(/\/route\.ts$/, "") || "/";

/**
 * Routes that legitimately resolve no tenant, each with the reason it does
 * not. Adding to this list is a deliberate act; forgetting to is a failing
 * test.
 */
const EXEMPT: Record<string, string> = {
  "/v1/health": "a liveness probe; it reads nothing",
  "/v1/openapi.json": "the published API description; the same document for everybody",
  "/v1/auth/signup": "creates the user a tenant is later resolved from",
  "/v1/auth/login": "authenticates; there is no tenant until it succeeds",
  "/v1/auth/logout": "destroys the caller's own session",
  "/v1/auth/me": "answers about the caller, and `{user:null}` when there is none",
  "/v1/waitlist": "a public marketing signup that belongs to no workspace",

  // The widget's own endpoints. The workspace id is in the path and is a
  // publishable id — the same trust model as a Stripe publishable key — and
  // the handlers accept no cookie. See `server/lib/cors.ts`.
  "/v1/webchat/[workspaceId]/session": "public widget; the workspace id is a publishable id in the path",
  "/v1/webchat/[workspaceId]/message": "public widget; likewise",
  "/v1/webchat/[workspaceId]/updates": "public widget; likewise",
  "/v1/webchat/[workspaceId]/contact": "public widget; likewise",

  // A generated site is served to strangers, and the calculator on it has to
  // work for them. The slug names the site; nothing is written.
  "/v1/builder/sites/[slug]/quote": "public site calculator; the slug names the site and nothing is written",

  // Aliases that re-export a canonical handler. The check applies there.
  "/api/v1/conversations/ingest": "re-exports /v1/conversations/ingest",
  "/api/v1/agents/builder/deploy": "re-exports /v1/agents/builder/deploy",
  "/api/v1/builder/sites/generate": "re-exports /v1/builder/sites/generate",
};

/**
 * Resolving a tenant from a credential: the choke point, or the human session
 * an attributed action needs.
 */
const RESOLVES_A_TENANT = ["resolveWorkspaceId", "requireUser"];

/**
 * Authenticating against a shared secret instead.
 *
 * Provider webhooks and the ERP push endpoint have no session and no API key —
 * they prove who they are with a signature or a stored token, and find their
 * tenant from what that proves. They answer the question; they answer it
 * differently.
 */
const VERIFIES_A_SECRET = [
  "secretMatches",
  // Telegram's is a per-connection shared-secret header rather than an HMAC.
  "secretsMatch",
  "verifyMetaSignature",
  "verifyXSignature",
  "verifyShopifyWebhook",
  "verifyWebhook",
];

const routes = walk(APP).map((file) => ({
  file,
  path: pathOf(file),
  source: readFileSync(file, "utf8"),
}));

describe("every route accounts for its tenant", () => {
  it("finds the route modules at all", () => {
    // A guard against the guard: a glob that silently matches nothing passes
    // every assertion below and proves precisely nothing.
    expect(routes.length).toBeGreaterThan(50);
  });

  it.each(routes.map((r) => [r.path, r] as const))("%s", (path, route) => {
    const has = (markers: string[]) => markers.some((marker) => route.source.includes(marker));
    const accountedFor = has(RESOLVES_A_TENANT) || has(VERIFIES_A_SECRET);

    if (path in EXEMPT) {
      // An exemption that is no longer needed is worth removing, so an exempt
      // route that *does* account for a tenant fails too. That is how this
      // list stays short enough to be read.
      expect(
        accountedFor,
        `${path} is on the exemption list ("${EXEMPT[path]}") but now authenticates — take it off the list`,
      ).toBe(false);
      return;
    }

    expect(
      accountedFor,
      `${path} accounts for no tenant. Call resolveWorkspaceId() or requireUser(), verify a provider ` +
        `secret, or add it to EXEMPT in test/route-tenancy.test.ts with the reason it needs none.`,
    ).toBe(true);
  });
});
