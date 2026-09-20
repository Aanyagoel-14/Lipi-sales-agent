import { beforeEach, describe, expect, it } from "vitest";
import { createUser, createWorkspace, resetDatabase } from "./helpers";
import { prisma } from "@/server/lib/prisma";
import { ingest } from "@/server/services/ingest";

/**
 * Progressive contact capture, through the loop that writes it (#16).
 *
 * `detectContact` decides what a string is (test/extract.test.ts) and
 * `nextContactAsk` decides when to ask (test/leads.test.ts). What is left,
 * and what these cases cover, is what reaches the customer twin: with what
 * provenance, under what evidence, and what happens when the address is
 * already somebody else's.
 */

let workspaceId: string;

async function setup(name = "Test Co") {
  const { user } = await createUser(`${name.toLowerCase().replace(/\W+/g, "")}@test.local`);
  const workspace = await createWorkspace({ userId: user.id, name });
  return workspace.id;
}

const say = (text: string, handle = "web:visitor-0001") =>
  ingest({ workspaceId, channel: "webchat", handle, text });

const twin = (handle = "web:visitor-0001") =>
  prisma.customer.findFirstOrThrow({ where: { workspaceId, handle } });

const eventsOfType = (type: string) =>
  prisma.twinEvent.findMany({ where: { workspaceId, type }, orderBy: { occurredAt: "asc" } });

beforeEach(async () => {
  await resetDatabase();
  workspaceId = await setup();
});

