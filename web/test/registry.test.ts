import { describe, expect, it } from "vitest";
import { env } from "@/server/env";
import { catalog, channelSpecs, parseAddress, specFor, toolkitVersions } from "@/server/channels/registry";

const connection = { id: "cc_1", workspaceId: "ws_1", channel: "whatsapp" as const, externalId: null, config: {} };
const spec = (channel: "whatsapp" | "telegram" | "instagram" | "email") => specFor(channel)!;

describe("the registry", () => {
  it("has four specs, each with a pinned version and its own toolkit", () => {
    expect(channelSpecs.map((s) => s.channel)).toEqual(["whatsapp", "telegram", "instagram", "email"]);
    for (const s of channelSpecs) expect(s.toolkitVersion).toMatch(/^\d{8}_\d{2}$/);
    expect(new Set(channelSpecs.map((s) => s.toolkit)).size).toBe(channelSpecs.length);
  });

  it("hands the SDK one version per toolkit", () => {
    expect(Object.keys(toolkitVersions()).sort()).toEqual(["gmail", "instagram", "telegram", "whatsapp"]);
  });

  it("has no spec for webchat", () => {
    expect(specFor("webchat")).toBeNull();
  });
});

describe("parsing provider payloads", () => {
  it("turns a WhatsApp text message into one message keyed by wamid", () => {
    const body = {
      entry: [{ changes: [{ value: {
        contacts: [{ profile: { name: "Imran" }, wa_id: "919812345678" }],
        messages: [{ id: "wamid.1", from: "919812345678", type: "text", text: { body: " is the linen shirt in stock " } }],
      } }] }],
    };
    expect(spec("whatsapp").parse(body, connection)).toEqual([
      { channel: "whatsapp", handle: "919812345678", text: "is the linen shirt in stock", name: "Imran", externalId: "wamid.1" },
    ]);
  });

  it("ignores a WhatsApp delivery that only carries statuses", () => {
    const body = { entry: [{ changes: [{ value: { statuses: [{ id: "wamid.1", status: "delivered" }] } }] }] };
    expect(spec("whatsapp").parse(body, connection)).toEqual([]);
  });

  it("turns a Telegram update into one message keyed by update_id", () => {
    const body = { update_id: 42, message: { message_id: 7, text: "hi", chat: { id: 555, first_name: "Deepa" }, from: { first_name: "Deepa" } } };
    expect(spec("telegram").parse(body, connection)).toEqual([
      { channel: "telegram", handle: "555", text: "hi", name: "Deepa", externalId: "42" },
    ]);
  });

  it("turns an Instagram DM into one message keyed by mid", () => {
    const body = { object: "instagram", entry: [{ id: "1784", time: 1, messaging: [
      { sender: { id: "5551" }, recipient: { id: "1784" }, message: { mid: "mid.abc", text: "do you ship to Pune?" } },
    ] }] };
    expect(spec("instagram").parse(body, connection)).toEqual([
      { channel: "instagram", handle: "5551", text: "do you ship to Pune?", externalId: "mid.abc" },
    ]);
  });

  it("ignores an Instagram echo of our own reply", () => {
    const body = { entry: [{ messaging: [
      { sender: { id: "1784" }, recipient: { id: "5551" }, message: { mid: "mid.echo", text: "Yes, we do.", is_echo: true } },
    ] }] };
    expect(spec("instagram").parse(body, connection)).toEqual([]);
  });

  it("turns Gmail trigger data into one message with the thread id", () => {
    const data = {
      message_id: "18f0a", thread_id: "18f09", sender: "Deepa Rao <Deepa@Example.com>", to: "shop@lipi.test",
      subject: "Sizing", message_text: "Do the polos run small?", message_timestamp: "2026-09-19T10:00:00Z", label_ids: ["INBOX"],
    };
    expect(spec("email").parse(data, connection)).toEqual([
      { channel: "email", handle: "deepa@example.com", text: "Do the polos run small?", name: "Deepa Rao", externalId: "18f0a", threadId: "18f09" },
    ]);
  });

  it("drops Gmail data with no sender, no id or no text", () => {
    expect(spec("email").parse({ message_id: "x", thread_id: "y", message_text: "hi" }, connection)).toEqual([]);
    expect(spec("email").parse({ thread_id: "y", sender: "a@b.c", message_text: "hi" }, connection)).toEqual([]);
    expect(spec("email").parse({ message_id: "x", sender: "a@b.c", message_text: "  " }, connection)).toEqual([]);
  });

  it("splits a display-name address and lower-cases the mailbox", () => {
    expect(parseAddress('"Rao, Deepa" <D@Example.com>')).toEqual({ address: "d@example.com", name: "Rao, Deepa" });
    expect(parseAddress("d@example.com")).toEqual({ address: "d@example.com" });
    expect(parseAddress("not an address")).toBeNull();
  });
});

