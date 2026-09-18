import type { Channel } from "@/generated/prisma/client";
import type { ComposioClient } from "@/server/lib/composio";
import { env } from "../env";
import type { InboundMessage } from "./types";

/**
 * The channel registry: one declarative spec per channel, and nothing else in
 * the app that enumerates channels.
 *
 * It replaces `ChannelAdapter` — which bundled parsing with its own `fetch`
 * calls to each provider — with a description of what a channel *is*: which
 * Composio toolkit holds its credentials, how it is connected, where inbound
 * comes from, how a provider payload becomes messages, and which tool sends a
 * reply. Everything that touches the network lives behind `composio()`, so a
 * spec is plain data plus pure functions and adding a channel is one entry
 * here plus, if new, one enum value.
 *
 * The old adapters in `./whatsapp.ts` and `./telegram.ts` stay until the
 * routes that import them are replaced; their parsers are copied here, not
 * moved, so the two never drift apart while both exist.
 */

export type Json = Record<string, unknown>;

/** Enough of a `ChannelConnection` for a parser or builder to do its job. */
export type ConnectionView = {
  id: string;
  workspaceId: string;
  channel: Channel;
  externalId: string | null;
  config: Json;
};

/** What a post-connect or pre-disconnect hook gets to work with. */
export type ConnectContext = {
  client: ComposioClient;
  workspaceId: string;
  connectionId: string;
  connectedAccountId: string;
  externalId: string | null;
  config: Json;
  /** The app's own public origin, for webhook URLs handed to a provider. */
  publicUrl: string;
};

/**
 * A parsed message. `threadId` is only meaningful for channels that thread
 * (email); it rides alongside `InboundMessage` here until the ingest path
 * learns to store it, at which point it moves into the canonical type.
 */
export type ParsedMessage = InboundMessage & { threadId?: string };

export type SendRequest = { slug: string; arguments: Json };

export type ChannelSpec = {
  channel: Channel;
  label: string;
  /** Composio toolkit slug, lower-case. */
  toolkit: string;
  /** Pinned toolkit version, `YYYYMMDD_XX`. Every execute carries it. */
  toolkitVersion: string;
  /** Which env key holds this channel's auth config id. Absent → the channel is unavailable. */
  authConfigEnv:
    | "COMPOSIO_AUTH_CONFIG_WHATSAPP"
    | "COMPOSIO_AUTH_CONFIG_INSTAGRAM"
    | "COMPOSIO_AUTH_CONFIG_TELEGRAM"
    | "COMPOSIO_AUTH_CONFIG_GMAIL";
  connect:
    | { kind: "link" }
    /**
     * `field` is what the operator's form calls it; `composioField` is the
     * name Composio's own auth schema requires, which is not the same thing
     * (Telegram's is `generic_api_key`). Getting the second wrong fails the
     * connection with a validation error, so it is declared, not assumed.
     */
    | { kind: "api_key"; field: string; composioField: string; hint: string };
  inbound:
    | { kind: "meta"; object: "whatsapp_business_account" | "instagram" | "page" }
    | { kind: "telegram" }
    | { kind: "composio_trigger"; slug: string; config(connection: ConnectionView): Json }
    | { kind: "none"; reason: string };
  /** Provider payload, already routed to one connection → canonical messages. */
  parse(body: unknown, connection: ConnectionView): ParsedMessage[];
  /** What to execute to reply. Throws when the connection lacks something the tool needs. */
  send(args: { to: string; text: string; config: Json; threadId?: string; subject?: string }): SendRequest;
  /** A cheap read tool that proves the account works and names it. */
  identity: { slug: string; pick(data: unknown): { externalId: string; displayName: string } };
  /** Subscribe the WABA / IG account, set the Telegram webhook, upsert the Gmail trigger. Added by later phases. */
  afterConnect?(ctx: ConnectContext): Promise<Partial<{ externalId: string; config: Json; triggerIds: string[] }>>;
  beforeDisconnect?(ctx: ConnectContext): Promise<void>;
};

/**
 * Pinned toolkit versions, read from `GET /toolkits/{slug}` on 2026-09-19 and
 * verified against every tool slug and argument name the specs below use.
 *
 * Composio rejects an execute that names no version, and Lipi never sets
 * `dangerouslySkipVersionCheck`, so a stale or wrong pin fails loudly instead
 * of silently running whatever "latest" has become. `npm run composio:subscribe
 * -- --versions` prints the live version next to each pin. Bump deliberately,
 * one toolkit at a time, with the send builders re-tested — a toolkit release
 * can rename an argument, and these arguments are what reaches a customer.
 */
const PINS = {
  whatsapp: "20260915_00",
  telegram: "20260821_00",
  instagram: "20260915_00",
  gmail: "20260915_00",
} as const;

const str = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);
const record = (value: unknown): Json | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;