describe("what a visitor volunteers", () => {
  it("captures an address nobody asked for, with its provenance and the moment", async () => {
    const before = new Date();
    await say("do you ship to Pune? mail me at priya@shop.test");

    const customer = await twin();
    expect(customer.email).toBe("priya@shop.test");
    expect(customer.emailSource).toBe("volunteered");
    expect(customer.emailAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(customer.phone).toBeNull();
  });

  it("captures a phone number the same way", async () => {
    await say("call me on 9876543210");

    const customer = await twin();
    expect(customer.phone).toBe("9876543210");
    expect(customer.phoneSource).toBe("volunteered");
  });

  // Invariant 6: capture is evidence, and evidence is an event.
  it("records the capture as a TwinEvent naming the field, not the address", async () => {
    await say("mail me at priya@shop.test");

    const [event] = await eventsOfType("customer_twin.contact_captured");
    expect(event!.twin).toBe("customer");
    expect(event!.payload).toContain("field=email source=volunteered");
    expect(event!.payload).not.toContain("priya@shop.test");
  });

  it("names a webchat twin once they introduce themselves", async () => {
    await say("hi, my name is Priya Sharma");

    expect((await twin()).name).toBe("Priya Sharma");
  });

  it("does not rename a twin that already has a name", async () => {
    await say("my name is Priya Sharma");
    await say("this is Urgent, where is my order");

    expect((await twin()).name).toBe("Priya Sharma");
  });

  it("writes nothing when the same address arrives a second time", async () => {
    await say("mail me at priya@shop.test");
    const first = await twin();

    await say("as I said, priya@shop.test");

    const second = await twin();
    expect(second.emailAt!.getTime()).toBe(first.emailAt!.getTime());
    expect(await eventsOfType("customer_twin.contact_captured")).toHaveLength(1);
  });

  it("takes a correction, because the newer address is the one they use", async () => {
    await say("mail me at priya@shop.test");
    await say("sorry, that should be priya.sharma@shop.test");

    expect((await twin()).email).toBe("priya.sharma@shop.test");
  });

  it("leaves the twin alone when a message carries no contact details", async () => {
    await say("do you have olive polos in L");

    const customer = await twin();
    expect(customer.email).toBeNull();
    expect(customer.phone).toBeNull();
    expect(await eventsOfType("customer_twin.contact_captured")).toHaveLength(0);
  });
});

describe("an address that already belongs to someone else", () => {
  it("keeps the two twins two people and flags it for the operator", async () => {
    await say("mail me at shared@shop.test", "web:visitor-0001");
    await say("mail me at shared@shop.test", "web:visitor-0002");

    const [first, second] = await prisma.customer.findMany({
      where: { workspaceId }, orderBy: { handle: "asc" },
    });
    expect(first!.id).not.toBe(second!.id);
    expect(first!.email).toBe("shared@shop.test");
    expect(second!.email).toBe("shared@shop.test");

    const [flag] = await eventsOfType("customer_twin.contact_conflict");
    expect(flag!.payload).toContain(`${second!.id} field=email also_on=${first!.id}`);
    expect(flag!.payload).toContain("resolution=not_merged");
  });

  it("reports the conflict on the result, so the caller does not have to read the log", async () => {
    await say("mail me at shared@shop.test", "web:visitor-0001");
    const result = await say("mail me at shared@shop.test", "web:visitor-0002");

    expect(result.contact.captured).toEqual(["email"]);
    expect(result.contact.duplicateEmail).toBe(true);
  });

  // Invariant 5. The same address in two workspaces is two unrelated people,
  // and neither is evidence about the other.
  it("says nothing about an address held by a twin in another workspace", async () => {
    await say("mail me at shared@shop.test", "web:visitor-0001");

    const other = await setup("Other Co");
    const elsewhere = await ingest({
      workspaceId: other, channel: "webchat", handle: "web:visitor-0009",
      text: "mail me at shared@shop.test",
    });

    expect(elsewhere.contact.duplicateEmail).toBe(false);
    expect(await prisma.twinEvent.count({
      where: { workspaceId: other, type: "customer_twin.contact_conflict" },
    })).toBe(0);
  });
});

describe("what the twin is told to ask for next", () => {
  it("asks for nothing while the conversation is still cold", async () => {
    const result = await say("hi");

    expect(result.contactAsk).toBeNull();
  });

  it("asks for a name once the conversation is worth asking in", async () => {
    const result = await say("I need 3 olive L polos");

    expect(result.contactAsk).toBe("name");
  });

  it("moves on to the next thing rather than asking twice", async () => {
    await say("my name is Priya Sharma");
    const result = await say("I need 3 olive L polos");

    expect(result.contactAsk).toBe("email");
  });

  it("asks for nothing once it has all three", async () => {
    await say("my name is Priya Sharma, mail me at priya@shop.test, or call 9876543210");
    const result = await say("I need 3 olive L polos");

    expect(result.contactAsk).toBeNull();
  });
});

/**
 * On two channels the handle is already a way to reach them: a WhatsApp
 * handle is a phone number and an email handle is an address. Asking for
 * what the thread already is makes the twin look like it is not reading its
 * own screen, so the handle counts as held.
 */
describe("what the channel already gives the twin", () => {
  const on = (channel: "whatsapp" | "email" | "telegram", handle: string) =>
    ingest({ workspaceId, channel, handle, text: "I need 3 olive L polos" });

  it("does not ask a WhatsApp customer for the number it is messaging", async () => {
    const result = await on("whatsapp", "919876543210");

    expect(result.contactAsk).toBe("name");

    await ingest({ workspaceId, channel: "whatsapp", handle: "919876543210", text: "my name is Priya" });
    const next = await on("whatsapp", "919876543210");
    expect(next.contactAsk).toBe("email");
  });

  it("does not ask an email customer for their email address", async () => {
    const result = await on("email", "priya@shop.test");

    expect(result.contactAsk).toBe("name");

    await ingest({ workspaceId, channel: "email", handle: "priya@shop.test", text: "my name is Priya" });
    const next = await on("email", "priya@shop.test");
    expect(next.contactAsk).toBe("phone");
  });

  // A Telegram chat id is neither, so nothing is assumed from it.
  it("assumes nothing from a handle that is only an account id", async () => {
    const result = await on("telegram", "845112039");

    expect(result.contactAsk).toBe("name");

    await ingest({ workspaceId, channel: "telegram", handle: "845112039", text: "my name is Priya" });
    const next = await on("telegram", "845112039");
    expect(next.contactAsk).toBe("email");
  });
});
