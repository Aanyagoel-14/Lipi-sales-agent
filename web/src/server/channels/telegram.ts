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

const api = (token: string, method: string) => `https://api.telegram.org/bot${token}/${method}`;

export const telegramAdapter: ChannelAdapter = {
  channel: "telegram",
  credentialLabel: "Bot token from @BotFather",

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

  async send({ secret, to, text }) {
    const res = await fetch(api(secret, "sendMessage"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: to, text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Telegram refused the message: ${(await res.text()).slice(0, 160)}`);
  },

  async test({ secret }) {
    const res = await fetch(api(secret, "getMe"), { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error("Telegram rejected that bot token");

    const body = (await res.json()) as { ok?: boolean; result?: { username?: string; id?: number } };
    if (!body.ok || !body.result) throw new Error("Telegram rejected that bot token");

    return {
      displayName: body.result.username ? `@${body.result.username}` : "Telegram bot",
      externalId: String(body.result.id ?? ""),
    };
  },
};

/** Points Telegram at our webhook. Called after credentials are saved. */
export async function registerTelegramWebhook(token: string, url: string, secretToken: string) {
  const res = await fetch(api(token, "setWebhook"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, secret_token: secretToken, allowed_updates: ["message"] }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Telegram would not accept the webhook URL: ${(await res.text()).slice(0, 160)}`);
}
