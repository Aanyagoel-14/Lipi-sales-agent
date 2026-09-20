import { z } from "zod";
import type { ApiScope } from "@/generated/prisma/client";
import { body, json, route } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { newApiKey } from "@/server/lib/api-key";
import { recordEvent } from "@/server/lib/events";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { apiKeyView } from "./view";

/**
 * Managing keys is session-only: every handler in this folder passes
 * `sessionOnly`, which refuses a Bearer credential even when it is valid, so
 * a leaked key cannot mint a replacement for itself and outlive being revoked.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Every key the workspace has, revoked ones included — a revocation is history. */
export const GET = route(async () => {
  const workspaceId = await resolveWorkspaceId({ sessionOnly: true });
  const keys = await prisma.apiKey.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
  });
  return json({ keys: keys.map(apiKeyView) });
});

const createSchema = z.object({
  name: z.string().trim().min(2).max(80),
  /** Read by default: a key is easier to widen later than to un-leak. */
  scopes: z.array(z.enum(["read", "write"])).min(1).max(2).default(["read"]),
  /** Omitted means no expiry — the key lives until someone revokes it. */
  expiresInDays: z.number().int().min(1).max(3650).optional(),
});

export const POST = route(async (req) => {
  const workspaceId = await resolveWorkspaceId({ sessionOnly: true });
  const data = await body(req, createSchema, "Check the key");

  // Write implies read. A key that could POST an order but not GET it back
  // would be a trap rather than a tighter grant.
  const scopes: ApiScope[] = data.scopes.includes("write") ? ["read", "write"] : ["read"];

  const expiresAt = data.expiresInDays ? new Date(Date.now() + data.expiresInDays * DAY_MS) : null;

  const { secret, prefix, hash } = newApiKey();
  const key = await prisma.apiKey.create({
    data: { workspaceId, name: data.name, prefix, hash, scopes, expiresAt },
  });

  await recordEvent(workspaceId, "api_key.created", "operations", `${key.name} (${key.prefix}…)`);

  // Shown exactly once. Only the hash is stored, so no endpoint can return it again.
  return json({ key: apiKeyView(key), secret }, 201);
});
