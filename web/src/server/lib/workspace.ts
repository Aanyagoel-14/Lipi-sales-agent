import { headers } from "next/headers";
import { prisma } from "./prisma";
import { HttpError } from "./http";
import { requireUser } from "./session";

/**
 * Resolves the tenant for a request from the session, never from client input.
 *
 * The header may *choose* between workspaces the signed-in user belongs to,
 * but membership is checked on every request. Trusting the header alone would
 * let anyone read any tenant by editing one value.
 */
export async function resolveWorkspaceId(): Promise<string> {
  const user = await requireUser();

  if (!user.workspaceIds.length) {
    throw new HttpError(409, "No workspace yet. Finish onboarding first.");
  }

  const requested = (await headers()).get("x-workspace-id");
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
