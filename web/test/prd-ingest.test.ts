import { beforeEach, describe, expect, it } from "vitest";
import { createUser, createWorkspace, resetDatabase, signedIn } from "./helpers";
import { prisma } from "@/server/lib/prisma";

/**
 * `POST /v1/conversations/ingest` — the PRD's own inbound contract (§8.1).
 *
 * The PRD prints this body verbatim, in a vocabulary the rest of this API does
 * not speak: `source_channel` upper-cased, `external_sender_id`, a nested
 * `payload`, and a `metadata` block naming the business account the message
 * arrived at. What is asserted here is that the translation is exact and that
 * it performs a *real* ingest — the customer twin, the conversation, the
 * reply and the audit trail all have to be there afterwards, or this is a 201
 * that did nothing.
 */

let workspaceId: string;

async function setup(policy: "everything" | "money_only" | "nothing" = "nothing") {
  const { user } = await createUser();
  const workspace = await createWorkspace({ userId: user.id, policy });
  workspaceId = workspace.id;
  return signedIn();
}

/** The PRD's own request body (§8.1), unedited. */
const PRD_BODY = {
  source_channel: "WHATSAPP",
  external_sender_id: "+254711998877",
  payload: { type: "text", content: "Need 400 blue XL polos before Friday." },
  metadata: { business_account_id: "waba_991823" },
};

const connect = (externalId = "waba_991823", channel: "whatsapp" | "telegram" = "whatsapp") =>
  prisma.channelConnection.create({
    data: { workspaceId, channel, status: "connected", externalId, displayName: "WABA" },
  });

beforeEach(async () => { await resetDatabase(); });

describe("the PRD's ingest contract", () => {
  it("accepts the body verbatim and performs a real ingest", async () => {
    const agent = await setup();
    await connect();

    const res = await agent.post("/v1/conversations/ingest").send(PRD_BODY).expect(201);

    expect(res.body.conversation_id).toMatch(/^cnv_/);
    expect(res.body.customer_id).toMatch(/^cus_/);
    expect(res.body.reply).toBeTruthy();
    expect(res.body.held).toBe(false);
    expect(res.body.voiced_by).toBe("template");

    // Not just a 201: the twins actually moved.
    const customer = await prisma.customer.findFirstOrThrow({ where: { workspaceId } });
    expect(customer.handle).toBe("+254711998877");
    expect(customer.channel).toBe("whatsapp");

    const conversation = await prisma.conversation.findFirstOrThrow({
      where: { workspaceId },
      include: { messages: { orderBy: { sentAt: "asc" } } },
    });
    expect(conversation.channel).toBe("whatsapp");
    expect(conversation.messages[0]!.text).toBe("Need 400 blue XL polos before Friday.");
    expect(conversation.messages[1]!.from).toBe("agent");

    const events = await prisma.twinEvent.findMany();
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(["customer_twin.created", "message.received", "intent.extracted"]),
    );
  });

  it("answers at the PRD's own /api/v1 path as well", async () => {
    const agent = await setup();
    await connect();

    const res = await agent.post("/api/v1/conversations/ingest").send(PRD_BODY).expect(201);
    expect(res.body.conversation_id).toMatch(/^cnv_/);
    expect(await prisma.conversation.count()).toBe(1);
  });

  it("maps every channel name the PRD uses", async () => {
    const agent = await setup();

    for (const [named, stored] of [["TELEGRAM", "telegram"], ["WEB_SDK", "webchat"], ["X", "x"]] as const) {
      await agent
        .post("/v1/conversations/ingest")
        .send({ ...PRD_BODY, source_channel: named, external_sender_id: `sender_${named}`, metadata: {} })
        .expect(201);

      const customer = await prisma.customer.findFirstOrThrow({ where: { handle: `sender_${named}` } });
      expect(customer.channel, named).toBe(stored);
    }
  });

  it("refuses a channel it has never heard of, and lists the ones it knows", async () => {
    const agent = await setup();
    const res = await agent
      .post("/v1/conversations/ingest")
      .send({ ...PRD_BODY, source_channel: "CARRIER_PIGEON", metadata: {} })
      .expect(422);

    expect(res.body.error).toContain('Unknown source_channel "CARRIER_PIGEON"');
    expect(res.body.details.source_channel).toContain("WHATSAPP");
    expect(await prisma.conversation.count()).toBe(0);
  });

  // A message type this deployment cannot read must be refused, not silently
  // dropped — an integrator posting images should be told, not left waiting.
  it("refuses a payload type it cannot ingest rather than dropping it", async () => {
    const agent = await setup();
    const res = await agent
      .post("/v1/conversations/ingest")
      .send({ ...PRD_BODY, payload: { type: "image", content: "https://example.com/a.jpg" }, metadata: {} })
      .expect(422);

    expect(res.body.error).toContain("ingests text messages only");
    expect(await prisma.conversation.count()).toBe(0);
  });

  it("rejects a malformed body with field-level detail", async () => {
    const agent = await setup();
    const res = await agent.post("/v1/conversations/ingest").send({ source_channel: "WHATSAPP" }).expect(422);
    expect(res.body.error).toBe("Invalid conversation ingest");
    expect(res.body.details).toHaveProperty("external_sender_id");
  });
});

