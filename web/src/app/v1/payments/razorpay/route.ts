import { noContent, route } from "@/server/lib/http";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { disconnectRazorpay } from "@/server/payments/razorpay";

/** Disconnects, and takes the Composio account down with it. The row survives as `disconnected`. */
export const DELETE = route(async () => {
  const workspaceId = await resolveWorkspaceId();
  await disconnectRazorpay(workspaceId);
  return noContent();
});
