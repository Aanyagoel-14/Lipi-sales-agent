import { apiFetch } from "./client";

/**
 * Where API calls go.
 *
 * The API is served by this same app, so the browser wants a relative URL and
 * gets one. The server does not: `fetch` on the server has no origin to
 * resolve against, so a server component calling its own route handler has to
 * name the origin in full.
 */
const serverOrigin =
  process.env.PUBLIC_URL ??
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
