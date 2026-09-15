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
  credentialLabel: "Permanent access token from your Meta app",

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

  async send({ secret, config, to, text }) {
    const phoneNumberId = config.phoneNumberId as string | undefined;
    if (!phoneNumberId) throw new Error("No phone number id stored for this connection");

    const res = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text } }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`WhatsApp refused the message: ${(await res.text()).slice(0, 160)}`);
  },

  async test({ secret, config }) {
    const phoneNumberId = config.phoneNumberId as string | undefined;
    if (!phoneNumberId) throw new Error("Add the phone number id as well as the token");

    const res = await fetch(
      `https://graph.facebook.com/v21.0/${phoneNumberId}?fields=display_phone_number,verified_name`,
      { headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) throw new Error(`Meta rejected those credentials: ${(await res.text()).slice(0, 160)}`);

    const body = (await res.json()) as { display_phone_number?: string; verified_name?: string; id?: string };
    return {
      displayName: body.verified_name ?? body.display_phone_number ?? "WhatsApp number",
      externalId: body.id ?? phoneNumberId,
    };
  },
};
