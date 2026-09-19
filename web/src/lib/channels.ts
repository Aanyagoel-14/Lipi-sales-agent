/**
 * Channel constants, deliberately free of any server-only import.
 *
 * Client components need these, so this module must never reach for
 * next/headers or anything else that cannot be bundled for the browser.
 * `lib/dash` re-exports them for server callers.
 */
export type ChannelId = "whatsapp" | "instagram" | "facebook" | "telegram" | "email" | "webchat";

/** Fixed slot order. A channel keeps its colour regardless of how many are shown. */
export const channelSlot: Record<ChannelId, number> = {
  whatsapp: 1,
  instagram: 2,
  facebook: 3,
  telegram: 4,
  email: 5,
  webchat: 6,
};

export const channelLabel: Record<ChannelId, string> = {
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  facebook: "Messenger",
  telegram: "Telegram",
  email: "Email",
  webchat: "Website chat",
};
