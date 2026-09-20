import type { ChannelConnection } from "@/generated/prisma/client";

/**
 * How a channel row reaches the browser.
 *
 * Two things are deliberately absent. Credentials, because Composio holds
 * them and Lipi could not show one if it wanted to. And the connected account
 * id, because it is a capability: anything holding one can ask Composio about
 * the account. Support needs to recognise an account in a log line, not
 * reproduce it, so only the last four characters travel.
 */
export const publicView = (c: ChannelConnection) => ({
  channel: c.channel,
  status: c.status,
  externalId: c.externalId,
  displayName: c.displayName,
  config: c.config,
  connectedAt: c.connectedAt?.toISOString() ?? null,
  lastEventIso: c.lastEventAt?.toISOString() ?? null,
  lastError: c.lastError,
  accountRef: c.composioAccountId ? `…${c.composioAccountId.slice(-4)}` : null,
});

/** The same shape for a channel this workspace has never connected. */
export const unconnectedView = (channel: string) => ({
  channel,
  status: "disconnected",
  externalId: null,
  displayName: null,
  config: {} as Record<string, never>,
  connectedAt: null,
  lastEventIso: null,
  lastError: null,
  accountRef: null,
});

/**
 * The webchat "install snippet": a single script tag the operator pastes
 * before `</body>` on their own site. The workspaceId travels in the URL
 * itself rather than as a data-attribute the operator could mistype or drop
 * — the same "the id is the public key" model as `cors.ts` documents for the
 * endpoints this script calls.
 */
export const widgetSnippetFor = (publicUrl: string, workspaceId: string) =>
  `<script src="${publicUrl}/static/widget.js" data-workspace="${workspaceId}" async></script>`;
