import { decrypt, verifyRazorpaySignature } from "@/server/lib/crypto";
import { prisma } from "@/server/lib/prisma";
import { handleRazorpayEvent, razorpayConnection } from "@/server/payments/razorpay";

/**
 * One route per workspace, for Razorpay's webhooks.
 *
 * Razorpay signs each delivery with the secret the operator typed into its
 * webhook form — the same secret they typed into Lipi's connect form — so
 * the workspace id in the path is the address and the signature is the
 * proof, exactly as a Telegram connection's id and header are. A wrong or
 * missing signature is a 401 whatever the path says; a workspace with no
 * connection, or one that has disconnected and destroyed its secret, is a
 * 404 and the delivery is never read.
 *
 * Everything verified is acknowledged with a 200, including events this
 * route does not handle: Razorpay retries a non-2xx for a day, and retrying
 * will not make an unknown link known.
 */
export const runtime = "nodejs";
// The signature covers the exact bytes received, so nothing may be cached
// or revalidated between Razorpay and this handler.
export const dynamic = "force-dynamic";

const status = (code: number) => new Response(null, { status: code });

type Params = { params: Promise<{ workspaceId: string }> };

export async function POST(req: Request, ctx: Params) {
  const { workspaceId } = await ctx.params;

  const connection = await razorpayConnection(workspaceId);
  const secret = connection?.webhookSecret ? decrypt(connection.webhookSecret) : null;
  if (!connection || !secret) return status(404);

  const raw = Buffer.from(await req.arrayBuffer());
  if (!verifyRazorpaySignature(raw, req.headers.get("x-razorpay-signature") ?? undefined, secret)) return status(401);

  let payload: unknown;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    return status(400);
  }

  await prisma.paymentConnection.update({ where: { id: connection.id }, data: { lastEventAt: new Date() } });
  await handleRazorpayEvent(workspaceId, payload);
  return status(200);
}
