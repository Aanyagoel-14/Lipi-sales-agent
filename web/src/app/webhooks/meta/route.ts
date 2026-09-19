import { receive } from "@/server/channels/inbound";
import { specForMetaObject, type ChannelSpec, type Json } from "@/server/channels/registry";
import { env } from "@/server/env";
import { secretsMatch, verifyMetaSignature } from "@/server/lib/crypto";
import { prisma } from "@/server/lib/prisma";
import type { ChannelConnection } from "@/generated/prisma/client";

/**
 * Every Meta message, for every tenant, arrives here.
 *
 * There used to be one callback URL per workspace, verified with an App
 * Secret the operator had to find in Business Manager and paste into Lipi.
 * That was never something Meta supports: a webhook body is signed with the
 * *subscribing app's* secret, and the subscribing app is Lipi's, not the
 * tenant's. So there is one URL, one verify token and one App Secret for the
 * whole deployment, all set once in the Meta app, and the tenant is worked
 * out from the payload — `phone_number_id` for WhatsApp, `entry.id` for an
 * Instagram professional account or a Page.
 *
 * The raw body is preserved because a signature covers the exact bytes sent.
 * Parsing and re-serialising first would change them, so `req.json()` is
 * never called: the signature is checked against `req.arrayBuffer()` and the
 * JSON is parsed from those same bytes afterwards.
 */
export const runtime = "nodejs";
// Signature verification is over the exact bytes received, so nothing may be
// cached or revalidated between Meta and this handler.
export const dynamic = "force-dynamic";

const status = (code: number) => new Response(null, { status: code });

/** Meta verifies ownership of the callback URL with a GET challenge. */
export async function GET(req: Request) {
  const query = new URL(req.url).searchParams;
  const mode = query.get("hub.mode");
  const token = query.get("hub.verify_token") ?? "";
  const challenge = query.get("hub.challenge") ?? "";

  if (mode === "subscribe" && env.META_VERIFY_TOKEN && secretsMatch(token, env.META_VERIFY_TOKEN)) {
    return new Response(challenge, { headers: { "Content-Type": "text/plain" } });
  }

  return status(403);
}

export async function POST(req: Request) {
  const raw = Buffer.from(await req.arrayBuffer());

  // No App Secret means no way to tell a genuine delivery from a forged one.
  // Refusing every body is the only safe reading of that, in development as
  // much as in production — an unverified webhook writes to real twins.
  if (!env.META_APP_SECRET) return status(401);
  if (!verifyMetaSignature(raw, req.headers.get("x-hub-signature-256") ?? undefined, env.META_APP_SECRET)) {
    return status(401);
  }

  let payload: { object?: unknown; entry?: unknown };
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    return status(400);
  }

  const spec = specForMetaObject(payload.object);
  // A product subscribed in the Meta app that this deployment does not
  // serve. Meta retries a non-2xx and eventually disables a callback that
  // keeps failing, so an unroutable body is accepted and dropped, never 4xx'd.
  if (!spec) return status(200);

  const entries = Array.isArray(payload.entry) ? (payload.entry as Json[]) : [];
  let throttled: Response | null = null;

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;

    for (const { externalId, payload: slice } of spec.inbound.kind === "meta" ? spec.inbound.route(entry) : []) {
      const connection = await prisma.channelConnection.findUnique({
        where: { channel_externalId: { channel: spec.channel, externalId } },
      });
      if (!connection) {
        // Someone else's number, or one this workspace has since
        // disconnected. Worth a line in the log, not a retry from Meta.
        console.warn(`[webhook:meta] no ${spec.channel} connection for ${externalId}`);
        continue;
      }

      const answer = await receive(connection, spec.parse(slice, view(connection)));
      // A throttled tenant means its messages were not accepted, so Meta
      // should be told to come back rather than shown a 200 over a drop.
      // Idempotency makes the redelivery of the tenants that did land free.
      if (answer.status === 429) throttled = answer;
    }
  }

  // One delivery can carry entries for several tenants; each is handled on
  // its own and the body as a whole is still acknowledged once.
  return throttled ?? status(200);
}

/** What a parser is allowed to know about the connection it is parsing for. */
const view = (connection: ChannelConnection): Parameters<ChannelSpec["parse"]>[1] => ({
  id: connection.id,
  workspaceId: connection.workspaceId,
  channel: connection.channel,
  externalId: connection.externalId,
  config: (connection.config ?? {}) as Json,
});
