import { z } from "zod";
import { body, HttpError, json, route } from "@/server/lib/http";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { connectRazorpay, gatewayView, KEY_ID } from "@/server/payments/razorpay";

/**
 * Connects the workspace's Razorpay account, in one request, the way an
 * API-key channel connects: the key goes straight to Composio and is never
 * written down, and the row only says `connected` once a real call has come
 * back. The webhook secret is the exception — it is what every delivery is
 * verified against, so it is kept, encrypted.
 */
const schema = z.object({
  keyId: z.string().trim().regex(KEY_ID, "That does not look like a Razorpay Key ID (rzp_test_… or rzp_live_…)"),
  keySecret: z.string().trim().min(10, "Enter the Key Secret").max(200),
  webhookSecret: z.string().trim().min(8, "Enter the secret you set on the webhook in Razorpay").max(200),
});

export const POST = route(async (req) => {
  const workspaceId = await resolveWorkspaceId();
  const input = await body(req, schema, "Enter the Key ID, Key Secret and webhook secret from your Razorpay dashboard");

  const row = await connectRazorpay(workspaceId, input);
  if (row.status !== "connected") {
    throw new HttpError(400, row.lastError ?? "Razorpay did not accept that key");
  }
  return json({ gateway: gatewayView(row, workspaceId) }, 201);
});
