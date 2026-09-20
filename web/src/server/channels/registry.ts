import type { Channel } from "@/generated/prisma/client";
import { newWebhookSecret } from "@/server/lib/crypto";
import type { ComposioClient } from "@/server/lib/composio";
import { env } from "../env";

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
 * One call escapes that rule and says so where it happens: Telegram's
 * `setWebhook`. Composio's proxy passes an endpoint to the provider verbatim,
 * and Telegram carries its credential in the path rather than a header, so a
 * proxied `/setWebhook` reaches `api.telegram.org` with no bot token in it
 * and comes back 404. The toolkit has no webhook tool either. Registering it
 * is therefore done directly, in the one request where Lipi still holds the
 * token, and the token is not written down on the way past.
 */

/** What every channel is normalised into before it touches the twins. */
export type InboundMessage = {
  channel: Channel;
  handle: string;
  text: string;
  name?: string;
  /** Provider's own id, so a retried webhook does not create a second conversation. */
  externalId: string;
};

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
  /**
   * Whatever the identity tool returned, so a hook that needs the same
   * response does not execute the same tool a second time. WhatsApp's does:
   * `WHATSAPP_GET_PHONE_NUMBERS` is both the identity call and the list the
   * operator picks a number from.
   */
  identityData: unknown;
  /** The app's own public origin, for webhook URLs handed to a provider. */
  publicUrl: string;
  /**
   * The non-secret values Composio holds for this account, as
   * `ComposioAccount.params`. WhatsApp's WABA id (`generic_id`) is read from
   * here; nothing else uses it. Empty on the disconnect path.
   */
  accountParams: Record<string, string>;
  /**
   * The API key the operator has just supplied, on the one path where Lipi
   * still has it: an `api_key` connect, in the same request that handed it to
   * Composio. Absent on an OAuth callback and on every disconnect, so a hook
   * that wants it has to say what it cannot do without it. Never persisted,
   * never logged — see `setTelegramWebhook`.
   */
  apiKey?: string;
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
    | "COMPOSIO_AUTH_CONFIG_FACEBOOK"
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
    | {
      kind: "meta";
      object: "whatsapp_business_account" | "instagram" | "page";
      /**
       * One `entry` from a Meta delivery, split into the connections it is
       * for: the provider id that routes it and the slice of the body that
       * belongs to that id. A single delivery can carry entries for several
       * tenants, and a WhatsApp entry can carry changes for several numbers,
       * so this returns a list rather than one id.
       */
      route(entry: Json): { externalId: string; payload: Json }[];
    }
    | { kind: "telegram" }
    | { kind: "composio_trigger"; slug: string; config(connection: ConnectionView): Json }
    | { kind: "none"; reason: string };
  /** Provider payload, already routed to one connection → canonical messages. */
  parse(body: unknown, connection: ConnectionView): ParsedMessage[];
  /**
   * Longest text the provider accepts in one message, so a long reply is
   * split rather than truncated by the provider or rejected outright. Null
   * for a channel with no practical limit (email).
   */
  textLimit: number | null;
  /** What to execute to reply. Throws when the connection lacks something the tool needs. */
  send(args: { to: string; text: string; config: Json; threadId?: string; subject?: string }): SendRequest;
  /**
   * A cheap read tool that proves the account works and names it. Arguments
   * are declared rather than assumed: Gmail's profile call wants the mailbox
   * it is scoped to, Instagram's wants a field list, and sending nothing to
   * either returns less than the `pick` below needs.
   */
  identity: {
    slug: string;
    arguments?: Json;
    pick(data: unknown): { externalId: string; displayName: string };
  };
  /**
   * Runs once a connected account is ACTIVE and its identity is known: picks
   * the WhatsApp number, upserts the Gmail trigger, subscribes the WABA.
   * Returning `externalId: null` means "the operator still has to choose",
   * which is not the same as omitting the key and keeping what identity found.
   */
  afterConnect?(ctx: ConnectContext): Promise<Partial<{
    externalId: string | null;
    config: Json;
    triggerIds: string[];
    /** Set when the hook registered a webhook and chose the secret that proves it. */
    webhookSecret: string;
  }>>;
  beforeDisconnect?(ctx: ConnectContext): Promise<void>;
  /**
   * Present when one connected account can own several provider identities
   * and only the operator knows which is theirs. `afterConnect` records the
   * candidates under `list` and leaves `externalId` null; `PATCH
   * /v1/channels/:channel` takes `{ [field]: id }`, checks it against that
   * list and settles it. WhatsApp's numbers and Messenger's Pages are the
   * two; both are keys inbound routes on, so neither is ever guessed.
   */
  choice?: { field: string; list: string; noun: string; prompt: string };
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
  facebook: "20260902_00",
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

