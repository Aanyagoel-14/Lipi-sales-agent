import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";

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
 * The request a handler is currently serving.
 *
 * `next/headers` gives a handler its headers but not its method, and the
 * auth choke point needs the method: an API key scoped to reads may not be
 * spent on a POST. Rather than thread the request through every call, the
 * wrapper below opens an async local store for it — the same mechanism Next
 * backs `headers()` with, ours to fill.
 */
const currentRequest = new AsyncLocalStorage<Request>();

/** Undefined outside a `route()`-wrapped handler, which callers must handle. */
export const requestInFlight = () => currentRequest.getStore();

/**
 * Wraps a route handler so a thrown HttpError becomes its response.
 *
 * Express had error middleware for this; the App Router has no equivalent, so
 * the wrapper is the seam. Every handler goes through it, which is also what
 * keeps a stray exception from leaking a stack trace to the client.
 */
export function route<P extends Record<string, string> = Record<string, never>>(
  fn: (req: Request, params: P) => Promise<Response>,
) {
  return async (req: Request, ctx: { params: Promise<P> }): Promise<Response> => {
    try {
      const params = ctx ? await ctx.params : ({} as P);
      return await currentRequest.run(req, () => fn(req, params));
    } catch (error) {
      if (error instanceof HttpError) {
        return Response.json(
          { error: error.message, details: error.details },
          { status: error.status, headers: error.headers },
        );
      }
      console.error(error);
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  };
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
