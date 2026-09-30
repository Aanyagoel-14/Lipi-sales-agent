import { z } from "zod";
import type { Channel } from "@/generated/prisma/client";
import { finishConnection } from "@/server/channels/connect";
import { authConfigIdFor, specFor, type ChannelSpec } from "@/server/channels/registry";
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

// A Meta system-user token runs well past a Telegram bot token's length.
const tokenField = z.string().trim().min(20).max(1000);

/**
 * The key, plus whatever non-secret fields the channel declares beside it.
 * Built from the spec so a channel's form and its validation cannot drift.
 */
const credentialSchema = (spec: ChannelSpec) =>
  z.object({
    token: tokenField,
    ...Object.fromEntries((spec.connect.kind === "api_key" ? spec.connect.extras ?? [] : []).map((extra) => [
      extra.field,
      z.string({ error: `Enter the ${extra.label}` }).trim().regex(extra.pattern, `That does not look like a ${extra.label}`),
    ])),
  });

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
  const credential = spec.connect.kind === "api_key"
    ? (await body(req, credentialSchema(spec), spec.connect.hint).catch(namedField)) as { token: string } & Record<string, string>
    : null;
  const token = credential?.token ?? null;
  // Keyed by Composio's names, which is what both Composio and the
  // post-connect hook read them as.
  const extra = Object.fromEntries((spec.connect.kind === "api_key" ? spec.connect.extras ?? [] : [])
    .map((e) => [e.composioField, credential![e.field]!]));

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
        spec.connect.kind === "api_key" ? spec.connect.composioField : undefined, extra));

    // The token is handed on by value, for the one hook that cannot go
    // through Composio (Telegram's setWebhook), and is never written down.
    const finished = await finishConnection(await upsert(connectedAccountId), { apiKey: token, params: extra });
    if (finished.status !== "connected") {
      throw new HttpError(400, finished.lastError ?? `${spec.label} did not accept that token`);
    }
    return json({ redirectUrl: null, channel: publicView(finished) }, 201);
  }

  // Back to the origin the operator started from, not `PUBLIC_URL`. The
  // callback is a browser redirect, not a delivery: it only works carrying the
  // operator's session cookie, and that cookie belongs to the address they
  // are signed in on. In development that is localhost while `PUBLIC_URL` is
  // a tunnel, so the round trip came back signed out — a 401 behind ngrok's
  // warning page — and the connection never reported either way.
  const { redirectUrl, connectedAccountId } = await callComposio(() =>
    client.link(workspaceId, authConfigId, {
      callbackUrl: `${new URL(req.url).origin}/v1/channels/callback`,
      alias: channel,
    }));

  return json({ redirectUrl, channel: publicView(await upsert(connectedAccountId)) }, 201);
});

/**
 * A bad token keeps the channel's own hint as the message, but a bad companion
 * field says which one it was: "check your token" in answer to a mistyped
 * WABA id sends the operator to fix the wrong box.
 */
function namedField(error: unknown): never {
  if (error instanceof HttpError && error.details && typeof error.details === "object") {
    const fields = error.details as Record<string, string[] | undefined>;
    const other = Object.entries(fields).find(([name, issues]) => name !== "token" && issues?.length);
    if (!fields.token?.length && other) throw new HttpError(422, other[1]![0]!, fields);
  }
  throw error;
}

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