/**
 * Points Lipi's Meta app at a WABA, an Instagram professional account or a
 * Page, so the provider starts delivering that node's messages to
 * `/webhooks/meta`.
 *
 * Done through the proxy rather than a tool because no Meta toolkit has one:
 * `WHATSAPP_SUBSCRIBE_APP` and `INSTAGRAM_ENABLE_WEBHOOK_SUBSCRIPTIONS` are
 * both 404 on the live API (checked 2026-09-19), and the facebook toolkit's
 * 41 tools include no subscription either. The Graph edge is the same shape
 * on all three, and `subscribed_fields` is a query parameter there.
 *
 * Throwing is deliberate: `finishConnection` turns it into `status: "error"`
 * with this message. A channel that cannot receive is not a connected sales
 * channel, and an operator who sees "Live" should never have to wonder
 * whether inbound arrived.
 */
async function subscribeMeta(client: ComposioClient, connectedAccountId: string, nodeId: string) {
  const result = await client.proxy({
    connectedAccountId,
    method: "POST",
    endpoint: `/${nodeId}/subscribed_apps`,
    query: { subscribed_fields: "messages" },
  });
  if (result.status >= 300) {
    throw new Error(`Meta refused the message subscription for ${nodeId}: ${JSON.stringify(result.data).slice(0, 200)}`);
  }
}

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

export type PhoneNumber = { id: string; display: string; verifiedName: string };

/** The numbers on a WABA, as `WHATSAPP_GET_PHONE_NUMBERS` returns them. */
const phoneNumbersFrom = (data: unknown): PhoneNumber[] =>
  firstList(data, ["data", "phone_numbers", "phoneNumbers"])
    .map((number) => ({
      id: str(number.id) ?? "",
      display: str(number.display_phone_number) ?? "",
      verifiedName: str(number.verified_name) ?? "",
    }))
    .filter((number) => number.id);

