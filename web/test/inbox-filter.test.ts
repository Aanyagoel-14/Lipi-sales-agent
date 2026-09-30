import { beforeEach, describe, expect, it } from "vitest";
import { createUser, createWorkspace, resetDatabase, signedIn } from "./helpers";
import { prisma } from "@/server/lib/prisma";
import { ingest } from "@/server/services/ingest";

/**
 * The channel rail on the split-pane workspace (PRD §7.1).
 *
 * It filters on the server. Narrowing a loaded page in the browser would show
 * three of fifty rows and call it the WhatsApp feed, and the cursor would go
 * on paging through the unfiltered list underneath it — so the control would
 * be wrong in exactly the way that is hardest to notice.
 */

let workspaceId: string;

async function setup() {
  const { user } = await createUser();
  const workspace = await createWorkspace({ userId: user.id, policy: "nothing" });
  workspaceId = workspace.id;

  // Three threads, on three channels.
  await ingest({ workspaceId, channel: "whatsapp", handle: "+91 90 000 0001", text: "hello from whatsapp" });
  await ingest({ workspaceId, channel: "telegram", handle: "@tg_user", text: "hello from telegram" });
  await ingest({ workspaceId, channel: "webchat", handle: "web:abc", text: "hello from the widget" });

  return signedIn();
}

beforeEach(async () => { await resetDatabase(); });

describe("filtering the thread list by channel", () => {
  it("returns every channel when none is named", async () => {
    const agent = await setup();
    const res = await agent.get("/v1/conversations").expect(200);

    expect(res.body.conversations).toHaveLength(3);
  });

  it("returns only the named channel", async () => {
    const agent = await setup();
    const res = await agent.get("/v1/conversations?channel=telegram").expect(200);

    expect(res.body.conversations).toHaveLength(1);
    expect(res.body.conversations[0].channel).toBe("telegram");
  });

  // Repeatable, like `?stage=` on conversions: an operator watching two
  // channels is one feed, not two tabs.
  it("takes more than one channel", async () => {
    const agent = await setup();
    const res = await agent.get("/v1/conversations?channel=telegram&channel=webchat").expect(200);

    expect(res.body.conversations.map((c: { channel: string }) => c.channel).sort()).toEqual(
      ["telegram", "webchat"],
    );
  });

  it("refuses a channel it has never heard of rather than returning everything", async () => {
    const agent = await setup();
    const res = await agent.get("/v1/conversations?channel=carrier_pigeon").expect(422);

    expect(res.body.error).toContain("Unknown channel: carrier_pigeon");
  });

  // The filter narrows a query that is already scoped to the workspace, so it
  // can only ever return fewer rows — never another tenant's.
  it("cannot reach another tenant's threads", async () => {
    const agent = await setup();

    const { user: other } = await createUser("other@test.local");
    const theirs = await createWorkspace({ userId: other.id, name: "Other Co" });
    await ingest({ workspaceId: theirs.id, channel: "telegram", handle: "@theirs", text: "not yours" });

    const res = await agent.get("/v1/conversations?channel=telegram").expect(200);
    expect(res.body.conversations).toHaveLength(1);

    const mine = await prisma.conversation.findFirstOrThrow({ where: { workspaceId, channel: "telegram" } });
    expect(res.body.conversations[0].id).toBe(mine.id);
  });

  it("pages within the filter rather than out of it", async () => {
    const agent = await setup();
    for (let i = 0; i < 3; i++) {
      await ingest({ workspaceId, channel: "telegram", handle: `@tg_${i}`, text: `telegram ${i}` });
    }

    const first = await agent.get("/v1/conversations?channel=telegram&limit=2").expect(200);
    expect(first.body.conversations).toHaveLength(2);
    expect(first.body.nextCursor).not.toBeNull();

    const second = await agent
      .get(`/v1/conversations?channel=telegram&limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`)
      .expect(200);

    for (const conversation of second.body.conversations) {
      expect(conversation.channel).toBe("telegram");
    }
  });
});

/**
 * `ingest()` opens a conversation per message, so somebody who wrote three
 * times was three rows in the inbox. `?by=customer` is what the inbox asks
 * for: one row per person per channel, and one continuing chat when opened.
 */
describe("one chat per person", () => {
  it("lists a customer who wrote several times once, with every message counted", async () => {
    const agent = await setup();
    await ingest({ workspaceId, channel: "telegram", handle: "@tg_user", text: "second" });
    await ingest({ workspaceId, channel: "telegram", handle: "@tg_user", text: "third" });

    const plain = await agent.get("/v1/conversations?channel=telegram").expect(200);
    expect(plain.body.conversations).toHaveLength(3);

    const grouped = await agent.get("/v1/conversations?channel=telegram&by=customer").expect(200);
    expect(grouped.body.conversations).toHaveLength(1);
    expect(grouped.body.conversations[0].messageCount).toBe(
      plain.body.conversations.reduce((n: number, c: { messageCount: number }) => n + c.messageCount, 0),
    );
    expect(grouped.body.conversations[0].lastMessage.text).not.toBe("hello from telegram");
  });

  it("keeps the same person apart on different channels", async () => {
    const agent = await setup();
    await ingest({ workspaceId, channel: "webchat", handle: "+91 90 000 0001", text: "same number, other channel" });

    const grouped = await agent.get("/v1/conversations?by=customer").expect(200);
    const pairs = grouped.body.conversations.map((c: { customerId: string; channel: string }) => `${c.customerId}/${c.channel}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it("opens the whole chat, oldest first, from any of its conversations", async () => {
    const agent = await setup();
    await ingest({ workspaceId, channel: "telegram", handle: "@tg_user", text: "second" });

    const oldest = await prisma.conversation.findFirstOrThrow({
      where: { workspaceId, channel: "telegram" }, orderBy: { lastAt: "asc" },
    });
    const res = await agent.get(`/v1/conversations/${oldest.id}?by=customer`).expect(200);
    const customerLines = res.body.conversation.messages
      .filter((m: { from: string }) => m.from === "customer")
      .map((m: { text: string }) => m.text);
    expect(customerLines).toEqual(["hello from telegram", "second"]);

    // Without it the endpoint is unchanged: one conversation's messages.
    const single = await agent.get(`/v1/conversations/${oldest.id}`).expect(200);
    expect(single.body.conversation.messages.length).toBeLessThan(res.body.conversation.messages.length);
  });

  it("never lists a person twice across pages", async () => {
    const agent = await setup();
    for (let i = 0; i < 3; i++) {
      await ingest({ workspaceId, channel: "telegram", handle: "@tg_user", text: `again ${i}` });
      await ingest({ workspaceId, channel: "telegram", handle: `@tg_${i}`, text: `telegram ${i}` });
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = `/v1/conversations?by=customer&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const res = await agent.get(query).expect(200);
      seen.push(...res.body.conversations.map((c: { customerId: string; channel: string }) => `${c.customerId}/${c.channel}`));
      cursor = res.body.nextCursor;
    } while (cursor);

    expect(seen).toHaveLength(new Set(seen).size);
    // whatsapp, webchat, @tg_user and three more telegram customers.
    expect(seen).toHaveLength(6);
  });

  it("stays inside the workspace", async () => {
    const agent = await setup();
    const { user } = await createUser("other@test.local");
    const other = await createWorkspace({ userId: user.id, policy: "nothing" });
    await ingest({ workspaceId: other.id, channel: "telegram", handle: "@tg_user", text: "someone else's" });

    const grouped = await agent.get("/v1/conversations?by=customer").expect(200);
    expect(grouped.body.conversations).toHaveLength(3);
  });
});
