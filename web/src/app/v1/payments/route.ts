import { json, route } from "@/server/lib/http";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { gatewayView, stripeConnection } from "@/server/payments/stripe";

/**
 * The payment gateways this workspace can collect through, and where each
 * one stands. One today. See docs/runbooks/stripe.md.
 */
export const GET = route(async () => {
  const workspaceId = await resolveWorkspaceId();
  const stripe = await stripeConnection(workspaceId);
  return json({ gateways: [gatewayView(stripe)] });
});
