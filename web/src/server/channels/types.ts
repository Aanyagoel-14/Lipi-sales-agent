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

export type ChannelAdapter = {
  channel: Channel;
  /** Human-readable label for what the operator must paste in. */
  credentialLabel: string;
  /** Turns a provider payload into zero or more canonical messages. */
  parse(body: unknown): InboundMessage[];
  /** Sends a reply. Throws with a useful message when the provider refuses. */
  send(args: { secret: string; config: Record<string, unknown>; to: string; text: string }): Promise<void>;
  /** Confirms the credentials actually work, and returns who we are. */
  test(args: { secret: string; config: Record<string, unknown> }): Promise<{ displayName: string; externalId: string }>;
};
