import type { ApiKey } from "@/generated/prisma/client";

/**
 * What a key looks like from outside. The hash never leaves the database and
 * the secret never exists again after creation, so this is everything there
 * is to show: enough to identify a key, revoke it, and see whether anything
 * is still calling with it.
 */
export function apiKeyView(key: ApiKey) {
  return {
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    scopes: key.scopes,
    createdIso: key.createdAt.toISOString(),
    lastUsedIso: key.lastUsedAt?.toISOString() ?? null,
    expiresIso: key.expiresAt?.toISOString() ?? null,
    revokedIso: key.revokedAt?.toISOString() ?? null,
  };
}
