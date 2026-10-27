import { noContent, route } from "@/server/lib/http";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { disconnectStripe } from "@/server/payments/stripe";

/** Disconnects, and takes the Composio triggers and account down with it. The row survives as `disconnected`. */
export const DELETE = route(async () => {
  const workspaceId = await resolveWorkspaceId();
  await disconnectStripe(workspaceId);
  return noContent();
});