describe("the business account in metadata", () => {
  // Accepted and checked rather than ignored: silently dropping it would let
  // an integrator believe they had routed a message somewhere they had not.
  it("is refused when this workspace has no such connection", async () => {
    const agent = await setup();
    const res = await agent.post("/v1/conversations/ingest").send(PRD_BODY).expect(404);

    expect(res.body.error).toContain("waba_991823");
    expect(await prisma.conversation.count()).toBe(0);
  });

  it("is refused when it is connected as a different channel", async () => {
    const agent = await setup();
    await connect("waba_991823", "telegram");

    const res = await agent.post("/v1/conversations/ingest").send(PRD_BODY).expect(409);
    expect(res.body.error).toContain("connected as telegram");
  });

  // Tenant isolation (invariant 5): another tenant's account id is simply not
  // found here, whatever it is connected as over there.
  it("cannot name another tenant's business account", async () => {
    const agent = await setup();
    const { user: other } = await createUser("other@test.local");
    const theirs = await createWorkspace({ userId: other.id, name: "Other Co" });
    await prisma.channelConnection.create({
      data: { workspaceId: theirs.id, channel: "whatsapp", status: "connected", externalId: "waba_theirs" },
    });

    await agent
      .post("/v1/conversations/ingest")
      .send({ ...PRD_BODY, metadata: { business_account_id: "waba_theirs" } })
      .expect(404);
  });

  it("is optional", async () => {
    const agent = await setup();
    await agent.post("/v1/conversations/ingest").send({ ...PRD_BODY, metadata: undefined }).expect(201);
  });
});

describe("what the ingest reports back", () => {
  it("reports a held reply under a strict approval policy rather than claiming it was sent", async () => {
    const agent = await setup("everything");
    const res = await agent
      .post("/v1/conversations/ingest")
      .send({ ...PRD_BODY, metadata: {} })
      .expect(201);

    expect(res.body.held).toBe(true);
    const message = await prisma.message.findFirstOrThrow({ where: { from: "agent" } });
    expect(message.deliveryStatus).toBe("held");
  });

  it("reports the order and invoice when the message actually bought something", async () => {
    const agent = await setup();
    const res = await agent
      .post("/v1/conversations/ingest")
      .send({
        ...PRD_BODY,
        payload: { type: "text", content: "I want 2 olive L polos" },
        metadata: {},
      })
      .expect(201);

    expect(res.body.order).not.toBeNull();
    expect(res.body.invoice).not.toBeNull();
    expect(res.body.intent).toBe("buy");

    const order = await prisma.order.findFirstOrThrow({ where: { workspaceId } });
    expect(res.body.order.id).toBe(order.id);
  });

  it("refuses an anonymous caller", async () => {
    await setup();
    const { agent } = await import("./dispatch");
    await agent().post("/v1/conversations/ingest").send(PRD_BODY).expect(401);
  });
});