describe("send builders", () => {
  it("builds the documented WhatsApp call from the chosen phone number", () => {
    expect(spec("whatsapp").send({ to: "919812345678", text: "hi", config: { phoneNumberId: "106" } })).toEqual({
      slug: "WHATSAPP_SEND_MESSAGE", arguments: { text: "hi", to_number: "919812345678", phone_number_id: "106" },
    });
  });

  it("refuses to build a WhatsApp send with no phone number chosen", () => {
    expect(() => spec("whatsapp").send({ to: "1", text: "hi", config: {} })).toThrow(/phone number/);
  });

  it("builds Telegram and Instagram sends", () => {
    expect(spec("telegram").send({ to: "555", text: "hi", config: {} })).toEqual({
      slug: "TELEGRAM_SEND_MESSAGE", arguments: { chat_id: "555", text: "hi" },
    });
    expect(spec("instagram").send({ to: "5551", text: "hi", config: {} })).toEqual({
      slug: "INSTAGRAM_SEND_TEXT_MESSAGE", arguments: { text: "hi", recipient_id: "5551" },
    });
  });

  it("replies in-thread on Gmail when there is a thread, and starts one otherwise", () => {
    expect(spec("email").send({ to: "d@example.com", text: "They run true to size.", config: {}, threadId: "18f09" })).toEqual({
      slug: "GMAIL_REPLY_TO_THREAD", arguments: { thread_id: "18f09", message_body: "They run true to size.", recipient_email: "d@example.com" },
    });
    expect(spec("email").send({ to: "d@example.com", text: "Hello", config: {}, subject: "Re: Sizing" })).toEqual({
      slug: "GMAIL_SEND_EMAIL", arguments: { recipient_email: "d@example.com", subject: "Re: Sizing", body: "Hello" },
    });
  });
});

describe("identity tools", () => {
  it("name the documented read tool per channel", () => {
    expect(channelSpecs.map((s) => s.identity.slug)).toEqual([
      "WHATSAPP_GET_PHONE_NUMBERS", "TELEGRAM_GET_ME", "INSTAGRAM_GET_USER_INFO", "GMAIL_GET_PROFILE",
    ]);
  });

  it("pick the provider id and a display name out of each response", () => {
    expect(spec("whatsapp").identity.pick({ data: [{ id: "106", display_phone_number: "+91 98…", verified_name: "Lipi Apparel" }] }))
      .toEqual({ externalId: "106", displayName: "Lipi Apparel" });
    expect(spec("telegram").identity.pick({ ok: true, result: { id: 987, username: "lipi_bot" } }))
      .toEqual({ externalId: "987", displayName: "@lipi_bot" });
    expect(spec("instagram").identity.pick({ id: "app-scoped", user_id: "1784", username: "lipi.apparel" }))
      .toEqual({ externalId: "1784", displayName: "@lipi.apparel" });
    expect(spec("email").identity.pick({ emailAddress: "Shop@Lipi.test", messagesTotal: 10 }))
      .toEqual({ externalId: "shop@lipi.test", displayName: "Shop@Lipi.test" });
  });

  it("throw rather than invent an id", () => {
    expect(() => spec("whatsapp").identity.pick({ data: [] })).toThrow();
    expect(() => spec("telegram").identity.pick({ ok: false })).toThrow();
  });
});

describe("catalog()", () => {
  it("lists exactly the four specs with their inbound kind", () => {
    const entries = catalog();
    expect(entries.map((e) => e.channel)).toEqual(["whatsapp", "telegram", "instagram", "email"]);
    expect(entries.find((e) => e.channel === "email")?.inbound).toEqual({ kind: "composio_trigger", slug: "GMAIL_NEW_GMAIL_MESSAGE" });
    expect(entries.find((e) => e.channel === "whatsapp")?.inbound).toEqual({ kind: "meta" });
    expect(entries.find((e) => e.channel === "telegram")?.connect).toEqual({ kind: "api_key", field: "token", hint: "Bot token from @BotFather" });
  });

  it("marks a channel unavailable until its auth config id is set, naming the key", () => {
    const before = { key: env.COMPOSIO_API_KEY, telegram: env.COMPOSIO_AUTH_CONFIG_TELEGRAM };
    try {
      env.COMPOSIO_API_KEY = undefined;
      env.COMPOSIO_AUTH_CONFIG_TELEGRAM = undefined;
      expect(catalog().every((e) => !e.available)).toBe(true);
      expect(catalog()[0]?.unavailableReason).toMatch(/COMPOSIO_API_KEY/);

      env.COMPOSIO_API_KEY = "ck_test";
      const telegram = catalog().find((e) => e.channel === "telegram")!;
      expect(telegram.available).toBe(false);
      expect(telegram.unavailableReason).toMatch(/COMPOSIO_AUTH_CONFIG_TELEGRAM/);

      env.COMPOSIO_AUTH_CONFIG_TELEGRAM = "ac_test";
      expect(catalog().find((e) => e.channel === "telegram")).toMatchObject({ available: true });
      expect(catalog().find((e) => e.channel === "whatsapp")?.available).toBe(false);
    } finally {
      env.COMPOSIO_API_KEY = before.key;
      env.COMPOSIO_AUTH_CONFIG_TELEGRAM = before.telegram;
    }
  });

  it("exposes nothing but data", () => {
    for (const entry of catalog()) {
      expect(JSON.parse(JSON.stringify(entry))).toEqual(entry);
    }
  });
});
