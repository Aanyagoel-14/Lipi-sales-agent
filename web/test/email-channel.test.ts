import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agent, createUser, createWorkspace, resetDatabase, signedIn } from "./helpers";
import { afterSettled } from "./next/server";
import { fakeComposio } from "./fakes/composio";
import { GMAIL_QUERY, htmlToText, specFor, stripQuoted } from "@/server/channels/registry";
import { env } from "@/server/env";
import { prisma } from "@/server/lib/prisma";
import { _resetRateLimitsForTests } from "@/server/lib/rate-limit";

/**
 * Email, the one channel whose inbound and outbound both go through Composio.
 *
 * A Gmail trigger polls the mailbox and posts each new message to the
 * project webhook; the reply goes back through `GMAIL_REPLY_TO_THREAD` into
 * the same thread. What these follow is that path end to end, and the mail a
 * salesperson would never answer — our own replies, bounces, newsletters —
 * stopping at the door rather than becoming a conversation.
 */

const AUTH_GMAIL = "ac_test_gmail";
const MAILBOX = "sales@acme.test";
const ACCOUNT_A = "ca_gmail_a";
const ACCOUNT_B = "ca_gmail_b";
const TRIGGER = "GMAIL_NEW_GMAIL_MESSAGE";

const original = { key: env.COMPOSIO_API_KEY, gmail: env.COMPOSIO_AUTH_CONFIG_GMAIL };
beforeAll(() => {
  env.COMPOSIO_API_KEY = "ck_test";
  env.COMPOSIO_AUTH_CONFIG_GMAIL = AUTH_GMAIL;
});
afterAll(() => {
  env.COMPOSIO_API_KEY = original.key;
  env.COMPOSIO_AUTH_CONFIG_GMAIL = original.gmail;
});

let alpha: string;
let beta: string;

beforeEach(async () => {
  await resetDatabase();
  _resetRateLimitsForTests();
  fakeComposio.authConfigs.set(AUTH_GMAIL, "gmail");
  fakeComposio.execute.respond("GMAIL_GET_PROFILE", { successful: true, data: { emailAddress: MAILBOX }, error: null });

  const { user } = await createUser();
  // Policy `nothing` so the reply actually leaves and can be followed out.
  alpha = (await createWorkspace({ userId: user.id, policy: "nothing" })).id;
  const second = await createUser("second@test.local");
  beta = (await createWorkspace({ userId: second.user.id, name: "Second Co", withCatalogue: false })).id;
});

/** A connected Gmail row, as `finishConnection` leaves one. */
const connectEmail = (workspaceId: string, accountId: string, externalId: string) =>
  prisma.channelConnection.create({
    data: {
      workspaceId, channel: "email", status: "connected", externalId, displayName: externalId,
      composioAccountId: accountId, composioAuthConfigId: AUTH_GMAIL, composioTriggerIds: [`ti_${accountId}`],
      connectedAt: new Date(),
    },
  });

/** The trigger's `data`, with the keys its payload schema documents. */
const gmail = (overrides: Record<string, unknown> = {}) => ({
  id: "18f0a1b2c3d4e5f6",
  message_id: "18f0a1b2c3d4e5f6",
  thread_id: "thr_18f0a1b2",
  sender: "Deepa Rao <Deepa@Example.com>",
  to: MAILBOX,
  subject: "Polo in L?",
  message_text: "Hi, do you have 2 olive L polos?",
  label_ids: ["INBOX", "UNREAD", "CATEGORY_PERSONAL"],
  payload: { headers: [{ name: "From", value: "Deepa Rao <Deepa@Example.com>" }] },
  ...overrides,
});

const trigger = (data: Record<string, unknown>, metadata: Record<string, unknown> = {}, webhookId?: string) =>
  fakeComposio.sign({
    type: "composio.trigger.message",
    metadata: { trigger_slug: TRIGGER, connected_account_id: ACCOUNT_A, ...metadata },
    data,
  }, { webhookId });

const post = (delivery: { body: string; headers: Record<string, string> }) => {
  const request = agent().post("/webhooks/composio").send(delivery.body);
  for (const [key, value] of Object.entries(delivery.headers)) request.set(key, value);
  return request;
};

const deliver = async (delivery: { body: string; headers: Record<string, string> }) => {
  await post(delivery).expect(200);
  await afterSettled();
};

const conversationsIn = (workspaceId: string) =>
  prisma.conversation.findMany({ where: { workspaceId }, include: { messages: true, customer: true } });

