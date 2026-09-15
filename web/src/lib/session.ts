import { cookies } from "next/headers";
import { apiBaseUrl } from "./api";

export const SESSION_COOKIE = "lipi_session";
export const WORKSPACE_ID_COOKIE = "lipi_workspace_id";

/**
 * Server components run on the server, so the browser's cookies are not
 * attached to outgoing fetches automatically. Every API call from a server
 * component has to forward the session itself or it arrives unauthenticated.
 */
export async function apiHeaders(): Promise<Record<string, string>> {
  const jar = await cookies();
  const session = jar.get(SESSION_COOKIE)?.value;
  const workspace = jar.get(WORKSPACE_ID_COOKIE)?.value;

  return {
    ...(session ? { cookie: `${SESSION_COOKIE}=${session}` } : {}),
    ...(workspace ? { "x-workspace-id": workspace } : {}),
  };
}

export type SessionUser = { id: string; email: string; name: string };
export type SessionWorkspace = { id: string; name: string; vertical: string; onboardedAt: string | null };

export async function getSession(): Promise<{ user: SessionUser | null; workspaces: SessionWorkspace[] }> {
  try {
    const res = await fetch(`${apiBaseUrl}/v1/auth/me`, { headers: await apiHeaders(), cache: "no-store" });
    if (!res.ok) return { user: null, workspaces: [] };
    const body = (await res.json()) as { user: SessionUser | null; workspaces?: SessionWorkspace[] };
    return { user: body.user, workspaces: body.workspaces ?? [] };
  } catch {
    // API unreachable is indistinguishable from signed out, for routing purposes.
    return { user: null, workspaces: [] };
  }
}
