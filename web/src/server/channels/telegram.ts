import type { ChannelAdapter, InboundMessage } from "./types";

type TelegramUpdate = {
  update_id?: number;
  message?: {
    message_id?: number;
    text?: string;
    chat?: { id?: number | string; first_name?: string; username?: string };
    from?: { first_name?: string; username?: string };
  };
};

export const telegramAdapter: ChannelAdapter = {
  channel: "telegram",

  parse(body) {
    const update = body as TelegramUpdate;
    const message = update.message;
    const text = message?.text?.trim();
    const chatId = message?.chat?.id;

    // Non-text updates (joins, edits, stickers) are ignored rather than
    // turned into empty conversations.
    if (!message || !text || chatId === undefined) return [];

    const from = message.from ?? message.chat ?? {};
    const name = from.first_name ?? (from.username ? `@${from.username}` : undefined);

    return [{
      channel: "telegram",
      handle: String(chatId),
      text,
      name,
      externalId: String(update.update_id ?? message.message_id ?? `${chatId}-${Date.now()}`),
    } satisfies InboundMessage];
  },
};
