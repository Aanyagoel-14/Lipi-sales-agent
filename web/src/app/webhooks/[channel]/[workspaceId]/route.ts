import { after } from "next/server";
import { adapterFor } from "@/server/channels/index";
import { decrypt, secretsMatch, verifyMetaSignature } from "@/server/lib/crypto";
import { prisma } from "@/server/lib/prisma";
import { checkRateLimit, clientIp } from "@/server/lib/rate-limit";
import { ingest } from "@/server/services/ingest";
import type { Channel } from "@/generated/prisma/client";

// L-1 hardening: providers retry on their own schedule and a real workspace
// sees a bounded volume of customer messages per minute, so a per-IP budget
// here is aimed at a forged/scripted flood rather than legitimate retry
// traffic from Meta/Telegram's own infrastructure, which is well under this.
const WEBHOOK_LIMIT = 120;
const WEBHOOK_WINDOW_MS = 60_000;

/**
 * Public endpoints. Providers cannot present a session, so each request is
 * authenticated by the connection's own webhook secret instead: Meta signs the
 * body with the app secret, Telegram echoes a secret token header.
 *
 * The raw body is preserved because a signature covers the exact bytes sent.
 * Parsing and re-serialising first would change them — `req.json()` is never
 * called before the signature has been checked against `req.arrayBuffer()`.
 */
export const runtime = "nodejs";
// Signature verification is over the exact bytes received, so nothing may be
// cached or revalidated between the provider and this handler.
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ channel: string; workspaceId: string }> };

const status = (code: number) => new Response(null, { status: code });

/** Meta verifies ownership of the callback URL with a GET challenge. */
export async function GET(req: Request, ctx: Params) {
  const { channel, workspaceId } = await ctx.params;
  if (channel !== "whatsapp") return status(404);

  const query = new URL(req.url).searchParams;
  const mode = query.get("hub.mode");
  const token = query.get("hub.verify_token") ?? "";
  const challenge = query.get("hub.challenge") ?? "";

  const connection = await prisma.channelConnection.findUnique({
    where: { workspaceId_channel: { workspaceId, channel: "whatsapp" } },
  });

  if (mode === "subscribe" && connection?.webhookSecret && secretsMatch(token, connection.webhookSecret)) {
    return new Response(challenge, { headers: { "Content-Type": "text/plain" } });
  }

  return status(403);
}

export async function POST(req: Request, ctx: Params) {
  const limited = checkRateLimit(`webhook:${clientIp(req)}`, WEBHOOK_LIMIT, WEBHOOK_WINDOW_MS);
  if (!limited.allowed) {
    return new Response(null, { status: 429, headers: { "Retry-After": String(limited.retryAfterSeconds) } });
  }

  const { workspaceId } = await ctx.params;
  const channel = (await ctx.params).channel as Channel;

  const adapter = adapterFor(channel);
  if (!adapter) return status(404);

  const connection = await prisma.channelConnection.findUnique({
    where: { workspaceId_channel: { workspaceId, channel } },
  });
  if (!connection) return status(404);

  const body = Buffer.from(await req.arrayBuffer());

  // H-3 fix: Meta signs the raw body with the App Secret, a credential
  // distinct from `webhookSecret` (the operator-chosen verify token used
  // only for the GET subscription challenge above). The previous code
  // verified the HMAC against `webhookSecret`, which can never match a
  // genuine Meta signature. `metaAppSecretCipher` is null until the operator
  // has entered it via the connect flow, in which case a Meta webhook
  // cannot authenticate — surfaced as 401, not silently accepted.
  let authentic: boolean;
  if (channel === "telegram") {
    // Nullable since the Composio track; a row without one cannot authenticate.
    authentic = connection.webhookSecret !== null
      && secretsMatch(req.headers.get("x-telegram-bot-api-secret-token") ?? "", connection.webhookSecret);
  } else {
    const appSecret = connection.metaAppSecretCipher ? decrypt(connection.metaAppSecretCipher) : null;
    authentic = Boolean(appSecret) &&
      verifyMetaSignature(body, req.headers.get("x-hub-signature-256") ?? undefined, appSecret!);
  }

  if (!authentic) return status(401);

  let payload: unknown;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    return status(400);
  }

  const parsed = adapter.parse(payload);

  // H-3 fix: inbound idempotency. A provider retries a webhook it did not
  // get a fast-enough 200 for, and a retry carries the same message id
  // (`externalId`) the adapter already parses. Without checking it, a retry
  // re-runs the full ingest loop for a message already processed —
  // duplicating orders and reservations for one real customer send.
  //
  // Checked here, before scheduling `after()`, rather than inside it, so a
  // slow retry that arrives while the first delivery is still being worked
  // cannot double-schedule the ingest loop. Each message is claimed with an
  // individual `create` against the unique (connectionId, externalId)
  // constraint rather than a batch pre-check-then-insert: a batch check has
  // a race window between reading "not seen" and writing the claim, where
  // two concurrent identical deliveries could both pass. A single `create`
  // is atomic at the row — the loser of a genuine race gets a unique
  // violation and is dropped, never a false "not seen".
  const messages: typeof parsed = [];
  for (const message of parsed) {
    try {
      await prisma.processedMessage.create({
        data: { connectionId: connection.id, externalId: message.externalId },
      });
      messages.push(message);
    } catch {
      // Unique violation: this externalId was already claimed, by an earlier
      // delivery or a concurrent one. Either way, do not process it again.
    }
  }

  // Acknowledge before doing the work. Providers retry on a slow response, and
  // a retry would run the loop twice for one customer message. `after` is what
  // keeps the work alive once the response has been sent — on a serverless
  // host the invocation would otherwise be free to end at `return`.
  if (messages.length) {
    after(async () => {
      await prisma.channelConnection.update({
        where: { id: connection.id },
        data: { lastEventAt: new Date(), status: "connected", lastError: null },
      }).catch(() => {});

      for (const message of messages) {
        try {
          const result = await ingest({
            workspaceId, channel, handle: message.handle,
            text: message.text, name: message.name,
          });

          // Only send when the workspace's policy actually cleared it.
          if (result.replySent && connection.secretCipher) {
            const secret = decrypt(connection.secretCipher);
            if (secret) {
              await adapter.send({
                secret,
                config: connection.config as Record<string, unknown>,
                to: message.handle,
                text: result.reply,
              });
            }
          }
        } catch (error) {
          console.error(`[webhook:${channel}] ${(error as Error).message}`);
          await prisma.channelConnection.update({
            where: { id: connection.id },
            data: { status: "error", lastError: (error as Error).message.slice(0, 300) },
          }).catch(() => {});
        }
      }
    });
  }

  return status(200);
}
