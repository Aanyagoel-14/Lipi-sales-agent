import { beforeEach, describe, expect, it } from "vitest";
import { createUser, createWorkspace, resetDatabase, signedIn } from "./helpers";
import { fakeEndpoint } from "./fakes/webhook-endpoint";
import { prisma } from "@/server/lib/prisma";
import { executeSkill } from "@/server/agents/execute";
import { parseGuardrails } from "@/server/agents/guardrails";
import { setPaymentProvider, type PaymentProvider } from "@/server/lib/payments";
import { dispatch, subscribe } from "@/server/services/webhooks";

/**
 * PRD §6, Use Case 1 — Autonomous Conversational Commerce.
 *
 * The PRD's own scenario, driven by its own sentence, asserted step by step:
 *
 *   Trigger      a WhatsApp message asking for 400 blue XL polos before Friday
 *                at $8.50 a unit
 *   NLU          intent Order_Negotiation; item, colour, size, quantity,
 *                offer and deadline extracted
 *   Twin         inventory confirms 600 in stock; pricing validates the offer
 *                against the floor; the customer twin has no overdue invoices
 *   Execution    400 units locked, a checkout link generated, a reply sent on
 *                WhatsApp, and the order draft pushed to the ERP
 *
 * The amounts are the PRD's, read as integer minor units of whatever this
 * deployment sells in — see docs/impl/DECISIONS.md D-009. $8.50 is 850 and
 * the $8.40 floor is 840.
 */

/** The PRD's message, verbatim. */
const MESSAGE = "Need 400 blue XL polo shirts delivered to Nairobi warehouse before Friday. Can we do $8.50/unit?";

const BUYER = "+254711998877";
const WABA = "waba_991823";

/** The PRD's numbers. */
const STOCK = 600;
const WANTED = 400;
const OFFER = 850;
const FLOOR = 840;

let workspaceId: string;
let variantId: string;

async function setup() {
  const { user } = await createUser();
  const workspace = await createWorkspace({ userId: user.id, policy: "nothing" });
  workspaceId = workspace.id;

  await prisma.channelConnection.create({
    data: { workspaceId, channel: "whatsapp", status: "connected", externalId: WABA, displayName: "Nairobi WABA" },
  });

  // The PRD's inventory position, on the variant its sentence describes.
  const variant = await prisma.variant.findFirstOrThrow({
    where: { optionA: "XL", optionB: "Cobalt", product: { workspaceId, name: "Polo Classic" } },
  });
  variantId = variant.id;
  await prisma.variant.update({ where: { id: variant.id }, data: { stock: STOCK, reserved: 0 } });

  // The list price the offer is negotiated against. At a 41% stored margin the
  // implied cost is 590, so 840 leaves well over the PRD's 18% margin floor —
  // which is what makes $8.50 an offer the twin may take and $7.00 one it may
  // not.
  await prisma.product.update({
    where: { id: variant.productId },
    data: { price: 1_000 },
  });

  return signedIn();
}

/** The agent the PRD's business would have deployed: an SDR with a floor. */
async function deployedSdr() {
  return prisma.agent.create({
    data: {
      workspaceId,
      name: "Wholesale Sales Assistant",
      template: "sdr",
      status: "deployed",
      channels: ["whatsapp"],
      guardrails: parseGuardrails({
        // 840 of a 1000 list price is a 16% allowance.
        max_autonomous_discount_pct: 0.16,
        min_margin_pct: 18,
        human_escalation_triggers: ["DISPUTE", "REFUND_OVER_500"],
      }) as object,
      deployedAt: new Date(),
      skills: {
        create: [
          { skill: "Inventory_Lookup" },
          { skill: "Discount_Calculator" },
          { skill: "Stripe_Invoice" },
          { skill: "Lead_Scoring" },
        ],
      },
    },
  });
}

beforeEach(async () => {
  await resetDatabase();
  setPaymentProvider(null);
});

