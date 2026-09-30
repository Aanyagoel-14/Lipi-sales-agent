import { receive } from "@/server/channels/inbound";
import { connectionView, specFor } from "@/server/channels/registry";
import { env } from "@/server/env";
import { crcResponseToken, verifyXSignature } from "@/server/lib/crypto";
import { prisma } from "@/server/lib/prisma";

/**
 * Every X direct message, for every tenant, arrives here.
 *
 * Composio has no X trigger — the twitter toolkit reports zero of them — so
 * inbound is Lipi's, and it is shaped like Meta's rather than Telegram's. X
 * registers a webhook against an *app*, not against an account: one URL is
 * validated with a challenge signed by the app's consumer secret, every
 * delivery is signed with that same secret, and the subscribed account is
 * named in `for_user_id`. A URL per connection would therefore buy nothing
 * — the secret proving it would be identical for all of them — so there is
 * one URL, registered once per deployment, and the tenant comes out of the
 * payload through `(channel, externalId)`.
 *
 * The raw body is preserved for the same reason as Meta's: a signature
 * covers the exact bytes sent, so `req.json()` is never called and the JSON
 * is parsed from the bytes the signature was checked against.
 */
export const runtime = "nodejs";
// Signature verification is over the exact bytes received, so nothing may be
// cached or revalidated between X and this handler.
export const dynamic = "force-dynamic";

const status = (code: number) => new Response(null, { status: code });

/**
 * X's Challenge-Response Check. It runs at registration, on demand and every
 * hour after that; failing it marks the webhook invalid and stops delivery,
 * so this is a permanent obligation rather than a setup step.
 */
export async function GET(req: Request) {
  const crcToken = new URL(req.url).searchParams.get("crc_token");
  if (!crcToken) return status(400);
  // No consumer secret means no way to prove we are who X thinks we are, and
  // no way to check a delivery afterwards either.
  if (!env.X_API_SECRET) return status(401);

  return Response.json({ response_token: crcResponseToken(crcToken, env.X_API_SECRET) });
}

export async function POST(req: Request) {
  const raw = Buffer.from(await req.arrayBuffer());

  if (!env.X_API_SECRET) return status(401);
  if (!verifyXSignature(raw, req.headers.get("x-twitter-webhooks-signature") ?? undefined, env.X_API_SECRET)) {
    return status(401);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    return status(400);
  }

  // Every event in a delivery belongs to the account it was delivered for,
  // and X says which in one field. Anything else — a replay job status, an
  // activity type this deployment never subscribed to, a bare `null` — has
  // no account on it and is nothing to route.
  const forUserId = (payload as { for_user_id?: unknown } | null)?.for_user_id;
  if (typeof forUserId !== "string" || !forUserId) return status(200);

  const connection = await prisma.channelConnection.findUnique({
    where: { channel_externalId: { channel: "x", externalId: forUserId } },
  });
  if (!connection) {
    // Someone else's account, or one this workspace has since disconnected.
    // X retries a non-2xx and eventually invalidates a webhook that keeps
    // failing, so an unroutable body is accepted and dropped, never 4xx'd.
    console.warn(`[webhook:x] no connection for ${forUserId}`);
    return status(200);
  }

  const spec = specFor("x")!;
  return receive(connection, spec.parse(payload, connectionView(connection)));
}
