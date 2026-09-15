/**
 * Channel constants, deliberately free of any server-only import.
 *
 * Client components need these, so this module must never reach for
 * next/headers or anything else that cannot be bundled for the browser.
 * `lib/dash` re-exports them for server callers.
 */
export type ChannelId = "whatsapp" | "instagram" | "telegram" | "email" | "webchat";

/** Fixed slot order. A channel keeps its colour regardless of how many are shown. */
export const channelSlot: Record<ChannelId, number> = {
  whatsapp: 1,
  instagram: 2,
  telegram: 3,
  email: 4,
  webchat: 5,
};

export const channelLabel: Record<ChannelId, string> = {
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  telegram: "Telegram",
  email: "Email",
  webchat: "Website chat",
};
