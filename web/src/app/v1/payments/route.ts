import { json, route } from "@/server/lib/http";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { gatewayView, razorpayConnection } from "@/server/payments/razorpay";

/**
 * The payment gateways this workspace can collect through, and where each
 * one stands. One today. The webhook URL is in the view because the operator
 * has to paste it into Razorpay's dashboard before they can connect — see
 * docs/runbooks/razorpay.md.
 */
export const GET = route(async () => {
  const workspaceId = await resolveWorkspaceId();
  const razorpay = await razorpayConnection(workspaceId);
  return json({ gateways: [gatewayView(razorpay, workspaceId)] });
});
