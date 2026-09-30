import { z } from "zod";
import type { Channel } from "@/generated/prisma/client";
import { body, HttpError, json, route } from "@/server/lib/http";
import { preflight } from "@/server/lib/origins";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { sell } from "@/server/services/selling";

/**
 * `POST /v1/conversations/ingest` — PRD §8.1.
 *
 * The PRD prints this contract verbatim, and it is not the shape the rest of
 * this API speaks: `source_channel` in upper case, `external_sender_id`, a
 * nested `payload`, a `metadata` block naming the business account the message
 * arrived at. Rather than bend the PRD's integrators to `/v1/messages`'
 * camelCase, or bend the repository's conventions to the PRD's snake_case,
 * this endpoint translates one into the other and hands the result to the same
 * `sell()` every channel webhook already uses.
 *
 * It calls `sell()` rather than `ingest()` directly — the difference matters.
 * `ingest()` decides what is true and composes a plain reply; `sell()` runs
 * `ingest()` and then lets the model voice the facts it produced. An
 * integrator posting a customer message wants the reply the customer would
 * have got, which is the second one.
 *
 * `metadata.business_account_id` is accepted and checked rather than ignored.
 * It names a channel connection, and a caller who names one that belongs to
 * another tenant, or to another channel, is told so — silently ignoring it
 * would let an integrator believe they had routed a message somewhere they had
 * not.
 */

/** The PRD's channel vocabulary for inbound. */
const SOURCE_CHANNELS: Record<string, Channel> = {
  WHATSAPP: "whatsapp",
  TELEGRAM: "telegram",
  INSTAGRAM: "instagram",
  FACEBOOK: "facebook",
  MESSENGER: "facebook",
  X: "x",
  TWITTER: "x",
  EMAIL: "email",
  WEB_SDK: "webchat",
  WEBCHAT: "webchat",
};

const ingestSchema = z.object({
  source_channel: z.string().min(1),
  external_sender_id: z.string().trim().min(1).max(120),
  payload: z.object({
    /**
     * Only `text` carries a message today. The field exists in the PRD's
     * contract, so it is accepted and validated rather than dropped — a
     * caller sending `image` gets told this deployment cannot take one, which
     * is a different and more useful answer from a message that vanishes.
     */
    type: z.enum(["text", "image", "audio", "document"]),
    content: z.string().trim().min(1).max(2000),
  }),
  metadata: z
    .object({
      business_account_id: z.string().min(1).optional(),
      sender_name: z.string().trim().max(120).optional(),
    })
    .optional(),
});

export const POST = route(async (req) => {
  const workspaceId = await resolveWorkspaceId();
  const input = await body(req, ingestSchema, "Invalid conversation ingest");

  const channel = SOURCE_CHANNELS[input.source_channel.trim().toUpperCase()];
  if (!channel) {
    throw new HttpError(422, `Unknown source_channel "${input.source_channel}"`, {
      source_channel: Object.keys(SOURCE_CHANNELS),
    });
  }

  if (input.payload.type !== "text") {
    throw new HttpError(
      422,
      `This deployment ingests text messages only; received "${input.payload.type}"`,
      { payload: ["type must be text"] },
    );
  }

  // The account the message arrived at, when the caller named one. Checked
  // against this workspace's own connections, so it can only ever confirm
  // what the credential already decided — never redirect to another tenant.
  const account = input.metadata?.business_account_id;
  if (account) {
    const connection = await prisma.channelConnection.findFirst({
      where: { workspaceId, externalId: account },
      select: { channel: true },
    });
    if (!connection) {
      throw new HttpError(404, `No ${channel} connection in this workspace for business account ${account}`);
    }
    if (connection.channel !== channel) {
      throw new HttpError(
        409,
        `Business account ${account} is connected as ${connection.channel}, not ${channel}`,
      );
    }
  }

  const result = await sell({
    workspaceId,
    channel,
    handle: input.external_sender_id,
    name: input.metadata?.sender_name,
    text: input.payload.content,
  });

  return json(
    {
      conversation_id: result.conversationId,
      customer_id: result.customer.id,
      intent: result.intent,
      reply: result.reply,
      /** Whether the reply was sent or is waiting for a human (§2 Step 02). */
      held: result.held,
      voiced_by: result.voicedBy,
      matched: result.matched,
      order: result.order,
      invoice: result.invoice,
      degraded: result.degraded ?? null,
    },
    201,
  );
});

export const OPTIONS = route(preflight);
