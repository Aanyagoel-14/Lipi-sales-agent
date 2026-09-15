import { adapterFor } from "@/server/channels/index";
import { env } from "@/server/env";
import { json, route } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { CHANNELS, publicView, webhookUrlFor, widgetSnippetFor } from "./view";

export const GET = route(async () => {
  const workspaceId = await resolveWorkspaceId();
  const connections = await prisma.channelConnection.findMany({ where: { workspaceId } });
  const byChannel = new Map(connections.map((c) => [c.channel, c]));

  return json({
    channels: CHANNELS.map((channel) => {
      // Webchat has no provider and no adapter: the widget IS the transport,
      // so there is nothing to authenticate against and nothing to poll a
      // webhook status from. It is "connected" the instant the workspace
      // exists. What an operator needs instead of a secret field is the
      // install snippet — a <script> tag with their workspaceId baked in —
      // so that is surfaced here under `installSnippet` and the UI branches
      // on `channel === "webchat"` rather than on `supported`/`hasCredentials`.
      if (channel === "webchat") {
        return {
          channel, supported: true, credentialLabel: null, webhookUrl: null,
          status: "connected", externalId: null, displayName: "Website chat widget",
          config: {}, hasCredentials: true, lastEventIso: null, lastError: null,
          installSnippet: widgetSnippetFor(env.PUBLIC_URL, workspaceId),
        };
      }

      const existing = byChannel.get(channel);
      const adapter = adapterFor(channel);
      return {
        supported: Boolean(adapter),
        credentialLabel: adapter?.credentialLabel ?? null,
        webhookUrl: adapter && existing ? webhookUrlFor(env.PUBLIC_URL, channel, workspaceId) : null,
        installSnippet: null,
        ...(existing ? publicView(existing) : {
          channel,
          status: "disconnected", externalId: null, displayName: null,
          config: {}, hasCredentials: false, lastEventIso: null, lastError: null,
        }),
      };
    }),
  });
});
