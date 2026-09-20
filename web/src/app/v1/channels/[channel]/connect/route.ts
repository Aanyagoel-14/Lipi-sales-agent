import { z } from "zod";
import type { Channel } from "@/generated/prisma/client";
import { finishConnection } from "@/server/channels/connect";
import { authConfigIdFor, specFor } from "@/server/channels/registry";
import { env } from "@/server/env";
import { composio } from "@/server/lib/composio";
import { body, HttpError, json, route } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { publicView } from "../../view";

/**
 * Starts a connection. Lipi no longer takes a credential for it.
 *
 * For an OAuth channel this issues a Connect Link and answers with the URL to
 * send the browser to; the operator consents on the provider's own screen and
 * comes back through `/v1/channels/callback`. For an API-key channel the key
 * goes straight to Composio in this request and is never written down — not to
 * a column, not to a log line — and the connection finishes inline, because
 * there is no consent screen to come back from.
 *
 * Either way the row lands in `pending` first and only `finishConnection` is
 * allowed to promote it. Nothing here treats having started as having worked.
 */

const tokenSchema = z.object({ token: z.string().trim().min(20).max(200) });

export const POST = route<{ channel: string }>(async (req, params) => {
  const workspaceId = await resolveWorkspaceId();
  const channel = params.channel as Channel;

  const spec = specFor(channel);
  if (!spec) throw new HttpError(400, `${params.channel} cannot be connected`);

  const authConfigId = authConfigIdFor(spec);
  if (!authConfigId) {
    throw new HttpError(400,
      `${spec.label} is not set up in this deployment (${spec.authConfigEnv} is empty)`);
  }

  // Read the body before anything is torn down: a mistyped token must not
  // cost the operator the connection they already had.
  const token = spec.connect.kind === "api_key"
    ? (await body(req, tokenSchema, spec.connect.hint)).token
    : null;

  const client = composio();
  const existing = await prisma.channelConnection.findUnique({
    where: { workspaceId_channel: { workspaceId, channel } },
  });

  // Reconnect. Composio refuses a second link on an auth config that already
  // holds an active account, so the previous one is retired first — and its
  // triggers with it, or they would keep delivering to a dead connection.
  if (existing?.composioAccountId) await retire(existing.composioTriggerIds, existing.composioAccountId);

  const upsert = (composioAccountId: string) =>
    prisma.channelConnection.upsert({
      where: { workspaceId_channel: { workspaceId, channel } },
      create: {
        workspaceId, channel, status: "pending",
        composioAccountId, composioAuthConfigId: authConfigId,
      },
      update: {
        status: "pending",
        composioAccountId, composioAuthConfigId: authConfigId,
        // A new account may resolve to a different number, bot or mailbox, so
        // nothing derived from the old one survives into the new connection.
        composioTriggerIds: [], externalId: null, displayName: null,
        // The old webhook secret proved the old account's deliveries. If the
        // new one never finishes, a delivery from the webhook the previous
        // token still points at must not be accepted on its strength.
        config: {}, webhookSecret: null, connectedAt: null, lastError: null,
      },
    });

  if (token !== null) {
    const { connectedAccountId } = await callComposio(() =>
      client.initiateApiKey(workspaceId, authConfigId, token,
        spec.connect.kind === "api_key" ? spec.connect.composioField : undefined));

    // The token is handed on by value, for the one hook that cannot go
    // through Composio (Telegram's setWebhook), and is never written down.
    const finished = await finishConnection(await upsert(connectedAccountId), { apiKey: token });
    if (finished.status !== "connected") {
      throw new HttpError(400, finished.lastError ?? `${spec.label} did not accept that token`);
    }
    return json({ redirectUrl: null, channel: publicView(finished) }, 201);
  }

  const { redirectUrl, connectedAccountId } = await callComposio(() =>
    client.link(workspaceId, authConfigId, {
      callbackUrl: `${env.PUBLIC_URL}/v1/channels/callback`,
      alias: channel,
    }));

  return json({ redirectUrl, channel: publicView(await upsert(connectedAccountId)) }, 201);
});

/**
 * Composio's own failures are the operator's problem to see, not a 500. An
 * auth config that no longer exists, a toolkit outage or a rejected key all
 * arrive here as an exception with a message worth showing.
 */
async function callComposio<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw new HttpError(502, (error instanceof Error ? error.message : String(error)).slice(0, 300));
  }
}

/** Best effort: the operator asked for a new connection, not for a report on the old one. */
async function retire(triggerIds: string[], accountId: string) {
  const client = composio();
  for (const triggerId of triggerIds) {
    await client.deleteTrigger(triggerId).catch((error: unknown) =>
      console.error(`composio: could not delete trigger ${triggerId}`, error));
  }
  await client.deleteAccount(accountId).catch((error: unknown) =>
    console.error(`composio: could not delete account ${accountId}`, error));
}
