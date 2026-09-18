import type { Channel } from "@/generated/prisma/client";

/** What every channel is normalised into before it touches the twins. */
export type InboundMessage = {
  channel: Channel;
  handle: string;
  text: string;
  name?: string;
  /** Provider's own id, so a retried webhook does not create a second conversation. */
  externalId: string;
};

/**
 * All that is left of the old adapters: parsing.
 *
 * Sending, credential testing and webhook registration moved to the channel
 * registry and `outbound.ts`, which go through Composio — nothing here holds a
 * provider token any more. The parsers stay only until the per-workspace
 * webhook route that calls them is replaced by the single Meta route.
 */
export type ChannelAdapter = {
  channel: Channel;
  /** Turns a provider payload into zero or more canonical messages. */
  parse(body: unknown): InboundMessage[];
};