const whatsapp: ChannelSpec = {
  channel: "whatsapp",
  label: "WhatsApp",
  toolkit: "whatsapp",
  toolkitVersion: PINS.whatsapp,
  authConfigEnv: "COMPOSIO_AUTH_CONFIG_WHATSAPP",
  connect: { kind: "link" },
  inbound: {
    kind: "meta",
    object: "whatsapp_business_account",
    // A WABA's webhook carries the receiving number in the change itself,
    // not on the entry, and one entry may hold changes for several numbers
    // — so each change is routed and parsed on its own.
    route: (entry) => ((entry.changes as Json[] | undefined) ?? []).flatMap((change) => {
      const value = record(change?.value);
      const id = str(record(value?.metadata)?.phone_number_id);
      return id ? [{ externalId: id, payload: { entry: [{ changes: [change] }] } }] : [];
    }),
  },

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

  // Cloud API caps a text body at 4096 characters.
  textLimit: 4096,

  send({ to, text, config }) {
    const phoneNumberId = str(config.phoneNumberId);
    if (!phoneNumberId) throw new Error("No phone number chosen for this WhatsApp connection");
    // The Cloud API wants a bare number: no `+`, no spaces. Inbound `wa_id`
    // is already in that form, but a handle typed by an operator is not.
    return {
      slug: "WHATSAPP_SEND_MESSAGE",
      arguments: { text, to_number: to.replace(/\D/g, ""), phone_number_id: phoneNumberId },
    };
  },

  /**
   * A WABA can hold several numbers and only one of them is this workspace's
   * sender, so the connect step records all of them and picks only when the
   * choice is unambiguous. With more than one, `externalId` is deliberately
   * cleared: a guess here would send every reply from the wrong number, and
   * `(channel, externalId)` is the key inbound routes on in C3.
   */
  async afterConnect(ctx) {
    // The subscription is on the WABA, not on a number, so it happens once
    // and before the choice below — whichever number the operator ends up
    // sending from, inbound for the whole account is already flowing.
    const wabaId = ctx.accountParams.generic_id;
    if (!wabaId) {
      throw new Error("Composio did not say which WhatsApp Business Account this connection is for");
    }
    await subscribeMeta(ctx.client, ctx.connectedAccountId, wabaId);

    const numbers = phoneNumbersFrom(ctx.identityData);
    if (numbers.length === 1) {
      const only = numbers[0]!;
      return { externalId: only.id, config: { wabaId, phoneNumbers: numbers, phoneNumberId: only.id } };
    }
    return { externalId: null, config: { wabaId, phoneNumbers: numbers } };
  },

  choice: {
    field: "phoneNumberId",
    list: "phoneNumbers",
    noun: "number",
    prompt: "This account has more than one number. Which one do customers message?",
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

/**
 * Registers the bot's webhook with Telegram directly.
 *
 * This is the one provider call in the app that does not go through
 * Composio, and it is not a shortcut. Composio's proxy forwards an endpoint
 * to the toolkit's base URL unchanged, and Telegram's credential lives in
 * the path (`/bot<token>/setWebhook`), not a header — a proxied `/setWebhook`
 * arrives at `api.telegram.org` with no token in it and comes back
 * `{"ok":false,"error_code":404}`. The toolkit has no `TELEGRAM_SET_WEBHOOK`
 * tool and Composio has no Telegram trigger, so the alternatives are this or
 * no Telegram inbound at all. `TELEGRAM_GET_UPDATES` is not an alternative:
 * long-polling and a webhook are mutually exclusive, and calling it would
 * tear down the webhook this just set.
 *
 * The token is the operator's, held for the length of this call and never
 * written anywhere. Both failure paths are careful with it: a transport
 * error is replaced rather than reported, because the URL it names contains
 * the token and the message ends up in `lastError` on screen.
 */
async function setTelegramWebhook(token: string, url: string, secretToken: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        secret_token: secretToken,
        allowed_updates: ["message"],
        // A bot that has been sitting unconnected has a backlog Telegram
        // would replay the moment a webhook appears. Those are old
        // conversations; answering them now would be worse than missing them.
        drop_pending_updates: true,
      }),
    });
  } catch {
    throw new Error("Could not reach Telegram to register the webhook");
  }

  const body = (await response.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
  if (!response.ok || !body?.ok) {
    throw new Error(body?.description ?? `Telegram refused setWebhook (${response.status})`);
  }
}

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

  // Bot API rejects sendMessage above 4096 characters.
  textLimit: 4096,

  send({ to, text }) {
    return { slug: "TELEGRAM_SEND_MESSAGE", arguments: { chat_id: to, text } };
  },

  /**
   * Telegram delivers to one URL per bot, so the URL carries the connection
   * id and the header carries a secret only this connection knows. Both are
   * set here, in the only request that has the token.
   *
   * There is no `beforeDisconnect` to match. Deleting the Composio account
   * does not give the token back — Composio returns a placeholder in its
   * place, checked against the live API — so `/deleteWebhook` cannot be
   * called on the way out. Disconnect clears `webhookSecret` instead, which
   * makes every later delivery from the stale webhook a 401 and writes
   * nothing. DEPLOYMENT.md tells the operator how to clear it for good.
   */
  async afterConnect(ctx) {
    if (!ctx.apiKey) {
      throw new Error("Telegram's webhook can only be set while the bot token is in hand; reconnect the channel");
    }
    const secret = newWebhookSecret();
    await setTelegramWebhook(ctx.apiKey, `${ctx.publicUrl}/webhooks/telegram/${ctx.connectionId}`, secret);
    return { webhookSecret: secret };
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

// ------------------------------------------- instagram and messenger --

/**
 * Instagram DMs and Messenger threads arrive on the same Meta Messaging
 * Platform envelope, so one parser serves both. `messaging[]` also carries
 * read receipts, reactions, deliveries and postbacks; none of them has
 * `message.text`, which is what keeps them out.
 */
type MessagingPayload = {
  entry?: {
    id?: string;
    messaging?: {
      sender?: { id?: string };
      recipient?: { id?: string };
      message?: { mid?: string; text?: string; is_echo?: boolean };
    }[];
  }[];
};

function parseMessaging(channel: Channel, body: unknown): ParsedMessage[] {
  const payload = body as MessagingPayload;
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
        channel,
        handle: sender,
        text,
        // Meta sends no profile name on this envelope, so the customer is
        // named by handle until they say otherwise — same as before.
        externalId: message.mid ?? `${sender}-${Date.now()}`,
      });
    }
  }

  return out;
}

