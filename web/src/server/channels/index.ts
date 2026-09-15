import type { Channel } from "@/generated/prisma/client";
import { telegramAdapter } from "./telegram";
import { whatsappAdapter } from "./whatsapp";
import type { ChannelAdapter } from "./types";

/**
 * Only channels with a real adapter can be connected. The others are offered
 * at onboarding as intent, and say so, rather than pretending to work.
 */
export const adapters: Partial<Record<Channel, ChannelAdapter>> = {
  telegram: telegramAdapter,
  whatsapp: whatsappAdapter,
};

export const adapterFor = (channel: Channel): ChannelAdapter | null => adapters[channel] ?? null;

export type { ChannelAdapter, InboundMessage } from "./types";
