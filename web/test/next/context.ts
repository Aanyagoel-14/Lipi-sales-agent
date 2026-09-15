import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The request context the `next/headers` shims read from.
 *
 * Next backs `cookies()` and `headers()` with async local storage tied to a
 * real request. Route handlers called directly in a test have no such request,
 * so the dispatcher opens one of these instead. Same mechanism, ours to fill.
 */
export type CookieMutation = {
  name: string;
  value: string;
  options: { path?: string; expires?: Date; httpOnly?: boolean; secure?: boolean; sameSite?: string };
};

export type RequestContext = {
  headers: Headers;
  cookies: Map<string, string>;
  setCookies: CookieMutation[];
};

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function currentContext(): RequestContext {
  const ctx = requestContext.getStore();
  if (!ctx) throw new Error("cookies()/headers() called outside a dispatched request");
  return ctx;
}

/** Renders a mutation the way a real Set-Cookie header reads. */
export function serializeCookie({ name, value, options }: CookieMutation): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  return parts.join("; ");
}
