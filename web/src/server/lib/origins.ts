import { prisma } from "./prisma";

/**
 * The second CORS story: a browser calling `/v1` with an API key.
 *
 * `cors.ts` answers the first one. The widget is anonymous, carries no
 * cookie and reaches two endpoints that touch no other tenant's data, so it
 * replies `Access-Control-Allow-Origin: *` to anybody — that is unchanged
 * and must stay unchanged.
 *
 * A key-authenticated call is a different question. The key is a secret with
 * the whole tenant behind it, so which page in a browser gets to spend it is
 * the operator's decision, not ours: each workspace names the origins it
 * runs its own front end on (`Workspace.allowedOrigins`), and a response is
 * only readable cross-origin from one of them. The default is an empty list,
 * which denies every origin — a workspace that never integrates a browser
 * never opens one.
 *
 * Two properties make this safe to apply in the `route()` wrapper rather than
 * per endpoint:
 *
 *  - The origin echoed back is one the *resolved* tenant listed. A key for
 *    workspace A can never make a response readable from an origin only
 *    workspace B allows.
 *  - Credentials are never allowed. A browser cannot ride the operator's
 *    dashboard cookie from a third-party page; the only way through is a key
 *    the page already holds.
 */

/** Headers to merge into a response, or nothing at all if the origin is not allowed. */
export async function allowedOriginHeaders(
  origin: string | null,
  workspaceId: string | undefined,
): Promise<Record<string, string>> {
  // No workspace means no credential was resolved, so there is nobody whose
  // allow-list this could be checked against. Same-origin callers — the
  // dashboard — send no Origin at all and need none of this.
  if (!origin || !workspaceId) return {};

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { allowedOrigins: true },
  });
  if (!workspace?.allowedOrigins.includes(origin)) return {};

  return {
    "Access-Control-Allow-Origin": origin,
    // The answer depends on the request's Origin, so a cache that ignored it
    // would serve one tenant's allowance to another's page.
    Vary: "Origin",
    "Access-Control-Expose-Headers": "Retry-After",
  };
}

/**
 * Answers a preflight.
 *
 * A preflight arrives with no credential of any kind — browsers strip
 * `Authorization` from it — so there is no workspace to check an origin
 * against here, and it is answered for any origin that asks.
 *
 * That is not a hole, for two reasons. A preflight returns no data; it only
 * tells the browser it may *send* the real request, which is still refused
 * unless it carries a live key, and is still unreadable unless that key's
 * own workspace listed the origin. And answering selectively would be worse
 * than useless: a 204 here and a 403 there is an oracle for "does this site
 * use Lipi", paid for with a table scan on every preflight.
 *
 * There is no CSRF to defend against either — these endpoints accept a
 * bearer key and never a cookie, so a page on another origin has no ambient
 * authority to spend.
 */
export async function preflight(req: Request): Promise<Response> {
  const origin = req.headers.get("origin");

  // Not a preflight: nothing to allow, and `*` would contradict the
  // allow-list the real request is about to be held to.
  if (!origin) return new Response(null, { status: 403 });

  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Workspace-Id",
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    },
  });
}