/** Composio wraps provider responses in a few shapes; find the first list under any of these keys. */
const firstList = (data: unknown, keys: string[]): Json[] => {
  const root = record(data);
  if (!root) return Array.isArray(data) ? (data as Json[]) : [];
  for (const key of keys) {
    const value = root[key];
    if (Array.isArray(value)) return value as Json[];
    const nested = record(value);
    if (nested && Array.isArray(nested.data)) return nested.data as Json[];
  }
  return [];
};

// --------------------------------------------------------------- whatsapp --

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

const whatsapp: ChannelSpec = {
  channel: "whatsapp",
  label: "WhatsApp",
  toolkit: "whatsapp",
  toolkitVersion: PINS.whatsapp,
  authConfigEnv: "COMPOSIO_AUTH_CONFIG_WHATSAPP",
  connect: { kind: "link" },
  inbound: { kind: "meta", object: "whatsapp_business_account" },

  parse(body) {
    const payload = body as WhatsAppPayload;
    const out: ParsedMessage[] = [];

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

  send({ to, text, config }) {
    const phoneNumberId = str(config.phoneNumberId);
    if (!phoneNumberId) throw new Error("No phone number chosen for this WhatsApp connection");
    return { slug: "WHATSAPP_SEND_MESSAGE", arguments: { text, to_number: to, phone_number_id: phoneNumberId } };
  },

  identity: {
    slug: "WHATSAPP_GET_PHONE_NUMBERS",
    pick(data) {
      // Graph API lists come back as `{ data: [...] }`; the first number is the
      // default until the operator picks one. Shape confirmed against a live
      // account in the connect-flow phase.
      const first = firstList(data, ["data", "phone_numbers", "phoneNumbers"])[0];
      const id = str(first?.id);
      if (!id) throw new Error("This WhatsApp account has no phone numbers");
      return {
        externalId: id,
        displayName: str(first?.verified_name) ?? str(first?.display_phone_number) ?? "WhatsApp number",
      };
    },
  },
};

// --------------------------------------------------------------- telegram --

type TelegramUpdate = {
  update_id?: number;
  message?: {
    message_id?: number;
    text?: string;
    chat?: { id?: number | string; first_name?: string; username?: string };
    from?: { first_name?: string; username?: string };
  };
};

const telegram: ChannelSpec = {
  channel: "telegram",
  label: "Telegram",
  toolkit: "telegram",
  toolkitVersion: PINS.telegram,
  authConfigEnv: "COMPOSIO_AUTH_CONFIG_TELEGRAM",
  connect: { kind: "api_key", field: "token", composioField: "generic_api_key", hint: "Bot token from @BotFather" },
  inbound: { kind: "telegram" },

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
    }];
  },

  send({ to, text }) {
    return { slug: "TELEGRAM_SEND_MESSAGE", arguments: { chat_id: to, text } };
  },

  identity: {
    slug: "TELEGRAM_GET_ME",
    pick(data) {
      // Bot API answers `{ ok, result: { id, username } }`; Composio may or
      // may not unwrap `result`.
      const root = record(data) ?? {};
      const me = record(root.result) ?? root;
      const id = me.id;
      if (id === undefined || id === null || id === "") throw new Error("Telegram did not identify the bot");
      return { externalId: String(id), displayName: str(me.username) ? `@${me.username}` : "Telegram bot" };
    },
  },
};

// -------------------------------------------------------------- instagram --

type InstagramPayload = {
  entry?: {
    id?: string;
    messaging?: {
      sender?: { id?: string };
      recipient?: { id?: string };
      message?: { mid?: string; text?: string; is_echo?: boolean };
    }[];
  }[];
};

const instagram: ChannelSpec = {
  channel: "instagram",
  label: "Instagram",
  toolkit: "instagram",
  toolkitVersion: PINS.instagram,
  authConfigEnv: "COMPOSIO_AUTH_CONFIG_INSTAGRAM",
  connect: { kind: "link" },
  inbound: { kind: "meta", object: "instagram" },

  parse(body) {
    const payload = body as InstagramPayload;
    const out: ParsedMessage[] = [];

    for (const entry of payload.entry ?? []) {
      for (const event of entry.messaging ?? []) {
        const message = event.message;
        // Our own replies come back through the same webhook flagged as
        // echoes; answering them would be the twin talking to itself.
        if (!message || message.is_echo) continue;
        const text = message.text?.trim();
        const sender = event.sender?.id;
        if (!text || !sender) continue;

        out.push({
          channel: "instagram",
          handle: sender,
          text,
          externalId: message.mid ?? `${sender}-${Date.now()}`,
        });
      }
    }

    return out;
  },

  send({ to, text }) {
    return { slug: "INSTAGRAM_SEND_TEXT_MESSAGE", arguments: { text, recipient_id: to } };
  },

  identity: {
    slug: "INSTAGRAM_GET_USER_INFO",
    pick(data) {
      // `user_id` is the professional account id that webhooks carry in
      // `entry.id`; `id` is the app-scoped one. Route on the former.
      const me = record(data) ?? {};
      const id = str(me.user_id) ?? str(me.id);
      if (!id) throw new Error("Instagram did not identify the account");
      const username = str(me.username);
      return { externalId: id, displayName: username ? `@${username}` : (str(me.name) ?? "Instagram account") };
    },
  },
};

