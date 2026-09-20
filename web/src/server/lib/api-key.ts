import { createHash, randomBytes } from "node:crypto";
import { after } from "next/server";
import type { ApiScope } from "@/generated/prisma/client";
import { prisma } from "./prisma";

/**
 * API keys: the way in for a caller that has no browser and so no session.
 *
 * A WordPress plugin, a customer's own backend or a Lovable app cannot hold a
 * cookie, and the only unauthenticated surface this app has is the webchat
 * widget, which is deliberately narrow. A key fills that gap without widening
 * anything: it resolves to exactly one workspace, it is checked in the same
 * choke point the session is (`resolveWorkspaceId`), and it can be revoked
 * with a single write.
 *
 * The secret is shown once and stored only as a hash — the pattern
 * `InventoryConnector.secretHash` already set. The difference here is that
 * the lookup is *by* hash rather than by id: a presented key is hashed and
 * matched against a unique index, so verification is one read regardless of
 * how many keys a deployment has issued, and a wrong key never reaches a
 * comparison whose duration could leak how close it was.
 */

/** `lipi_sk_` marks it as a secret key in a log the way Stripe's `sk_` does. */
const PREFIX = "lipi_sk_";
/** Enough of the secret to tell two keys apart, too little to guess the rest. */
const PREFIX_LENGTH = PREFIX.length + 8;

const hashApiKey = (secret: string) => createHash("sha256").update(secret).digest("hex");

/** Mints a key. The secret exists in memory here and nowhere else, ever again. */
export function newApiKey() {
  const secret = `${PREFIX}${randomBytes(24).toString("base64url")}`;
  return { secret, prefix: secret.slice(0, PREFIX_LENGTH), hash: hashApiKey(secret) };
}

/** The `Bearer <key>` a caller presented, or null if it did not present one. */
export function bearerToken(headers: Headers): string | null {
  const header = headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

export type ResolvedKey = {
  id: string;
  workspaceId: string;
  scopes: ApiScope[];
  lastUsedAt: Date | null;
};

/**
 * Resolves a presented secret to a live key, or null for anything else —
 * unknown, malformed, revoked and expired all answer the same way, because
 * telling a caller which of the four it was is telling it something it has
 * not earned.
 */
export async function authenticateApiKey(secret: string): Promise<ResolvedKey | null> {
  const key = await prisma.apiKey.findUnique({
    where: { hash: hashApiKey(secret) },
    select: {
      id: true,
      workspaceId: true,
      scopes: true,
      lastUsedAt: true,
      expiresAt: true,
      revokedAt: true,
    },
  });
  if (!key || key.revokedAt) return null;
  // Expiry is enforced on read rather than swept by a job: a key that has run
  // out must stop working at the instant it does, not when something notices.
  if (key.expiresAt && key.expiresAt <= new Date()) return null;

  // Only what the choke point needs. `revokedAt` and `expiresAt` have done
  // their work above and nothing downstream should get to re-decide them.
  return { id: key.id, workspaceId: key.workspaceId, scopes: key.scopes, lastUsedAt: key.lastUsedAt };
}

/**
 * How stale `lastUsedAt` is allowed to be.
 *
 * "When was this key last used" is an operator's question, answered in hours;
 * writing a row on every request to answer it in milliseconds would put an
 * update in front of every read the key makes. So the write is coalesced to
 * once a minute per key and scheduled with `after()`, which means it never
 * joins the request's own transaction and never delays its response.
 */
const LAST_USED_COALESCE_MS = 60_000;

export function touchApiKey(key: ResolvedKey) {
  const now = Date.now();
  if (key.lastUsedAt && now - key.lastUsedAt.getTime() < LAST_USED_COALESCE_MS) return;

  after(async () => {
    // A key revoked between the request and this write is left alone: the
    // update is bookkeeping, and resurrecting a dead row's timestamp would
    // make a revoked key look live in the dashboard.
    await prisma.apiKey
      .updateMany({ where: { id: key.id, revokedAt: null }, data: { lastUsedAt: new Date(now) } })
      .catch(() => {});
  });
}

/**
 * Per-key budget. Unlike the public webchat endpoints there is a stable tenant
 * identity to throttle against here, so the bucket is the key itself: one
 * misbehaving integration cannot spend another workspace's allowance, and
 * rotating source IPs does not buy an abuser a fresh one.
 */
export const API_KEY_LIMIT = 600;
export const API_KEY_WINDOW_MS = 60_000;
export const apiKeyRateLimitKey = (id: string) => `apikey:${id}`;