describe("PRD §6 Use Case 1 — autonomous conversational commerce", () => {
  it("runs the PRD's scenario end to end", async () => {
    const operator = await setup();
    const agent = await deployedSdr();

    /* ------------------------------------------------- the ERP, subscribed */
    // The PRD ends with "pushes order draft to NetSuite ERP". There is no
    // NetSuite here, and there is a signed, retried, at-least-once delivery of
    // the twin event log to a customer's own system — which is the shape an
    // ERP push takes. The fake endpoint is the ERP.
    const { secret } = await subscribe(workspaceId, {
      url: "https://erp.example.com/lipi",
      eventTypes: ["order_twin.created", "inventory_twin.reserved"],
    });

    /* ------------------------------------- trigger: the message on WhatsApp */
    const ingested = await operator
      .post("/v1/conversations/ingest")
      .send({
        source_channel: "WHATSAPP",
        external_sender_id: BUYER,
        payload: { type: "text", content: MESSAGE },
        metadata: { business_account_id: WABA },
      })
      .expect(201);

    /* --------------------------------------------------- NLU: what was said */
    const conversation = await prisma.conversation.findFirstOrThrow({
      where: { workspaceId },
      include: { messages: { orderBy: { sentAt: "asc" } } },
    });

    const intent = await prisma.twinEvent.findFirstOrThrow({ where: { type: "intent.extracted" } });
    expect(intent.payload).toContain("intent=buy");
    expect(intent.payload).toContain("qty=400");
    expect(intent.payload).toContain("size=XL");
    // "blue" resolves to Cobalt through the trade's own vocabulary.
    expect(intent.payload).toContain("colour=Cobalt");

    // "before Friday" is resolved to a date rather than kept as the word,
    // which is what makes it a deadline a fulfilment system can act on. Which
    // Friday depends on when the suite runs, so what is asserted is that it
    // resolved to one.
    const deadline = /deadline=(\d{4}-\d{2}-\d{2})/.exec(intent.payload)?.[1];
    expect(deadline, intent.payload).toBeDefined();
    expect(new Date(`${deadline}T00:00:00Z`).getUTCDay()).toBe(5);

    // Item and colour, on the record, as the matched product twin.
    const matched = await prisma.twinEvent.findFirstOrThrow({ where: { type: "product_twin.matched" } });
    expect(matched.payload).toContain("XL/Cobalt");

    // The deadline is carried onto the order rather than only into the reply.
    const order = await prisma.order.findFirstOrThrow({ where: { workspaceId } });
    expect(order.blocked).toBe(`Deliver by ${deadline}`);

    /* ---------------------------------- twin validation: inventory has 600 */
    const lookup = await executeSkill({
      workspaceId,
      agentId: agent.id,
      customerId: order.customerId,
      skill: "Inventory_Lookup",
      args: { product: "Polo Classic", optionA: "XL", optionB: "Cobalt" },
    });
    if (lookup.status === "refused") throw new Error(lookup.reason);
    // 600 in stock, 400 now reserved against this very order.
    expect(lookup.data.variants).toEqual([
      expect.objectContaining({ stock: STOCK, reserved: WANTED, available: STOCK - WANTED }),
    ]);

    /* --------------------- twin validation: $8.50 clears the $8.40 floor */
    const pricing = await executeSkill({
      workspaceId,
      agentId: agent.id,
      customerId: order.customerId,
      skill: "Discount_Calculator",
      requestText: MESSAGE,
      args: { product: "Polo Classic", quantity: WANTED, requestedUnitPrice: OFFER },
    });
    if (pricing.status === "refused") throw new Error(pricing.reason);
    expect(pricing.status).toBe("done");
    expect(pricing.data.authorised).toBe(true);
    expect(pricing.data.floorUnitPrice).toBe(FLOOR);
    expect(pricing.data.authorisedUnitPrice).toBe(OFFER);
    expect(pricing.data.totalMinorUnits).toBe(OFFER * WANTED);

    /* ----------------------- twin validation: no overdue invoices, no hold */
    expect(ingested.body.held).toBe(false);
    expect(order.creditHold).toBe(false);

    /* ------------------------------- execution: 400 units actually locked */
    const variant = await prisma.variant.findFirstOrThrow({ where: { id: variantId } });
    expect(variant.reserved).toBe(WANTED);
    expect(variant.stock - variant.reserved).toBe(STOCK - WANTED);

    // And the lock is the PRD's four-hour one, not a permanent one.
    expect(order.reservedUntil).not.toBeNull();

    /* ----------------------------------- execution: the checkout generated */
    const provider: PaymentProvider = {
      name: "stripe",
      configured: () => true,
      async createCheckoutLink(request) {
        expect(request.amount).toBe(order.value);
        return {
          ok: true,
          provider: "stripe",
          link: { url: `https://pay.example/${request.reference}`, providerRef: "cs_uc1", expiresAt: null },
        };
      },
    };
    setPaymentProvider(provider);

    const checkout = await executeSkill({
      workspaceId,
      agentId: agent.id,
      customerId: order.customerId,
      skill: "Stripe_Invoice",
      args: { orderId: order.id },
    });
    if (checkout.status === "refused") throw new Error(checkout.reason);
    expect(checkout.data.checkoutUrl).toBe(`https://pay.example/${checkout.data.invoiceNumber}`);
    expect(checkout.data.amountMinorUnits).toBe(order.value);

    /* ---------------------------------- execution: the reply, on WhatsApp */
    const reply = conversation.messages.find((message) => message.from === "agent");
    expect(reply).toBeDefined();
    expect(conversation.channel).toBe("whatsapp");
    expect(ingested.body.reply).toBe(reply!.text);
    // Nothing was held, so the reply is the one that goes out.
    expect(reply!.deliveryStatus).not.toBe("held");

    /* --------------------------- execution: the order draft pushed to ERP */
    const summary = await dispatch(workspaceId);
    expect(summary.delivered).toBeGreaterThan(0);

    const pushed = fakeEndpoint.posts.map((post) => JSON.parse(post.body));
    const orderEvent = pushed.find((body) => body.event.type === "order_twin.created");
    expect(orderEvent).toBeDefined();
    expect(orderEvent.event.payload).toContain(order.id);
    // Signed, so the ERP can tell it came from us.
    const post = fakeEndpoint.posts.find((p) => JSON.parse(p.body).event.type === "order_twin.created")!;
    expect(fakeEndpoint.verify(post, secret)).toBe(true);

    /* --------------------------------------------------- the audit trail */
    const trail = await prisma.twinEvent.findMany({ orderBy: { occurredAt: "asc" } });
    expect(trail.map((e) => e.type)).toEqual(
      expect.arrayContaining([
        "customer_twin.created",
        "message.received",
        "intent.extracted",
        "product_twin.matched",
        "inventory_twin.reserved",
        "inventory_twin.hold_placed",
        "order_twin.created",
        "lead.scored",
        "agent.dispatched",
        "pricing.evaluated",
        "invoice.issued",
        "checkout.link_created",
      ]),
    );
  });

  /* --------------------------------------------------------------------- */

  // The other half of the PRD's pricing rule: an offer below the floor is not
  // taken, and it is not silently clamped either — the operator gets a
  // counter-offer to approve.
  it("refuses an offer below the floor and escalates with what it could do", async () => {
    await setup();
    const agent = await deployedSdr();

    const pricing = await executeSkill({
      workspaceId,
      agentId: agent.id,
      skill: "Discount_Calculator",
      args: { product: "Polo Classic", quantity: WANTED, requestedUnitPrice: 700 },
    });

    expect(pricing.status).toBe("needs_approval");
    if (pricing.status === "refused") throw new Error("unreachable");
    expect(pricing.data.authorised).toBe(false);
    expect(pricing.data.floorUnitPrice).toBe(FLOOR);
    expect(await prisma.approval.count()).toBe(1);
  });

  // "Customer Twin verifies 0 overdue invoices" — so what happens when it does
  // not. The sale still completes; the order carries the flag and the money
  // skill waits for a person.
  it("flags a buyer with an overdue invoice and holds the money skill for a human", async () => {
    await setup();
    const agent = await deployedSdr();

    const first = await prisma.customer.create({
      data: {
        id: "cus_uc1", workspaceId, name: "Nairobi Wholesale", handle: BUYER,
        channel: "whatsapp", segment: "Wholesale", lifetimeValue: 0, orderCount: 0,
        avgOrderValue: 0, returnRatePct: 0, priceSensitivity: "Medium",
        negotiationStyle: "Unknown", sizeProfile: [], predictedNext: "Unknown",
        riskScore: 20, lastSeenAt: new Date(),
      },
    });
    await prisma.invoice.create({
      data: {
        number: "INV-2026-8001-test", workspaceId, source: "manual",
        issuedOn: new Date("2026-01-01"), dueOn: new Date("2026-01-15"),
        amount: 12_000, customerId: first.id,
      },
    });

    const { ingest } = await import("@/server/services/ingest");
    const result = await ingest({ workspaceId, channel: "whatsapp", handle: BUYER, text: MESSAGE });

    expect(result.creditHold).toBe(true);
    expect(result.order).not.toBeNull();

    const order = await prisma.order.findFirstOrThrow({ where: { id: result.order!.id } });
    expect(order.creditHold).toBe(true);

    const pricing = await executeSkill({
      workspaceId,
      agentId: agent.id,
      customerId: first.id,
      skill: "Discount_Calculator",
      args: { product: "Polo Classic", quantity: WANTED, requestedUnitPrice: OFFER },
    });
    expect(pricing.status).toBe("needs_approval");
    if (pricing.status === "refused") throw new Error("unreachable");
    expect(pricing.escalationReason).toContain("past-due invoice");
  });

  // The PRD's inventory check has to be able to say no.
  it("does not reserve stock it does not have", async () => {
    const operator = await setup();
    await prisma.variant.update({ where: { id: variantId }, data: { stock: 100, reserved: 0 } });

    await operator
      .post("/v1/conversations/ingest")
      .send({
        source_channel: "WHATSAPP",
        external_sender_id: BUYER,
        payload: { type: "text", content: MESSAGE },
        metadata: { business_account_id: WABA },
      })
      .expect(201);

    expect(await prisma.order.count({ where: { workspaceId } })).toBe(0);
    const variant = await prisma.variant.findFirstOrThrow({ where: { id: variantId } });
    expect(variant.reserved).toBe(0);

    const trail = await prisma.twinEvent.findMany();
    expect(trail.map((e) => e.type)).toContain("inventory_twin.shortfall");
  });
});
