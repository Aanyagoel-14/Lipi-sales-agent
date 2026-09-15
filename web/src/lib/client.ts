import { apiBaseUrl } from "./api";

/**
 * Browser-side API calls.
 *
 * Always credentialed: the session lives in an httpOnly cookie on the API's
 * origin, and a fetch without credentials arrives unauthenticated. Making that
 * the default here means no call site can forget it.
 */
/**
 * The chosen workspace, read from the cookie the wizard writes.
 *
 * Server components forward this as a header on every read. Without it here a
 * browser call falls back to the user's *first* workspace, so a member of more
 * than one would act on a different tenant than the page they are looking at.
 */
function workspaceHeader(): Record<string, string> {
  if (typeof document === "undefined") return {};
  const match = document.cookie.match(/(?:^|;\s*)lipi_workspace_id=([^;]*)/);
  const id = match?.[1] ? decodeURIComponent(match[1]) : "";
  return id ? { "x-workspace-id": id } : {};
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${apiBaseUrl}/v1/${path.replace(/^\//, "")}`, {
    ...init,
    credentials: "include",
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...workspaceHeader(),
      ...init.headers,
    },
  });
}

/** Throws on a non-2xx, surfacing the API's own message where it gives one. */
export async function apiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}
