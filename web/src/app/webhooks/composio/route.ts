import { receive } from "@/server/channels/inbound";
import { connectionView, specFor } from "@/server/channels/registry";
import { composio, ComposioWebhookError, type ComposioEvent } from "@/server/lib/composio";
import { recordEvent } from "@/server/lib/events";
import { prisma } from "@/server/lib/prisma";
import { handleStripeTrigger, isStripeTrigger, stripeNeedsReconnect } from "@/server/payments/stripe";

/**
 * The one endpoint Composio delivers to, for every workspace, every channel
 * and the payment gateway. There is no per-tenant URL to register and no
 * per-tenant secret: deliveries are signed at the project level and routed
 * by the connected account or trigger instance they name.
 *
 * Only a bad signature answers non-2xx, apart from a throttled trigger
 * delivery (see `triggerMessage`). Everything else — an account no
 * workspace owns, an event type this phase does not handle — is acknowledged,
 * because Composio retries a non-2xx and retrying will not make an unknown
 * account known.
 *
 * Handlers are idempotent rather than deduplicated. A retried delivery
 * carries the same `webhook-id`, but a row already in `needs_reconnect` is
 * left alone, so the second copy writes nothing and logs no second event.
 * That is cheaper and more honest than a table of ids to forget to prune.
 */

export const runtime = "nodejs";
// The signature covers the exact bytes received, so nothing may be cached or
// revalidated between Composio and this handler.
export const dynamic = "force-dynamic";

const ok = () => new Response(null, { status: 200 });
const str = (value: unknown): string | undefined =>
  typeof value === "string" && value ? value : undefined;

export async function POST(req: Request) {
  const raw = await req.text();

  let event;
  try {
    event = composio().verifyWebhook(raw, req.headers);
  } catch (error) {
    const reason = error instanceof ComposioWebhookError ? error.reason : "unknown";
    console.warn(`composio webhook rejected: ${reason}`);
    return new Response(null, { status: 401 });
  }

  switch (event.type) {
    case "composio.connected_account.expired": {
      const accountId = str(event.data.id);
      if (accountId) {
        await needsReconnect(
          { composioAccountId: accountId },
          str(event.data.status_reason) ?? "This connection expired. Connect it again.",
          accountId,
        );
      }
      return ok();
    }

    case "composio.trigger.disabled": {
      // Fires when auth expiry takes a trigger instance down with it, so it
      // means the same thing to the operator as an expired account.
      const triggerId = str(event.data.id);
      if (triggerId) {
        await needsReconnect(
          { composioTriggerIds: { has: triggerId } },
          str(event.data.disabled_reason) ?? "Message delivery for this connection was switched off.",
          triggerId,
        );
      }
      return ok();
    }

    case "composio.trigger.message":
      return triggerMessage(event);

    default:
      console.log(`composio webhook: nothing handles ${event.type}`);
      return ok();
  }
}

/**
 * A trigger's delivery, routed by the connected account it names, which is
 * unique to one connection — a channel's or the payment gateway's — so a
 * delivery can only ever land in the workspace that owns that account. The
 * trigger slug must also be one that connection listens on: an account
 * carries one or two triggers, and one it does not expect is a delivery to
 * drop, not to parse as something else.
 *
 * A channel's delivery goes to the same `receive()` every other channel
 * uses. A redelivery carries the same Gmail message id, and `receive()`
 * claims that id before anything runs, so the retry writes nothing; its own
 * 429 is passed back, which Composio retries, which is what a throttled
 * tenant wants. A payment's delivery settles the invoice it names, and a
 * paid invoice settles no further.
 */
async function triggerMessage(event: ComposioEvent): Promise<Response> {
  const accountId = str(event.metadata.connected_account_id);
  const slug = str(event.metadata.trigger_slug);
  if (!accountId) {
    console.log("composio webhook: delivery names no connected account");
    return ok();
  }

  const connection = await prisma.channelConnection.findFirst({ where: { composioAccountId: accountId } });
  if (connection) {
    const spec = specFor(connection.channel);
    if (spec?.inbound.kind !== "composio_trigger" || spec.inbound.slug !== slug) {
      console.log(`composio webhook: ${connection.channel} does not listen on ${slug ?? "?"}`);
      return ok();
    }
    return receive(connection, spec.parse(event.data, connectionView(connection)));
  }

  const gateway = await prisma.paymentConnection.findFirst({ where: { composioAccountId: accountId } });
  if (gateway) {
    if (gateway.provider !== "stripe" || !isStripeTrigger(slug)) {
      console.log(`composio webhook: ${gateway.provider} does not listen on ${slug ?? "?"}`);
      return ok();
    }
    await handleStripeTrigger(gateway, event.data);
    return ok();
  }

  console.log(`composio webhook: no connection for ${accountId}`);
  return ok();
}

/**
 * Flips the connection this event is about, if it is one of ours — a
 * channel's or the payment gateway's. Anything unrecognised is logged and
 * acknowledged: Composio's project webhook is not scoped to this
 * deployment's database, so an account from another environment sharing the
 * project is an expected arrival, not an error.
 */
async function needsReconnect(
  where: { composioAccountId: string } | { composioTriggerIds: { has: string } },
  reason: string,
  subject: string,
) {
  const connection = await prisma.channelConnection.findFirst({ where });
  if (connection) {
    if (connection.status === "needs_reconnect") return;
    await prisma.channelConnection.update({
      where: { id: connection.id },
      data: { status: "needs_reconnect", lastError: reason.slice(0, 300) },
    });
    await recordEvent(connection.workspaceId, "channel.expired", "conversation",
      `${connection.channel}: ${reason.slice(0, 200)}`);
    return;
  }

  const gateway = await prisma.paymentConnection.findFirst({ where });
  if (gateway) {
    await stripeNeedsReconnect(gateway, reason);
    return;
  }

  console.log(`composio webhook: no connection for ${subject}`);
}
