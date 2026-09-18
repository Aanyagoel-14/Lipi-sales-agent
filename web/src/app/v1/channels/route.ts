import type { ChannelConnection } from "@/generated/prisma/client";
import { catalog } from "@/server/channels/registry";
import { env } from "@/server/env";
import { composio } from "@/server/lib/composio";
import { json, route } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { publicView, unconnectedView, widgetSnippetFor } from "./view";

/**
 * Every channel this deployment knows about, merged with what this workspace
 * has done about each one. The registry decides the list; nothing here
 * enumerates channels.
 */

/**
 * How long a Connect Link is worth waiting on. Composio expires an
 * unfinished one after ten minutes, so a row still `pending` past that had
 * its callback abandoned, lost or closed — and a card that says "connecting…"
 * for ever is worse than one that admits nothing happened.
 */
const PENDING_GRACE_MS = 10 * 60_000;

export const GET = route(async () => {
  const workspaceId = await resolveWorkspaceId();

  const rows = await reconcile(await prisma.channelConnection.findMany({ where: { workspaceId } }));
  const byChannel = new Map(rows.map((row) => [row.channel as string, row]));

  const channels: unknown[] = catalog().map((entry) => {
    const row = byChannel.get(entry.channel);
    return {
      ...(row ? publicView(row) : unconnectedView(entry.channel)),
      label: entry.label,
      connectKind: entry.connect.kind,
      inbound: entry.inbound,
      available: entry.available,
      unavailableReason: entry.unavailableReason ?? null,
      installSnippet: null,
    };
  });

  // Webchat has no provider, no credential and no spec: the widget IS the
  // transport, so it is live the instant the workspace exists. What an
  // operator needs here is the install snippet rather than a Connect button,
  // which is why it is appended by hand instead of being a registry entry.
  channels.push({
    ...unconnectedView("webchat"),
    status: "connected",
    displayName: "Website chat widget",
    label: "Website chat",
    connectKind: "none",
    inbound: { kind: "webchat" },
    available: true,
    unavailableReason: null,
    installSnippet: widgetSnippetFor(env.PUBLIC_URL, workspaceId),
  });

  return json({ channels });
});

/**
 * Brings stale `pending` rows back in line with Composio.
 *
 * The callback is the normal way a connection finishes, and it is also the
 * part that can be lost — the operator closes the tab, the consent screen
 * fails, the link times out. Rather than a background job for something an
 * operator only ever looks at on this page, the list checks the few rows old
 * enough to be suspect and demotes the ones Composio has given up on.
 */
async function reconcile(rows: ChannelConnection[]): Promise<ChannelConnection[]> {
  const cutoff = Date.now() - PENDING_GRACE_MS;
  const stale = rows.filter((row) =>
    row.status === "pending" && row.composioAccountId && row.updatedAt.getTime() < cutoff);
  if (!stale.length) return rows;

  const client = composio();
  const settled = new Map<string, ChannelConnection>();

  for (const row of stale) {
    let reason: string | null = null;
    try {
      const account = await client.getAccount(row.composioAccountId!);
      if (account.status === "EXPIRED" || account.status === "FAILED") {
        reason = account.statusReason ?? "Connection was not completed";
      }
    } catch {
      // Composio deletes an expired link's account outright, so a lookup that
      // cannot find it is the ordinary outcome for an abandoned connect.
      reason = "Connection was not completed in time";
    }
    if (!reason) continue;

    settled.set(row.id, await prisma.channelConnection.update({
      where: { id: row.id },
      data: { status: "disconnected", lastError: reason, composioAccountId: null, composioAuthConfigId: null },
    }));
  }

  return rows.map((row) => settled.get(row.id) ?? row);
}
