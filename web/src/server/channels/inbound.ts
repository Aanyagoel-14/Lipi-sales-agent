import { after } from "next/server";
import type { Channel } from "@/generated/prisma/client";
import { prisma } from "@/server/lib/prisma";
import { checkRateLimit } from "@/server/lib/rate-limit";
import { ingest } from "@/server/services/ingest";
import { sendReply } from "./outbound";
import type { ParsedMessage } from "./registry";

/**
 * The one way a customer message enters the building.
 *
 * Three transports reach it — the single Meta callback, the per-connection
 * Telegram route, and (next phase) Composio's trigger webhook — and each of
 * them authenticates its own caller, because each is authenticated
 * differently: Meta signs the raw bytes, Telegram echoes a secret header,
 * Composio signs a Standard Webhooks envelope. What happens *after* that is
 * the same three steps every time, and they are here so there is one copy of
 * them to reason about rather than one per transport.
 *
 * Nothing in this module decides whether a request is genuine. It is called
 * only once the caller has proved itself, and the rate limit below is placed
 * accordingly: throttling before authentication would let an unsigned flood
 * exhaust a real tenant's budget, which is the attack rather than the defence.
 */

/**
 * A real workspace sees a bounded volume of customer messages per minute, and
 * providers retry on their own schedule well inside this. The budget is aimed
 * at a forged or scripted flood, and it is per connection rather than per IP:
 * every Meta tenant now arrives on one URL from Meta's own address range, so
 * an IP bucket would be a single global bucket that one busy workspace could
 * close for everyone.
 */
export const INBOUND_LIMIT = 120;
export const INBOUND_WINDOW_MS = 60_000;

/** All of a `ChannelConnection` that receiving needs. */
export type ReceivingConnection = { id: string; workspaceId: string; channel: Channel };

export const rateLimitKey = (connectionId: string) => `webhook:${connectionId}`;

/**
 * Claims each message, answers the provider, and runs the loop behind the
 * response.
 *
 * The 200 is sent before the work because providers retry a slow reply, and a
 * retry would run the loop twice for one customer message. `after` is what
 * keeps the work alive once the response has gone — on a serverless host the
 * invocation would otherwise be free to end at `return`.
 *
 * The only rows this writes itself are the idempotency claims and the
 * connection's `lastEventAt`. Everything else a message causes happens inside
 * `ingest()`'s transaction, and the reply that follows is `sendReply`'s to
 * record. `status` is deliberately untouched: the route this replaced set it
 * to `connected` on every accepted delivery, which quietly healed a channel
 * whose credential had expired for sending — inbound arriving says nothing
 * about whether outbound works.
 */
export async function receive(
  connection: ReceivingConnection,
  messages: ParsedMessage[],
): Promise<Response> {
  const limited = checkRateLimit(rateLimitKey(connection.id), INBOUND_LIMIT, INBOUND_WINDOW_MS);
  if (!limited.allowed) {
    return new Response(null, { status: 429, headers: { "Retry-After": String(limited.retryAfterSeconds) } });
  }

  // Inbound idempotency. A provider retries a webhook it did not get a
  // fast-enough 200 for, and a retry carries the same message id the parser
  // already read. Each is claimed with an individual `create` against the
  // unique (connectionId, externalId) constraint rather than a batch
  // check-then-insert: a batch check has a race window between reading "not
  // seen" and writing the claim, where two concurrent identical deliveries
  // could both pass. A single `create` is atomic at the row — the loser of a
  // genuine race gets a unique violation and is dropped, never a false
  // "not seen". Claimed here, before `after` is scheduled, so a slow retry
  // arriving while the first delivery is still being worked cannot
  // double-schedule the loop.
  const fresh: ParsedMessage[] = [];
  for (const message of messages) {
    try {
      await prisma.processedMessage.create({
        data: { connectionId: connection.id, externalId: message.externalId },
      });
      fresh.push(message);
    } catch {
      // Unique violation: this externalId was already claimed, by an earlier
      // delivery or a concurrent one. Either way, do not process it again.
    }
  }

  if (!fresh.length) return new Response(null, { status: 200 });

  after(async () => {
    await prisma.channelConnection.update({
      where: { id: connection.id },
      data: { lastEventAt: new Date(), lastError: null },
    }).catch(() => {});

    for (const message of fresh) {
      try {
        const result = await ingest({
          workspaceId: connection.workspaceId,
          channel: connection.channel,
          handle: message.handle,
          text: message.text,
          name: message.name,
        });

        // Only send when the workspace's policy actually cleared it. The
        // reply ingest just persisted is the message being delivered, so
        // `sendReply` can record the outcome on it; a failure is that
        // message's state, not the connection's, and is not caught here.
        if (result.replySent) {
          const reply = await prisma.message.findFirst({
            where: { conversationId: result.conversationId, from: "agent" },
            orderBy: { sentAt: "desc" },
          });
          if (reply) {
            await sendReply({
              workspaceId: connection.workspaceId,
              conversationId: result.conversationId,
              messageId: reply.id,
            });
          }
        }
      } catch (error) {
        // Ingest itself failing is a bug in the loop, not a broken channel,
        // so it is logged and the connection is left alone.
        console.error(`[inbound:${connection.channel}] ${(error as Error).message}`);
      }
    }
  });

  return new Response(null, { status: 200 });
}
