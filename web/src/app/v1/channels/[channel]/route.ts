import { z } from "zod";
import type { Channel, Prisma } from "@/generated/prisma/client";
import { specFor, type Json } from "@/server/channels/registry";
import { env } from "@/server/env";
import { composio } from "@/server/lib/composio";
import { recordEvent } from "@/server/lib/events";
import { body, HttpError, json, noContent, route } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { publicView } from "../view";

const idSchema = z.string().trim().min(1).max(64);

type Identity = { id: string };

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
 * Settles which of a connected account's identities this workspace uses: a
 * WhatsApp Business Account's numbers, a Facebook account's Pages.
 *
 * An account can hold several and only the operator knows which is theirs, so
 * connect records the list and leaves `externalId` empty rather than guessing.
 * The id is validated against that stored list, not accepted on trust: it
 * becomes the key inbound routing matches on, and a number belonging to
 * someone else's account would quietly steer their customers here.
 *
 * Which field the body carries is the channel spec's to declare, so this
 * route names no channel and adding one needs nothing here.
 */
export const PATCH = route<{ channel: string }>(async (req, params) => {
  const channel = params.channel as Channel;
  const choice = specFor(channel)?.choice;
  if (!choice) throw new HttpError(400, `${params.channel} has nothing to choose`);

  const { connection } = await load(channel);
  const picked = (await body(req, z.object({ [choice.field]: idSchema }),
    `Pick one of this account's ${choice.noun}s`))[choice.field]!;

  const config = (connection.config ?? {}) as Json;
  const candidates = (config[choice.list] ?? []) as Identity[];
  if (!candidates.some((candidate) => candidate.id === picked)) {
    throw new HttpError(422, `That ${choice.noun} is not on this account`,
      { [choice.field]: [`Unknown ${choice.noun}`] });
  }

  try {
    const updated = await prisma.channelConnection.update({
      where: { id: connection.id },
      data: { externalId: picked, config: { ...config, [choice.field]: picked } as Prisma.InputJsonObject },
    });
    return json({ channel: publicView(updated) });
  } catch (error) {
    // `@@unique([channel, externalId])`: two workspaces cannot both claim one
    // number, because inbound for it could then be delivered to either.
    if (isUniqueViolation(error)) {
      throw new HttpError(409, `That ${choice.noun} is already connected to another workspace`);
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
      accountParams: {},
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
      // Telegram's webhook cannot be withdrawn — Composio does not hand the
      // bot token back — so the secret that authenticates it is destroyed
      // instead. Deliveries from the stale webhook now fail the header check
      // and write nothing.
      webhookSecret: null,
      composioAccountId: null, composioAuthConfigId: null, composioTriggerIds: [],
      connectedAt: null, lastError: null,
    },
  });
  await recordEvent(workspaceId, "channel.disconnected", "conversation", channel);

  return noContent();
});
