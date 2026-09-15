import { expect } from "vitest";
import { requestContext, serializeCookie, type RequestContext } from "./next/context";

/**
 * A supertest-shaped client that calls App Router route handlers directly.
 *
 * The suite was written against `supertest(app)` when the API was Express. The
 * handlers are the same functions they always were, so rather than rewrite two
 * thousand lines of tests, this presents them through the same small surface
 * the tests already use: `.get/.post/.put/.delete`, `.send`, `.set`, `.query`,
 * `.expect`, and a resolved `{ status, body, headers, text }`.
 *
 * It is not a server. There is no socket, no Next runtime, and no middleware —
 * which is exactly why it is fast, and also why anything that depends on those
 * belongs in a test that runs the real thing.
 */

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
type RouteModule = Record<string, Handler | unknown>;

const modules = import.meta.glob("../src/app/**/route.ts") as Record<
  string,
  () => Promise<RouteModule>
>;

type Route = { segments: string[]; load: () => Promise<RouteModule> };

/** `../src/app/v1/conversations/[id]/route.ts` -> `["v1", "conversations", "[id]"]` */
const routes: Route[] = Object.entries(modules).map(([file, load]) => ({
  segments: file
    .replace("../src/app/", "")
    .replace(/\/route\.ts$/, "")
    .split("/")
    // Route groups `(name)` are organisational and contribute no path segment.
    .filter((s) => s && !(s.startsWith("(") && s.endsWith(")"))),
  load,
}));

function match(pathname: string) {
  const parts = pathname.split("/").filter(Boolean);

  const candidates = routes
    .filter((r) => r.segments.length === parts.length)
    .map((route) => {
      const params: Record<string, string> = {};
      for (const [i, segment] of route.segments.entries()) {
        if (segment.startsWith("[")) {
          params[segment.slice(1, -1)] = decodeURIComponent(parts[i]!);
        } else if (segment !== parts[i]) {
          return null;
        }
      }
      return { route, params, dynamic: route.segments.filter((s) => s.startsWith("[")).length };
    })
    .filter((c) => c !== null);

  // Next resolves a static segment ahead of a dynamic one at the same depth.
  return candidates.sort((a, b) => a.dynamic - b.dynamic)[0] ?? null;
}

export type Result = {
  status: number;
  /* `any`, as supertest had it. Assertions read straight into response shapes
   * the tests already know, and typing each one at the call site would be
   * ceremony over a value that has just come off the wire. */
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  body: any;
  text: string;
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  headers: Record<string, any>;
};

class Pending implements PromiseLike<Result> {
  private readonly headers = new Headers();
  private readonly params = new URLSearchParams();
  private payload: string | undefined;

  constructor(
    private readonly method: string,
    private readonly path: string,
    private readonly jar: Map<string, string>,
    private readonly expectations: Array<(res: Result) => void> = [],
  ) {}

  set(key: string, value: string): this {
    this.headers.set(key, value);
    return this;
  }

  query(params: Record<string, string | number>): this {
    for (const [key, value] of Object.entries(params)) this.params.set(key, String(value));
    return this;
  }

  send(payload: unknown): this {
    // A string is passed through byte for byte: the webhook signature tests
    // depend on the body arriving exactly as it was signed.
    this.payload = typeof payload === "string" ? payload : JSON.stringify(payload);
    if (!this.headers.has("content-type")) this.headers.set("content-type", "application/json");
    return this;
  }

  expect(status: number, text?: string): this {
    this.expectations.push((res) => {
      expect(res.status, `${this.method} ${this.path} -> ${res.text.slice(0, 200)}`).toBe(status);
      if (text !== undefined) expect(res.text).toBe(text);
    });
    return this;
  }

  async then<T, E>(
    onFulfilled?: ((value: Result) => T | PromiseLike<T>) | null,
    onRejected?: ((reason: unknown) => E | PromiseLike<E>) | null,
  ): Promise<T | E> {
    return this.run().then(onFulfilled, onRejected);
  }

  private async run(): Promise<Result> {
    const [pathname, inlineQuery] = this.path.split("?");
    for (const [key, value] of new URLSearchParams(inlineQuery ?? "")) this.params.set(key, value);

    const found = match(pathname!);
    const search = this.params.size ? `?${this.params}` : "";
    const url = `http://localhost${pathname}${search}`;

    let response: Response;
    let context: RequestContext | undefined;

    if (!found) {
      response = Response.json({ error: "Not found" }, { status: 404 });
    } else {
      const handlers = await found.route.load();
      const handler = handlers[this.method] as Handler | undefined;

      if (!handler) {
        response = new Response(null, { status: 405 });
      } else {
        if (this.jar.size) {
          this.headers.set("cookie", [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "));
        }

        const request = new Request(url, {
          method: this.method,
          headers: this.headers,
          body: this.payload,
        });

        context = {
          headers: new Headers(this.headers),
          cookies: new Map(this.jar),
          setCookies: [],
        };

        response = await requestContext.run(context, () =>
          handler(request, { params: Promise.resolve(found.params) }),
        );
      }
    }

    const headers: Record<string, string | string[]> = Object.fromEntries(response.headers);

    if (context?.setCookies.length) {
      headers["set-cookie"] = context.setCookies.map(serializeCookie);
      // The jar is the agent's, so a session survives into the next request
      // the same way a browser's would.
      for (const { name, value, options } of context.setCookies) {
        if (options.expires && options.expires.getTime() <= Date.now()) this.jar.delete(name);
        else this.jar.set(name, value);
      }
    }

    // supertest hands back a Buffer for a non-text response and the parsed
    // object for JSON; the PDF test relies on the former.
    const type = response.headers.get("content-type") ?? "";
    const raw = Buffer.from(await response.arrayBuffer());
    const text = type.startsWith("application/pdf") ? "" : raw.toString("utf8");

    let body: unknown;
    if (type.startsWith("application/pdf")) body = raw;
    else if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
    }

    const result: Result = { status: response.status, body, text, headers };
    for (const assert of this.expectations) assert(result);
    return result;
  }
}

/** A client with its own cookie jar, the way `request.agent(app)` was. */
export function agent() {
  const jar = new Map<string, string>();
  const make = (method: string) => (path: string) => new Pending(method, path, jar);

  return {
    get: make("GET"),
    post: make("POST"),
    put: make("PUT"),
    patch: make("PATCH"),
    delete: make("DELETE"),
  };
}
