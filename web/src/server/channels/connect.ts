import type { ChannelConnection, Prisma } from "@/generated/prisma/client";
import { composio } from "@/server/lib/composio";
import { recordEvent } from "@/server/lib/events";
import { HttpError } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { env } from "../env";
import { specFor, type ChannelSpec, type Json } from "./registry";

/**
 * The step that decides a connection is real.
 *
 * Two paths reach it. An OAuth channel comes back through the browser after
 * Composio's hosted page; an API-key channel never leaves, and finishes in the
 * same request that created the account. Both have to answer the same question
 * — does this account actually work, and whose is it — so both run this, and
 * neither is allowed to shortcut it.
 *
 * The provider's own word is not evidence. Composio appends
 * `?status=success` to the callback before anything has been verified, so the
 * status is re-read from the API, the tenant is re-checked against the account
 * the API reports, and a cheap read tool has to succeed before the row is
 * allowed to say `connected`. An operator who sees "Live" has an account that
 * answered a real call.
 */

/** Trims a provider or SDK message down to something a status chip can hold. */
export const short = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 300);
};

const fail = (row: ChannelConnection, status: "disconnected" | "error", lastError: string) =>
  prisma.channelConnection.update({
    where: { id: row.id },
    data: { status, lastError, connectedAt: null },
  });

/**
 * Verifies a connected account and promotes the row, or records why it could
 * not. Always returns the row as it now stands; callers branch on `status`
 * rather than on a thrown error, because "the operator's token was wrong" is
 * an outcome to display, not an exception.
 *
 * Throws only when the account belongs to another workspace — that is not a
 * failed connection, it is a request for someone else's.
 */
export async function finishConnection(row: ChannelConnection): Promise<ChannelConnection> {
  const spec = specFor(row.channel);
  const accountId = row.composioAccountId;
  if (!spec) throw new HttpError(400, `${row.channel} cannot be connected`);
  if (!accountId) throw new HttpError(409, "This channel has no connection in progress");

  const client = composio();

  let account;
  try {
    account = await client.getAccount(accountId);
  } catch (error) {
    // The 10-minute link expiry deletes an abandoned account outright, so a
    // lookup that fails here usually means the operator took too long.
    return fail(row, "disconnected", short(error));
  }

  // Composio's own record of who the account was created for. The SDK's
  // transform drops `user_id`, which is why the wrapper reads the raw client:
  // without this the callback would accept any account id a browser presented.
  if (account.userId !== row.workspaceId) {
    throw new HttpError(404, "That connection belongs to another workspace");
  }

  if (account.status !== "ACTIVE") {
    return fail(row, "disconnected", account.statusReason ?? "Connection was not completed");
  }

  try {
    const identity = await runIdentity(spec, row.workspaceId, accountId);
    let externalId: string | null = identity.externalId;
    let config = (row.config ?? {}) as Json;
    let triggerIds = row.composioTriggerIds;

    if (spec.afterConnect) {
      const extra = await spec.afterConnect({
        client,
        workspaceId: row.workspaceId,
        connectionId: row.id,
        connectedAccountId: accountId,
        externalId,
        config,
        identityData: identity.data,
        publicUrl: env.PUBLIC_URL,
      });
      // `externalId: null` is a decision ("the operator still has to pick"),
      // so presence of the key matters, not truthiness.
      if ("externalId" in extra) externalId = extra.externalId ?? null;
      if (extra.config) config = { ...config, ...extra.config };
      if (extra.triggerIds) triggerIds = [...new Set([...triggerIds, ...extra.triggerIds])];
    }

    const connected = await prisma.channelConnection.update({
      where: { id: row.id },
      data: {
        status: "connected",
        externalId,
        displayName: identity.displayName,
        config: config as Prisma.InputJsonObject,
        composioTriggerIds: triggerIds,
        connectedAt: new Date(),
        lastError: null,
      },
    });

    await recordEvent(row.workspaceId, "channel.connected", "conversation",
      `${row.channel} as ${identity.displayName}`);
    await rememberChannel(row.workspaceId, row.channel);

    return connected;
  } catch (error) {
    // An account that authenticated but cannot answer a read call is a
    // different failure from one that never authenticated: `error` keeps the
    // account so Test and Reconnect both still have something to act on.
    return fail(row, "error", short(error));
  }
}

/** Runs the spec's identity tool and keeps its raw payload for `afterConnect`. */
export async function runIdentity(spec: ChannelSpec, workspaceId: string, connectedAccountId: string) {
  const result = await composio().execute(spec.identity.slug, {
    userId: workspaceId,
    connectedAccountId,
    arguments: spec.identity.arguments ?? {},
  });
  if (!result.successful) throw new Error(result.error ?? `${spec.label} did not answer`);
  return { ...spec.identity.pick(result.data), data: result.data };
}

/**
 * Adds the channel to the workspace's own list, which drives onboarding and
 * the dashboard's channel filters. Writing the deduped union rather than
 * appending keeps a reconnect from growing the column, and a loser in a
 * concurrent connect rewrites the same set.
 */
async function rememberChannel(workspaceId: string, channel: ChannelConnection["channel"]) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { channels: true },
  });
  if (!workspace || workspace.channels.includes(channel)) return;
  await prisma.workspace
    .update({ where: { id: workspaceId }, data: { channels: [...new Set([...workspace.channels, channel])] } })
    .catch(() => {});
}
