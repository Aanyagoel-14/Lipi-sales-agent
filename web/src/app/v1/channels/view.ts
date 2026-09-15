export const CHANNELS = ["whatsapp", "instagram", "telegram", "email", "webchat"] as const;
export type ChannelName = (typeof CHANNELS)[number];

/** Secrets are never returned. The operator can replace one, not read it back. */
export const publicView = (c: {
  channel: string; status: string; externalId: string | null; displayName: string | null;
  config: unknown; lastEventAt: Date | null; lastError: string | null; secretCipher: string | null;
}) => ({
  channel: c.channel,
  status: c.status,
  externalId: c.externalId,
  displayName: c.displayName,
  config: c.config,
  hasCredentials: Boolean(c.secretCipher),
  lastEventIso: c.lastEventAt?.toISOString() ?? null,
  lastError: c.lastError,
});

/** Where a provider should call us back. Built from the app's own origin now
 *  that the API and the dashboard are served from one deployment. */
export const webhookUrlFor = (publicUrl: string, channel: string, workspaceId: string) =>
  `${publicUrl}/webhooks/${channel}/${workspaceId}`;

/**
 * The webchat "install snippet": a single script tag the operator pastes
 * before `</body>` on their own site. The workspaceId travels in the URL
 * itself rather than as a data-attribute the operator could mistype or drop
 * — the same "the id is the public key" model as `cors.ts` documents for the
 * endpoints this script calls.
 */
export const widgetSnippetFor = (publicUrl: string, workspaceId: string) =>
  `<script src="${publicUrl}/static/widget.js" data-workspace="${workspaceId}" async></script>`;
