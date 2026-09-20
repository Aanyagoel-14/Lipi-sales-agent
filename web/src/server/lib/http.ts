import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { allowedOriginHeaders } from "./origins";

/** Thrown anywhere in a handler to produce a structured error response. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
    /** Response headers the status needs to be actionable, e.g. `Retry-After`. */
    readonly headers?: Record<string, string>,
  ) {
    super(message);
  }
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

export const noContent = () => new Response(null, { status: 204 });

/**
 * What a handler is currently serving, and what it has decided so far.
 *
 * `next/headers` gives a handler its headers but not its method, and the
 * auth choke point needs the method: an API key scoped to reads may not be
 * spent on a POST. Rather than thread the request through every call, the
 * wrapper below opens an async local store for it — the same mechanism Next
 * backs `headers()` with, ours to fill.
 *
 * `workspaceId` is filled in on the way back out, by `resolveWorkspaceId()`.
 * Only the credential knows the tenant, and only the handler presents it, so
 * the wrapper cannot know it up front — but it needs it afterwards to decide
 * whether this request's `Origin` is one the tenant allows.
 */
type InFlight = { req: Request; workspaceId?: string };

const current = new AsyncLocalStorage<InFlight>();

/** Undefined outside a `route()`-wrapped handler, which callers must handle. */
export const requestInFlight = () => current.getStore()?.req;

/** Records the tenant a request resolved to, for the wrapper's CORS decision. */
export function noteWorkspace(workspaceId: string) {
  const store = current.getStore();
  if (store) store.workspaceId = workspaceId;
}

/**
 * Wraps a route handler so a thrown HttpError becomes its response.
 *
 * Express had error middleware for this; the App Router has no equivalent, so
 * the wrapper is the seam. Every handler goes through it, which is also what
 * keeps a stray exception from leaking a stack trace to the client, and what
 * makes `{ error, details }` the one error envelope the whole API speaks.
 *
 * It is also where a cross-origin response earns its headers. A browser
 * calling `/v1` with a key only gets them if the tenant it resolved to has
 * put that origin on its allow-list — see origins.ts.
 */
export function route<P extends Record<string, string> = Record<string, never>>(
  fn: (req: Request, params: P) => Promise<Response>,
) {
  return async (req: Request, ctx: { params: Promise<P> }): Promise<Response> => {
    const store: InFlight = { req };
    try {
      const params = ctx ? await ctx.params : ({} as P);
      const res = await current.run(store, () => fn(req, params));
      return withOrigin(res, await originHeaders(req, store));
    } catch (error) {
      const cors = await originHeaders(req, store);
      if (error instanceof HttpError) {
        return Response.json(
          { error: error.message, details: error.details },
          { status: error.status, headers: { ...error.headers, ...cors } },
        );
      }
      console.error(error);
      return Response.json({ error: "Internal server error" }, { status: 500, headers: cors });
    }
  };
}

/** Never throws: it runs on the error path too, where a second failure would
 *  replace a handled error with an unhandled one. */
const originHeaders = (req: Request, store: InFlight) =>
  allowedOriginHeaders(req.headers.get("origin"), store.workspaceId).catch(() => ({}));

/** Rebuilt rather than mutated: a `Response` from `Response.json` is frozen. */
function withOrigin(res: Response, cors: Record<string, string>): Response {
  if (!Object.keys(cors).length) return res;
  const copy = new Response(res.body, res);
  for (const [key, value] of Object.entries(cors)) copy.headers.set(key, value);
  return copy;
}

/**
 * Parses and validates a JSON body in one step.
 *
 * A body that is absent or malformed validates as `undefined` rather than
 * throwing a parse error, so a client sending nothing gets the schema's own
 * 422 naming the missing fields instead of an opaque "invalid JSON".
 */
export async function body<T>(req: Request, schema: z.ZodType<T>, message: string): Promise<T> {
  const raw = await req.json().catch(() => undefined);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(422, message, z.flattenError(parsed.error).fieldErrors);
  }
  return parsed.data;
}

export const searchParams = (req: Request) => new URL(req.url).searchParams;
