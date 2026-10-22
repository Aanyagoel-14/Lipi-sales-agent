import { z } from "zod";
import { body, HttpError, json, route } from "@/server/lib/http";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { connectStripe, gatewayView, SECRET_KEY } from "@/server/payments/stripe";

/**
 * Connects the workspace's Stripe account, in one request, the way an
 * API-key channel connects: the key goes straight to Composio and is never
 * written down, and the row only says `connected` once a real call has come
 * back and the payment triggers exist.
 */
const schema = z.object({
  secretKey: z.string().trim().regex(SECRET_KEY, "That does not look like a Stripe secret key (sk_test_… or sk_live_…)"),
});

export const POST = route(async (req) => {
  const workspaceId = await resolveWorkspaceId();
  const input = await body(req, schema, "Enter the secret key from your Stripe dashboard");

  const row = await connectStripe(workspaceId, input);
  if (row.status !== "connected") {
    throw new HttpError(400, row.lastError ?? "Stripe did not accept that key");
  }
  return json({ gateway: gatewayView(row) }, 201);
});
