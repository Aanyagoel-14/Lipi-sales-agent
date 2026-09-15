import { z } from "zod";
import { adapterFor } from "@/server/channels/index";
import { registerTelegramWebhook } from "@/server/channels/telegram";
import { encrypt, newWebhookSecret } from "@/server/lib/crypto";
import { env } from "@/server/env";
import { body, HttpError, json, route } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { eventId } from "../../../events";
import { type ChannelName, publicView, webhookUrlFor } from "../../view";

const connectSchema = z.object({
  secret: z.string().trim().min(8).max(500),
  config: z.record(z.string(), z.string().trim().max(200)).default({}),
  // H-3 fix: Meta signs every webhook POST with the app's own App Secret,
  // which is a different credential from `secret` above (the long-lived
  // access token used to SEND messages) and from the auto-generated verify
  // token used for the GET subscription challenge. Required only for
  // Meta-family channels; ignored otherwise.
  metaAppSecret: z.string().trim().min(8).max(500).optional(),
});

const META_CHANNELS = new Set(["whatsapp", "instagram"]);

export const POST = route<{ channel: string }>(async (req, params) => {
  const workspaceId = await resolveWorkspaceId();
  const channel = params.channel as ChannelName;

  const adapter = adapterFor(channel);
  if (!adapter) throw new HttpError(400, `${channel} cannot be connected yet`);

  const data = await body(req, connectSchema, "Check the credentials");

  if (META_CHANNELS.has(channel) && !data.metaAppSecret) {
    throw new HttpError(422, "This channel needs its Meta App Secret to verify inbound webhooks",
      { metaAppSecret: ["Required for whatsapp and instagram"] });
  }

  // Prove the credentials work before storing them, so a connection is never
  // shown as connected when it would fail on the first real message.
  let identity: { displayName: string; externalId: string };
  try {
    identity = await adapter.test({ secret: data.secret, config: data.config });
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }

  const existing = await prisma.channelConnection.findUnique({
    where: { workspaceId_channel: { workspaceId, channel } },
  });
  const webhookSecret = existing?.webhookSecret ?? newWebhookSecret();
  const metaAppSecretCipher = data.metaAppSecret ? encrypt(data.metaAppSecret) : existing?.metaAppSecretCipher ?? null;

  const connection = await prisma.channelConnection.upsert({
    where: { workspaceId_channel: { workspaceId, channel } },
    create: {
      workspaceId, channel, status: "connected",
      secretCipher: encrypt(data.secret), config: data.config,
      webhookSecret, metaAppSecretCipher,
      externalId: identity.externalId, displayName: identity.displayName,
    },
    update: {
      status: "connected", secretCipher: encrypt(data.secret),
      config: data.config, metaAppSecretCipher, externalId: identity.externalId,
      displayName: identity.displayName, lastError: null,
    },
  });

  // Telegram can be pointed at us automatically; Meta requires the operator
  // to paste the URL into the app dashboard themselves.
  const webhookUrl = webhookUrlFor(env.PUBLIC_URL, channel, workspaceId);
  let webhookNote: string | null = null;

  if (channel === "telegram") {
    try {
      await registerTelegramWebhook(data.secret, webhookUrl, webhookSecret);
    } catch (error) {
      webhookNote = (error as Error).message;
      await prisma.channelConnection.update({
        where: { id: connection.id },
        data: { lastError: webhookNote },
      });
    }
  } else {
    webhookNote = "Add this URL to your Meta app webhooks, with the verify token below.";
  }

  // `push` appends unconditionally, so reconnecting the same channel grew the
  // column every time. Writing the deduped union is idempotent, and writing
  // the whole array rather than appending to it is safe under a concurrent
  // connect: the loser rewrites the same set.
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { channels: true },
  });
  if (workspace && !workspace.channels.includes(channel)) {
    await prisma.workspace.update({
      where: { id: workspaceId },
      data: { channels: [...new Set([...workspace.channels, channel])] },
    }).catch(() => {});
  }

  await prisma.twinEvent.create({
    data: {
      id: eventId(), workspaceId, occurredAt: new Date(),
      type: "channel.connected", twin: "conversation",
      payload: `${channel} as ${identity.displayName}`,
    },
  });

  return json({
    channel: publicView({ ...connection }),
    webhookUrl,
    verifyToken: webhookSecret,
    webhookNote,
  }, 201);
});