const sends = () => fakeComposio.calls.execute.filter((call) => call.slug.startsWith("GMAIL_") && call.slug !== "GMAIL_GET_PROFILE");

// -------------------------------------------------------------- connect --

describe("connecting a mailbox", () => {
  const start = async () => {
    const app = await signedIn();
    await app.post("/v1/channels/email/connect").expect(201);
    const row = await prisma.channelConnection.findFirstOrThrow({ where: { workspaceId: alpha, channel: "email" } });
    const accountId = row.composioAccountId!;
    fakeComposio.accounts.set(accountId, {
      id: accountId, status: "ACTIVE", statusReason: null, userId: alpha, toolkit: "gmail",
    });
    await app.get(`/v1/channels/callback?connected_account_id=${accountId}`).expect(303);
    return { app, accountId };
  };

  it("starts the Gmail trigger for that account and keeps its id", async () => {
    const { accountId } = await start();

    expect(fakeComposio.calls.upsertTrigger).toEqual([{
      slug: TRIGGER, userId: alpha, connectedAccountId: accountId, config: { query: GMAIL_QUERY, userId: "me" },
    }]);
    const row = await prisma.channelConnection.findFirstOrThrow({ where: { workspaceId: alpha, channel: "email" } });
    expect(row).toMatchObject({ status: "connected", externalId: MAILBOX });
    expect(row.composioTriggerIds).toEqual([...fakeComposio.triggers]);
  });

  it("asks Gmail for inbox mail that is not our own", () => {
    expect(GMAIL_QUERY).toContain("in:inbox");
    expect(GMAIL_QUERY).toContain("-from:me");
  });

  it("deletes exactly that trigger, once, on disconnect", async () => {
    const { app } = await start();
    const [triggerId] = [...fakeComposio.triggers];

    await app.delete("/v1/channels/email").expect(204);

    expect(fakeComposio.calls.deleteTrigger).toEqual([triggerId]);
  });
});

// -------------------------------------------------------------- inbound --

describe("a new email", () => {
  beforeEach(async () => {
    await connectEmail(alpha, ACCOUNT_A, MAILBOX);
    await connectEmail(beta, ACCOUNT_B, "hello@second.test");
  });

  it("becomes a conversation with the sender as the customer and the thread kept", async () => {
    await deliver(trigger(gmail()));

    const [conversation, ...rest] = await conversationsIn(alpha);
    expect(rest).toHaveLength(0);
    expect(conversation).toMatchObject({ channel: "email", externalThreadId: "thr_18f0a1b2" });
    expect(conversation!.customer).toMatchObject({ handle: "deepa@example.com", name: "Deepa Rao" });
    expect(conversation!.messages.map((m) => m.from).sort()).toEqual(["agent", "customer"]);
  });

  it("is answered in the same thread", async () => {
    await deliver(trigger(gmail()));

    expect(sends()).toMatchObject([{
      slug: "GMAIL_REPLY_TO_THREAD",
      connectedAccountId: ACCOUNT_A,
      arguments: { thread_id: "thr_18f0a1b2", recipient_email: "deepa@example.com" },
    }]);
  });

  it("runs once when Composio delivers the same message twice", async () => {
    await deliver(trigger(gmail(), {}, "msg_first"));
    await deliver(trigger(gmail(), {}, "msg_retry"));

    const conversations = await conversationsIn(alpha);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]!.messages.filter((m) => m.from === "agent")).toHaveLength(1);
    expect(sends()).toHaveLength(1);
  });

  it("lands only in the workspace that owns the account", async () => {
    await deliver(trigger(gmail(), { connected_account_id: ACCOUNT_B }));

    expect(await conversationsIn(alpha)).toHaveLength(0);
    expect(await conversationsIn(beta)).toHaveLength(1);
  });

  it("is acknowledged and dropped for an account no workspace owns", async () => {
    await deliver(trigger(gmail(), { connected_account_id: "ca_nobody" }));
    expect(await prisma.conversation.count()).toBe(0);
  });

  it("is acknowledged and dropped for a trigger the channel does not listen on", async () => {
    await deliver(trigger(gmail(), { trigger_slug: "GMAIL_EMAIL_SENT_TRIGGER" }));
    expect(await prisma.conversation.count()).toBe(0);
  });

  it("reaches the model without the history quoted under it", async () => {
    const text = [
      "Yes please, reserve them.",
      "",
      "On Tue, 14 Oct 2026 at 10:02, Acme <sales@acme.test> wrote:",
      "> We have 9 in stock. Shall I reserve two?",
    ].join("\n");
    await deliver(trigger(gmail({ message_text: text })));

    const [conversation] = await conversationsIn(alpha);
    expect(conversation!.messages.find((m) => m.from === "customer")!.text).toBe("Yes please, reserve them.");
  });
});

