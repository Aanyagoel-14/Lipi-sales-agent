import { json, route } from "@/server/lib/http";
import { modelSpend } from "@/server/lib/metering";
import { resolveWorkspaceId } from "@/server/lib/workspace";

/**
 * What this workspace has spent on language models today, against its ceilings.
 *
 * Read-only and tenant-scoped like every other `/v1` read: `resolveWorkspaceId`
 * is the only thing that decides whose figures these are. Deliberately not in
 * `v1/contract.ts` — the contracted surface is the commerce objects a customer
 * system integrates against, and a tenant's own cost meter is not one of them.
 */
export const GET = route(async () => {
  const workspaceId = await resolveWorkspaceId();
  return json(await modelSpend(workspaceId));
});
