import { apiFetch } from "./client";

/**
 * Where API calls go.
 *
 * The API is served by this same app, so the browser wants a relative URL and
 * gets one. The server does not: `fetch` on the server has no origin to
 * resolve against, so a server component calling its own route handler has to
 * name the origin in full.
 *
 * That origin is this process's own address, and deliberately not
 * `PUBLIC_URL`. `PUBLIC_URL` is where the outside world reaches this
 * deployment — a tunnel in development, a domain in production — and it
 * exists to build the webhook URLs handed to Telegram and Meta. Naming it
 * here sent every server-rendered page out over the internet and back, and
 * once the development tunnel had rotated the round trip returned the
 * tunnel provider's own 404. `getSession` cannot tell that from being signed
 * out, so signing in succeeded and the dashboard immediately redirected to
 * /login.
 *
 * `INTERNAL_URL` overrides loopback for a deployment that cannot reach
 * itself on 127.0.0.1; Vercel is that case and is handled below.
 */
const serverOrigin =
  process.env.INTERNAL_URL ??
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `http://127.0.0.1:${process.env.PORT ?? 3000}`);

export const apiBaseUrl = typeof window === "undefined" ? serverOrigin : "";

export async function joinWaitlist(payload: { email: string; company?: string }) {
  const res = await apiFetch("waitlist", { method: "POST", body: JSON.stringify(payload) });

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? "Something went wrong. Try again.");
  }

  return (await res.json()) as { ok: true; alreadyRegistered: boolean };
}
