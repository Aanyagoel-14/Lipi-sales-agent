import type { ChannelAdapter, InboundMessage } from "./types";

type WhatsAppPayload = {
  entry?: {
    changes?: {
      value?: {
        contacts?: { profile?: { name?: string }; wa_id?: string }[];
        messages?: { id?: string; from?: string; type?: string; text?: { body?: string } }[];
      };
    }[];
  }[];
};

export const whatsappAdapter: ChannelAdapter = {
  channel: "whatsapp",

  parse(body) {
    const payload = body as WhatsAppPayload;
    const out: InboundMessage[] = [];

    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        const profileName = value?.contacts?.[0]?.profile?.name;

        for (const message of value?.messages ?? []) {
          // Status callbacks and media arrive on the same webhook; only text
          // messages are something the twins can reason about today.
          if (message.type !== "text") continue;
          const text = message.text?.body?.trim();
          if (!text || !message.from) continue;

          out.push({
            channel: "whatsapp",
            handle: message.from,
            text,
            name: profileName,
            externalId: message.id ?? `${message.from}-${Date.now()}`,
          });
        }
      }
    }

    return out;
  },
};
