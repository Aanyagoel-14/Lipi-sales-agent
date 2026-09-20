import type { Channel } from "@/generated/prisma/client";
import { telegramAdapter } from "./telegram";
import { whatsappAdapter } from "./whatsapp";
import type { ChannelAdapter } from "./types";

/**
 * The two provider payload shapes the per-workspace webhook route still
 * parses. Everything else about a channel — connecting it, sending on it,
 * its inbound routing — is declared in `registry.ts` now; this map goes when
 * that route is replaced by the single Meta endpoint.
 */
export const adapters: Partial<Record<Channel, ChannelAdapter>> = {
  telegram: telegramAdapter,
  whatsapp: whatsappAdapter,
};

export const adapterFor = (channel: Channel): ChannelAdapter | null => adapters[channel] ?? null;

export type { ChannelAdapter, InboundMessage } from "./types";
