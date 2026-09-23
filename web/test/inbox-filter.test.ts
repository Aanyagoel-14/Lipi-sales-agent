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
