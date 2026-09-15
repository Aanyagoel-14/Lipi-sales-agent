import { HttpError } from "./http";
import { checkRateLimit, clientIp } from "./rate-limit";

/**
 * The webchat widget runs on the operator's own website — a different
 * origin from this app — and carries no session cookie, so its two public
 * endpoints (`/v1/webchat/[workspaceId]/session` and `/message`) need CORS
 * rather than the normal same-origin dashboard API. `*` is deliberate, not
 * an oversight: like an Intercom or Stripe publishable key, the workspace
 * id in the URL is meant to be embedded in public page source, and these
 * two endpoints accept no cookie and touch no other tenant's data no
 * matter which origin calls them.
 */
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export const corsPreflight = () => new Response(null, { status: 204, headers: CORS_HEADERS });

/**
 * Per-IP request budget shared by every `corsRoute` handler. Generous
 * enough for a real visitor's own back-and-forth (a message every couple of
 * seconds, plus a background poll every few seconds — see widget.js) while
 * still bounding the cost of a scripted abuser hammering one endpoint. See
 * rate-limit.ts for why this is IP-keyed rather than workspace/visitor-keyed.
 */
const WEBCHAT_LIMIT = 30;
const WEBCHAT_WINDOW_MS = 60_000;

/** Same shape as `route()` in http.ts, but every response — success or
 *  error — carries the CORS headers a cross-origin widget needs to read it,
 *  and every request is metered against the shared public-endpoint budget
 *  before `fn` runs at all (L-1 hardening: no public endpoint should be
 *  free to call in an unbounded loop). */
export function corsRoute<P extends Record<string, string> = Record<string, never>>(
  fn: (req: Request, params: P) => Promise<Response>,
) {
  return async (req: Request, ctx: { params: Promise<P> }): Promise<Response> => {
    try {
      const limited = checkRateLimit(`webchat:${clientIp(req)}`, WEBCHAT_LIMIT, WEBCHAT_WINDOW_MS);
      if (!limited.allowed) {
        return Response.json(
          { error: "Too many requests" },
          { status: 429, headers: { ...CORS_HEADERS, "Retry-After": String(limited.retryAfterSeconds) } },
        );
      }

      const res = await fn(req, ctx ? await ctx.params : ({} as P));
      const withCors = new Response(res.body, res);
      for (const [k, v] of Object.entries(CORS_HEADERS)) withCors.headers.set(k, v);
      return withCors;
    } catch (error) {
      const body = error instanceof HttpError
        ? { error: error.message, details: error.details }
        : { error: "Internal server error" };
      if (!(error instanceof HttpError)) console.error(error);
      return Response.json(body, {
        status: error instanceof HttpError ? error.status : 500,
        headers: CORS_HEADERS,
      });
    }
  };
}