/** One `entry` per account or Page, and its id is what routes it. */
const routeByEntryId = (entry: Json) => {
  const id = str(entry.id);
  return id ? [{ externalId: id, payload: { entry: [entry] } }] : [];
};

const instagram: ChannelSpec = {
  channel: "instagram",
  label: "Instagram",
  toolkit: "instagram",
  toolkitVersion: PINS.instagram,
  authConfigEnv: "COMPOSIO_AUTH_CONFIG_INSTAGRAM",
  connect: { kind: "link" },
  inbound: {
    kind: "meta",
    object: "instagram",
    route: routeByEntryId,
  },

  parse: (body) => parseMessaging("instagram", body),

  // Meta's messaging API caps Instagram text at 1000 characters, well below
  // WhatsApp's, so a reply that fits on WhatsApp can still need splitting here.
  textLimit: 1000,

  send({ to, text }) {
    return { slug: "INSTAGRAM_SEND_TEXT_MESSAGE", arguments: { text, recipient_id: to } };
  },

  /**
   * One professional account, one subscription, and the id identity already
   * found is the one webhooks carry in `entry.id` — so there is nothing for
   * the operator to choose here.
   */
  async afterConnect(ctx) {
    if (!ctx.externalId) throw new Error("Instagram did not identify the professional account to subscribe");
    await subscribeMeta(ctx.client, ctx.connectedAccountId, ctx.externalId);
    return {};
  },

  identity: {
    slug: "INSTAGRAM_GET_USER_INFO",
    arguments: { fields: "id,user_id,username,name" },
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

// -------------------------------------------------------------- messenger --

export type Page = { id: string; name: string };

/**
 * The Pages this account manages, as `FACEBOOK_GET_USER_PAGES` returns them.
 *
 * Only the id and the name are kept. That call's default field set includes
 * each Page's own access token, and `config` is shown back to the operator
 * in the browser — a credential has no business travelling there.
 */
const pagesFrom = (data: unknown): Page[] =>
  firstList(data, ["data", "pages"])
    .map((page) => ({ id: str(page.id) ?? "", name: str(page.name) ?? "" }))
    .filter((page) => page.id);

const facebook: ChannelSpec = {
  channel: "facebook",
  label: "Messenger",
  toolkit: "facebook",
  toolkitVersion: PINS.facebook,
  authConfigEnv: "COMPOSIO_AUTH_CONFIG_FACEBOOK",
  connect: { kind: "link" },
  inbound: { kind: "meta", object: "page", route: routeByEntryId },

  parse: (body) => parseMessaging("facebook", body),

  // The Send API rejects a message body over 2000 characters.
  textLimit: 2000,

  send({ to, text, config }) {
    const pageId = str(config.pageId);
    if (!pageId) throw new Error("No Page chosen for this Messenger connection");
    return {
      slug: "FACEBOOK_SEND_MESSAGE",
      arguments: { page_id: pageId, recipient_id: to, message_text: text },
    };
  },

  /**
   * Every Page the operator manages is subscribed, not just the one they
   * send from. Inbound routes on `(channel, externalId)`, so an unchosen
   * Page's messages are dropped at the door either way; subscribing them all
   * means the choice below is a database write rather than another round
   * trip to Meta, and a later change of mind needs no reconnect.
   */
  async afterConnect(ctx) {
    const pages = pagesFrom(ctx.identityData);
    if (!pages.length) throw new Error("This Facebook account manages no Pages");

    for (const page of pages) await subscribeMeta(ctx.client, ctx.connectedAccountId, page.id);

    if (pages.length === 1) {
      const only = pages[0]!;
      return { externalId: only.id, config: { pages, pageId: only.id } };
    }
    return { externalId: null, config: { pages } };
  },

  choice: {
    field: "pageId",
    list: "pages",
    noun: "Page",
    prompt: "This account manages more than one Page. Which one do customers message?",
  },

  identity: {
    slug: "FACEBOOK_GET_USER_PAGES",
    // Without a field list Graph returns each Page's access token, which
    // would then sit in `identityData` for the length of the connect.
    arguments: { fields: "id,name" },
    pick(data) {
      const first = pagesFrom(data)[0];
      if (!first) throw new Error("This Facebook account manages no Pages");
      return { externalId: first.id, displayName: first.name || first.id };
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

  // Gmail's limit is measured in megabytes; a reply never approaches it, and
  // splitting an email into two emails would be the wrong shape anyway.
  textLimit: null,

  send({ to, text, threadId, subject }) {
    if (threadId) {
      return { slug: "GMAIL_REPLY_TO_THREAD", arguments: { thread_id: threadId, message_body: text, recipient_email: to } };
    }
    return { slug: "GMAIL_SEND_EMAIL", arguments: { recipient_email: to, subject: subject ?? "Your enquiry", body: text } };
  },

  identity: {
    slug: "GMAIL_GET_PROFILE",
    arguments: { user_id: "me" },
    pick(data) {
      const profile = record(data) ?? {};
      const address = str(profile.emailAddress) ?? str(profile.email_address);
      if (!address) throw new Error("Gmail did not return a mailbox address");
      return { externalId: address.toLowerCase(), displayName: address };
    },
  },
};

// --------------------------------------------------------------- registry --

export const channelSpecs: readonly ChannelSpec[] = [whatsapp, telegram, instagram, facebook, email];

const byChannel = new Map(channelSpecs.map((spec) => [spec.channel, spec]));

/** Null for a channel with no spec (webchat is served in-process, not connected). */
export const specFor = (channel: Channel): ChannelSpec | null => byChannel.get(channel) ?? null;

const byMetaObject = new Map<string, ChannelSpec>(
  channelSpecs.flatMap((spec) => (spec.inbound.kind === "meta" ? [[spec.inbound.object as string, spec] as const] : [])),
);

/**
 * Which channel a Meta delivery is for, from its top-level `object`. Null for
 * an object this deployment does not serve — a subscription left on in the
 * Meta app, which the route answers 200 and drops.
 */
export const specForMetaObject = (object: unknown): ChannelSpec | null =>
  (typeof object === "string" ? byMetaObject.get(object) : undefined) ?? null;

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
  /** What the operator has to pick between, when a connection can own several identities. */
  choice?: ChannelSpec["choice"];
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
      ...(spec.choice ? { choice: spec.choice } : {}),
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
