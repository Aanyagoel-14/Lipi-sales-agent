import { z } from "zod";

/** Thrown anywhere in a handler to produce a structured error response. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

export const noContent = () => new Response(null, { status: 204 });

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
      return await fn(req, ctx ? await ctx.params : ({} as P));
    } catch (error) {
      if (error instanceof HttpError) {
        return Response.json({ error: error.message, details: error.details }, { status: error.status });
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
