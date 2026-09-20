import { headers } from "next/headers";
import type { ApiScope } from "@/generated/prisma/client";
import { prisma } from "./prisma";
import { HttpError, requestInFlight } from "./http";
import { hasSessionCookie, requireUser } from "./session";
import { checkRateLimit } from "./rate-limit";
import {
  API_KEY_LIMIT,
  API_KEY_WINDOW_MS,
  apiKeyRateLimitKey,
  authenticateApiKey,
  bearerToken,
  touchApiKey,
} from "./api-key";

/** A GET or a HEAD reads; anything else is treated as a write. */
const READ_METHODS = new Set(["GET", "HEAD"]);

export type ResolveOptions = {
  /**
   * Refuses an API key even when one is valid. Set on the endpoints that
   * manage keys themselves: a key that can mint its own successors survives
   * its own revocation, so that door stays behind a human's session.
   */
  sessionOnly?: boolean;
};

/**
 * Resolves the tenant for a request from its credential, never from client input.
 *
 * Two credentials reach here and there is deliberately one function for both,
 * because a second resolver is how one of them ends up missing a check the
 * other has:
 *
 * - A **session cookie**. The `x-workspace-id` header may *choose* between
 *   workspaces the signed-in user belongs to, but membership is checked on
 *   every request. Trusting the header alone would let anyone read any tenant
 *   by editing one value.
 * - An **API key** in `Authorization: Bearer`, for a caller with no browser.
 *   A key names its own workspace and cannot be pointed at another, so the
 *   header is only ever allowed to agree with it.
 *
 * A request carrying both is rejected rather than resolved by precedence.
 * Either choice of winner silently acts on a tenant the caller did not mean —
 * the key's workspace while the cookie's user watches their own dashboard, or
 * the cookie's while the key is ignored entirely — and a caller that sends
 * both has a bug it is better off seeing.
 */
export async function resolveWorkspaceId(options: ResolveOptions = {}): Promise<string> {
  const requestHeaders = await headers();
  const presented = bearerToken(requestHeaders);

  if (presented && (await hasSessionCookie())) {
    throw new HttpError(400, "Send a session cookie or an API key, not both");
  }

  if (presented) {
    if (options.sessionOnly) {
      throw new HttpError(403, "An API key cannot manage API keys. Sign in instead.");
    }
    return resolveFromApiKey(presented, requestHeaders.get("x-workspace-id"));
  }

  const user = await requireUser();

  if (!user.workspaceIds.length) {
    throw new HttpError(409, "No workspace yet. Finish onboarding first.");
  }

  const requested = requestHeaders.get("x-workspace-id");
  if (requested && !user.workspaceIds.includes(requested)) {
    // Distinguish a stale client cookie from a genuine cross-tenant attempt.
    // A workspace that no longer exists is the former: hard-failing every page
    // over a leftover cookie is not something a user can recover from.
    const exists = await prisma.workspace.findUnique({ where: { id: requested }, select: { id: true } });
    if (exists) throw new HttpError(403, "You do not have access to that workspace");
  } else if (requested) {
    return requested;
  }

  const first = await prisma.workspace.findFirst({
    where: { id: { in: user.workspaceIds } },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });

  return first!.id;
}

async function resolveFromApiKey(presented: string, requested: string | null): Promise<string> {
  const key = await authenticateApiKey(presented);
  // Unknown, malformed and revoked are one answer. A 401 that distinguished
  // them would confirm which secrets had once been real.
  if (!key) throw new HttpError(401, "That API key is not valid");

  const limited = checkRateLimit(apiKeyRateLimitKey(key.id), API_KEY_LIMIT, API_KEY_WINDOW_MS);
  if (!limited.allowed) {
    throw new HttpError(429, "Too many requests", undefined, {
      "Retry-After": String(limited.retryAfterSeconds),
    });
  }

  requireScope(key.scopes);

  // A key names its workspace. The header is allowed to restate it and
  // nothing else — treating a mismatch as a choice is exactly the
  // client-supplied tenant this function exists to refuse.
  if (requested && requested !== key.workspaceId) {
    throw new HttpError(403, "That API key does not belong to that workspace");
  }

  touchApiKey(key);
  return key.workspaceId;
}

function requireScope(scopes: ApiScope[]) {
  // No request in flight means no method to judge, which happens only outside
  // a `route()` wrapper. Assume the stricter of the two rather than the one
  // that would let a read-only key through a mutation unnoticed.
  const method = requestInFlight()?.method?.toUpperCase();
  const needed: ApiScope = method && READ_METHODS.has(method) ? "read" : "write";

  if (!scopes.includes(needed)) {
    throw new HttpError(403, `That API key is not scoped to ${needed}`);
  }
}