// ------------------------------------------------------------ email/gmail --

/** `"Deepa Rao <deepa@example.com>"` → both parts; a bare address → address only. */
export function parseAddress(raw: string): { address: string; name?: string } | null {
  const trimmed = raw.trim();
  const angled = trimmed.match(/^(.*?)\s*<([^<>\s]+@[^<>\s]+)>$/);
  if (angled) {
    const name = angled[1]!.replace(/^"|"$/g, "").trim();
    return { address: angled[2]!.toLowerCase(), name: name || undefined };
  }
  if (/^[^<>\s]+@[^<>\s]+$/.test(trimmed)) return { address: trimmed.toLowerCase() };
  return null;
}

const email: ChannelSpec = {
  channel: "email",
  label: "Email",
  toolkit: "gmail",
  toolkitVersion: PINS.gmail,
  authConfigEnv: "COMPOSIO_AUTH_CONFIG_GMAIL",
  connect: { kind: "link" },
  inbound: {
    kind: "composio_trigger",
    slug: "GMAIL_NEW_GMAIL_MESSAGE",
    // Field names as documented for the trigger; the trigger-channels phase
    // confirms them against `GET /triggers_types/GMAIL_NEW_GMAIL_MESSAGE`.
    config: () => ({ labelIds: "INBOX", userId: "me" }),
  },

  parse(body) {
    // The trigger's `data`: message_id, thread_id, sender, subject and the
    // plain-text body. Quoted history and list mail are dealt with in the
    // trigger-channels phase; this is the shape.
    const data = record(body);
    if (!data) return [];
    const id = str(data.message_id) ?? str(data.id);
    const sender = str(data.sender) ?? str(data.from);
    const text = (str(data.message_text) ?? str(data.snippet) ?? "").trim();
    const from = sender ? parseAddress(sender) : null;
    if (!id || !from || !text) return [];

    return [{
      channel: "email",
      handle: from.address,
      text,
      name: from.name,
      externalId: id,
      threadId: str(data.thread_id) ?? str(data.threadId),
    }];
  },

  send({ to, text, threadId, subject }) {
    if (threadId) {
      return { slug: "GMAIL_REPLY_TO_THREAD", arguments: { thread_id: threadId, message_body: text, recipient_email: to } };
    }
    return { slug: "GMAIL_SEND_EMAIL", arguments: { recipient_email: to, subject: subject ?? "Your enquiry", body: text } };
  },

  identity: {
    slug: "GMAIL_GET_PROFILE",
    pick(data) {
      const profile = record(data) ?? {};
      const address = str(profile.emailAddress) ?? str(profile.email_address);
      if (!address) throw new Error("Gmail did not return a mailbox address");
      return { externalId: address.toLowerCase(), displayName: address };
    },
  },
};

// --------------------------------------------------------------- registry --

export const channelSpecs: readonly ChannelSpec[] = [whatsapp, telegram, instagram, email];

const byChannel = new Map(channelSpecs.map((spec) => [spec.channel, spec]));

/** Null for a channel with no spec (webchat is served in-process, not connected). */
export const specFor = (channel: Channel): ChannelSpec | null => byChannel.get(channel) ?? null;

/** `{ whatsapp: "20260902_00", … }` — what the SDK is constructed with. */
export const toolkitVersions = (): Record<string, string> =>
  Object.fromEntries(channelSpecs.map((spec) => [spec.toolkit, spec.toolkitVersion]));

/** The auth config this environment has for a channel, or undefined when it is not set up. */
export const authConfigIdFor = (spec: ChannelSpec): string | undefined => env[spec.authConfigEnv] || undefined;

export type CatalogEntry = {
  channel: Channel;
  label: string;
  toolkit: string;
  connect: ChannelSpec["connect"];
  inbound: { kind: ChannelSpec["inbound"]["kind"]; slug?: string; reason?: string };
  /** False when this environment has no auth config for the channel. */
  available: boolean;
  unavailableReason?: string;
};

/** What the Channels UI renders: the specs, minus anything that is a secret or a function. */
export function catalog(): CatalogEntry[] {
  return channelSpecs.map((spec) => {
    const configured = Boolean(env.COMPOSIO_API_KEY) && Boolean(authConfigIdFor(spec));
    return {
      channel: spec.channel,
      label: spec.label,
      toolkit: spec.toolkit,
      connect: spec.connect,
      inbound: {
        kind: spec.inbound.kind,
        ...(spec.inbound.kind === "composio_trigger" ? { slug: spec.inbound.slug } : {}),
        ...(spec.inbound.kind === "none" ? { reason: spec.inbound.reason } : {}),
      },
      available: configured,
      ...(configured
        ? {}
        : {
          unavailableReason: env.COMPOSIO_API_KEY
            ? `${spec.label} is not set up in this environment (${spec.authConfigEnv} is empty)`
            : "Composio is not configured in this environment (COMPOSIO_API_KEY is empty)",
        }),
    };
  });
}
