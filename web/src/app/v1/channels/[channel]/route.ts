import { z } from "zod";
import type { Channel } from "@/generated/prisma/client";
import { specFor, type Json } from "@/server/channels/registry";
import { env } from "@/server/env";
import { composio } from "@/server/lib/composio";
import { recordEvent } from "@/server/lib/events";
import { body, HttpError, json, noContent, route } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { publicView } from "../view";

const settingsSchema = z.object({ phoneNumberId: z.string().trim().min(1).max(64) });

type PhoneNumber = { id: string; display?: string; verifiedName?: string };

const isUniqueViolation = (error: unknown) =>
  typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";

const load = async (channel: Channel) => {
  const workspaceId = await resolveWorkspaceId();
  const connection = await prisma.channelConnection.findUnique({
    where: { workspaceId_channel: { workspaceId, channel } },
  });
  if (!connection) throw new HttpError(404, "That channel is not connected");
  return { workspaceId, connection };
};

/**
 * Chooses which of a WhatsApp Business Account's numbers this workspace sends
 * from.
 *
 * A WABA can hold several and only the operator knows which is theirs, so
 * connect records the list and leaves `externalId` empty rather than guessing.
 * The id is validated against that stored list, not accepted on trust: it
 * becomes the key inbound routing matches on, and a number belonging to
 * someone else's account would quietly steer their customers here.
 */
export const PATCH = route<{ channel: string }>(async (req, params) => {
  const channel = params.channel as Channel;
  const { connection } = await load(channel);

  const { phoneNumberId } = await body(req, settingsSchema, "Pick one of this account's numbers");

  const config = (connection.config ?? {}) as Json;
  const numbers = (config.phoneNumbers ?? []) as PhoneNumber[];
  if (!numbers.some((number) => number.id === phoneNumberId)) {
    throw new HttpError(422, "That number is not on this account",
      { phoneNumberId: ["Unknown number"] });
  }

  try {
    const updated = await prisma.channelConnection.update({
      where: { id: connection.id },
      data: { externalId: phoneNumberId, config: { ...config, phoneNumberId } },
    });
    return json({ channel: publicView(updated) });
  } catch (error) {
    // `@@unique([channel, externalId])`: two workspaces cannot both claim one
    // number, because inbound for it could then be delivered to either.
    if (isUniqueViolation(error)) {
      throw new HttpError(409, "That number is already connected to another workspace");
    }
    throw error;
  }
});

/**
 * Disconnects, and takes the Composio side down with it.
 *
 * The row survives as `disconnected` rather than being deleted, so the card
 * keeps its place and its history. Everything that could still cause an
 * effect — trigger instances, the connected account itself — is removed
 * first; a failure there is logged and does not stop the disconnect, because
 * leaving the operator "connected" over a Composio hiccup is the worse
 * outcome of the two.
 */
export const DELETE = route<{ channel: string }>(async (_req, params) => {
  const channel = params.channel as Channel;
  const { workspaceId, connection } = await load(channel);

  const client = composio();
  const spec = specFor(channel);
  const accountId = connection.composioAccountId;

  if (spec?.beforeDisconnect && accountId) {
    await spec.beforeDisconnect({
      client,
      workspaceId,
      connectionId: connection.id,
      connectedAccountId: accountId,
      externalId: connection.externalId,
      config: (connection.config ?? {}) as Json,
      identityData: null,
      publicUrl: env.PUBLIC_URL,
    }).catch((error: unknown) => console.error(`composio: ${channel} beforeDisconnect failed`, error));
  }

  for (const triggerId of connection.composioTriggerIds) {
    await client.deleteTrigger(triggerId).catch((error: unknown) =>
      console.error(`composio: could not delete trigger ${triggerId}`, error));
  }
  if (accountId) {
    await client.deleteAccount(accountId).catch((error: unknown) =>
      console.error(`composio: could not delete account ${accountId}`, error));
  }

  await prisma.channelConnection.update({
    where: { id: connection.id },
    data: {
      status: "disconnected",
      externalId: null, displayName: null, config: {},
      composioAccountId: null, composioAuthConfigId: null, composioTriggerIds: [],
      connectedAt: null, lastError: null,
    },
  });
  await recordEvent(workspaceId, "channel.disconnected", "conversation", channel);

  return noContent();
});