describe("mail nobody should answer", () => {
  beforeEach(async () => { await connectEmail(alpha, ACCOUNT_A, MAILBOX); });

  const nothingFrom = async (data: Record<string, unknown>) => {
    await deliver(trigger(data));
    expect(await prisma.conversation.count()).toBe(0);
    expect(sends()).toHaveLength(0);
  };

  it("drops a no-reply sender", () => nothingFrom(gmail({ sender: "Shop <no-reply@shop.test>" })));
  // A Meta login alert reached the twin as a customer, had a phone number
  // read out of its HTML, and was answered.
  it("drops a platform security notice", () => nothingFrom(gmail({ sender: "Meta Account Security <security@account.meta.com>" })));
  it("drops an alerts@ sender", () => nothingFrom(gmail({ sender: "Alerts <alerts@bank.test>" })));
  it("drops a bounce", () => nothingFrom(gmail({ sender: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>" })));
  it("drops our own sent copy", () => nothingFrom(gmail({ label_ids: ["SENT", "INBOX"] })));
  it("drops mail from the mailbox itself", () => nothingFrom(gmail({ sender: `Acme <${MAILBOX.toUpperCase()}>` })));
  it("drops a list message", () =>
    nothingFrom(gmail({ payload: { headers: [{ name: "List-Unsubscribe", value: "<mailto:u@list.test>" }] } })));
  it("drops an auto-reply", () =>
    nothingFrom(gmail({ payload: { headers: [{ name: "Auto-Submitted", value: "auto-replied" }] } })));
  it("drops a message that is only quoted history", () =>
    nothingFrom(gmail({ message_text: "On Mon, 13 Oct 2026, Acme wrote:\n> anything else?" })));
});

// ------------------------------------------------------------- outbound --

describe("the reply builder", () => {
  const spec = specFor("email")!;

  it("replies into the thread when there is one", () => {
    expect(spec.send({ to: "deepa@example.com", text: "Done.", config: {}, threadId: "thr_1", subject: "Polo" }))
      .toEqual({ slug: "GMAIL_REPLY_TO_THREAD", arguments: { thread_id: "thr_1", message_body: "Done.", recipient_email: "deepa@example.com" } });
  });

  it("starts a fresh email as a reply to their subject when there is not", () => {
    expect(spec.send({ to: "deepa@example.com", text: "Done.", config: {}, subject: "Polo in L?" }))
      .toEqual({ slug: "GMAIL_SEND_EMAIL", arguments: { recipient_email: "deepa@example.com", subject: "Re: Polo in L?", body: "Done." } });
  });
});

describe("an HTML-only email", () => {
  beforeEach(async () => { await connectEmail(alpha, ACCOUNT_A, MAILBOX); });

  it("reaches the model as its words, not its markup", async () => {
    const html = "<!DOCTYPE html><html><head><style>p{margin:0}</style></head><body><div><p>Hi,<br>do you have the polo in L?</p><p>Thanks &amp; regards</p></div></body></html>";
    await deliver(trigger(gmail({ message_text: html })));

    const [conversation] = await conversationsIn(alpha);
    expect(conversation!.messages.find((m) => m.from === "customer")!.text).toBe("Hi,\ndo you have the polo in L?\n\nThanks & regards");
  });

  it("keeps a plain email exactly as written", () => {
    expect(htmlToText("Two please.\nSize L.")).toBe("Two please.\nSize L.");
  });

  it("decodes entities and drops the head", () => {
    expect(htmlToText("<html><head><title>x</title></head><body>Price &lt; &#8377;2,000 &nbsp;please</body></html>")).toBe("Price < ₹2,000 please");
  });
});

describe("stripping quoted history", () => {
  it("keeps the customer's own line breaks", () => {
    expect(stripQuoted("Two please.\nSize L.\n\n\n\nThanks")).toBe("Two please.\nSize L.\n\nThanks");
  });

  it("cuts at an Outlook header block", () => {
    expect(stripQuoted("Sounds good\r\n\r\nFrom: Acme <sales@acme.test>\r\nSent: Monday")).toBe("Sounds good");
  });

  it("cuts at a forwarded-message marker", () => {
    expect(stripQuoted("See below\n---------- Forwarded message ---------\nhi")).toBe("See below");
  });
});
