import { randomUUID } from "node:crypto";
import { toPaise } from "../lib/money";
import { generateSku } from "../lib/sku";
import { catalogueFor, type Vertical } from "./catalogues";
import type { Channel, PrismaClient } from "@/generated/prisma/client";

type Tx = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$use" | "$extends" | "$transaction">;

const id = (prefix: string) => `${prefix}_${randomUUID().slice(0, 8)}`;

/**
 * Everything a new tenant needs to be usable on the first screen.
 *
 * The catalogue comes from the chosen vertical, so an auto parts business gets
 * fitments and grades rather than sizes and colours. The demo history is
 * generated from that same catalogue rather than copied from a fixture, so no
 * workspace ever shows an order for a product it does not sell.
 */

export async function provisionVoice(tx: Tx, workspaceId: string, businessName: string) {
  await tx.twinVoice.create({
    data: {
      workspaceId,
      formality: "friendly",
      length: "balanced",
      useEmoji: false,
      signOff: `— ${businessName}`,
      languages: ["English"],
      greeting: "Hi!",
      neverSay: ["guaranteed", "no questions asked", "unlimited"],
      alwaysSay: ["confirm stock before promising a date"],
    },
  });
}

const KNOWLEDGE: Record<Vertical, { kind: "policy" | "faq" | "sizing" | "shipping" | "warranty" | "pricing"; title: string; body: string }[]> = {
  apparel: [
    { kind: "policy", title: "Returns window", body: "Unworn items can be returned within 14 days of delivery with the original packaging." },
    { kind: "sizing", title: "Size exchanges", body: "One free size exchange per order. The replacement ships once the original is collected." },
    { kind: "shipping", title: "Dispatch times", body: "Orders confirmed before 2pm dispatch the same working day. Metro delivery is 2 to 3 days." },
    { kind: "warranty", title: "Manufacturing defects", body: "Stitching and fabric defects are covered for 90 days from delivery." },
    { kind: "pricing", title: "Volume discounts", body: "Orders above 100 units qualify for tiered pricing. Discounts beyond 10% need owner approval." },
  ],
  auto_parts: [
    { kind: "policy", title: "Fitment guarantee", body: "If a part does not fit the vehicle you gave us, we exchange it and cover return freight." },
    { kind: "warranty", title: "Warranty terms", body: "OEM parts carry the manufacturer warranty. Aftermarket parts carry 6 to 12 months depending on the line." },
    { kind: "shipping", title: "Dispatch times", body: "In-stock parts dispatch same day. Special order items follow the supplier lead time on the quote." },
    { kind: "faq", title: "Fitment confirmation", body: "We confirm fitment from the registration or VIN before any part is reserved." },
    { kind: "pricing", title: "Trade pricing", body: "Registered garages get trade rates. Discounts beyond 10% need owner approval." },
  ],
  marine: [
    { kind: "policy", title: "Survey and sea trial", body: "Brokerage vessels are sold subject to survey and sea trial, arranged at the buyer's cost." },
    { kind: "policy", title: "Deposit terms", body: "A 10% refundable deposit holds a vessel for 14 days pending survey." },
    { kind: "shipping", title: "Delivery and transport", body: "Road transport is quoted separately by length and beam. Coastal delivery is by arrangement." },
    { kind: "warranty", title: "Warranty", body: "New vessels carry the builder warranty. Brokerage vessels are sold as seen." },
    { kind: "pricing", title: "Negotiation", body: "Offers below asking are presented to the owner. Nothing is accepted without owner sign-off." },
  ],
  wholesale: [
    { kind: "pricing", title: "Volume tiers", body: "Pricing steps at 100, 500 and 2000 units. Quotes hold for 7 days." },
    { kind: "policy", title: "Payment terms", body: "Net 30 for accounts in good standing. First orders are prepaid." },
    { kind: "shipping", title: "Minimum order", body: "Minimum order value applies per supplier. Part pallets attract a handling fee." },
    { kind: "warranty", title: "Short shipments", body: "Report shortages or damage within 48 hours of delivery with photographs." },
    { kind: "faq", title: "Shelf life", body: "We ship stock with at least two thirds of its shelf life remaining." },
  ],
};

const EXAMPLES: Record<Vertical, { customerSays: string; twinReplies: string }[]> = {
  apparel: [
    { customerSays: "is this available in large", twinReplies: "Yes, 14 in stock in Large. Want me to hold one for you?" },
    { customerSays: "how long will delivery take", twinReplies: "Confirmed before 2pm and it ships today, so you would have it in 2 to 3 days." },
    { customerSays: "can I get a discount on 200 units", twinReplies: "At 200 units I can do tiered pricing. Let me confirm the exact rate and come back to you." },
  ],
  auto_parts: [
    { customerSays: "will this fit a 2021 swift", twinReplies: "Yes, that fits Swift 2018-24. OEM and aftermarket are both in stock." },
    { customerSays: "whats the difference between oem and aftermarket", twinReplies: "OEM is the manufacturer part with their warranty. Aftermarket is cheaper with a 6 to 12 month warranty." },
    { customerSays: "do you have it in stock", twinReplies: "22 in stock. Dispatches today if you confirm before cut-off." },
  ],
  marine: [
    { customerSays: "is the cruiser still available", twinReplies: "Two are available, one new and one brokerage. Would you like the survey history?" },
    { customerSays: "can I see it this weekend", twinReplies: "I can arrange a viewing. Which day suits you?" },
    { customerSays: "would the owner take an offer", twinReplies: "I can put an offer to the owner. Nothing is agreed until they sign off." },
  ],
  wholesale: [
    { customerSays: "price for 500 kg", twinReplies: "At 500 units you are on the second tier. Let me confirm the rate and send a quote." },
    { customerSays: "can we do net 30", twinReplies: "Net 30 applies once the account is in good standing. First orders are prepaid." },
    { customerSays: "how fresh is the stock", twinReplies: "Everything ships with at least two thirds of its shelf life remaining." },
  ],
};

export async function provisionKnowledge(tx: Tx, workspaceId: string, vertical: Vertical) {
  await tx.knowledgeEntry.createMany({ data: KNOWLEDGE[vertical].map((k) => ({ workspaceId, ...k })) });
  await tx.voiceExample.createMany({ data: EXAMPLES[vertical].map((e) => ({ workspaceId, ...e })) });
}

export async function provisionCatalogue(tx: Tx, workspaceId: string, vertical: Vertical) {
  const catalogue = catalogueFor(vertical);

  const supplierIds = new Map<string, string>();
  for (const s of catalogue.suppliers) {
    const created = await tx.supplier.create({ data: { id: id("sup"), workspaceId, ...s } });
    supplierIds.set(s.name, created.id);
  }

  const products: { id: string; name: string; priceInr: number; optionA: string; optionB: string }[] = [];

  for (const p of catalogue.products) {
    // stock is indexed [optionB][optionA], matching the catalogue's own layout.
    // L-1(d) fix: sku stored once here rather than rebuilt on read.
    const variants = p.optionsB.flatMap((optionB, bi) =>
      p.optionsA.map((optionA, ai) => ({
        optionA,
        optionB,
        stock: p.stock[bi]?.[ai] ?? 0,
        reserved: 0,
        sku: generateSku(p.name, optionA, optionB),
      })),
    );

    const created = await tx.product.create({
      data: {
        id: id("prd"), workspaceId, name: p.name, category: p.category,
        axes: p.axes, attributes: p.attributes, price: toPaise(p.priceInr),
        marginPct: p.marginPct, leadTimeDays: p.leadTimeDays, crossSell: [],
        supplierId: supplierIds.get(p.supplier)!,
        variants: { create: variants },
      },
    });

    products.push({
      id: created.id, name: p.name, priceInr: p.priceInr,
      optionA: p.optionsA[0]!, optionB: p.optionsB[0]!,
    });
  }

  return { supplierIds, products };
}

const DEMO_CUSTOMERS: { name: string; handle: string; channel: Channel; segment: "Retail" | "Wholesale" | "Corporate" }[] = [
  { name: "Priya Nair", handle: "+91 98 ··· 4410", channel: "whatsapp", segment: "Wholesale" },
  { name: "Arjun Style Co.", handle: "@arjun.styles", channel: "instagram", segment: "Retail" },
  { name: "XYZ Uniforms Co.", handle: "ops@xyzuniforms.in", channel: "email", segment: "Corporate" },
  { name: "Rahul Menon", handle: "@rahulm", channel: "telegram", segment: "Retail" },
  { name: "Meera Textiles", handle: "+91 74 ··· 2093", channel: "whatsapp", segment: "Wholesale" },
  { name: "Kavya S.", handle: "kavya@studio.co", channel: "webchat", segment: "Retail" },
];

/** Demo history built from the workspace's own catalogue, never from a fixture. */
export async function provisionHistory(
  tx: Tx,
  workspaceId: string,
  products: { id: string; name: string; priceInr: number; optionA: string; optionB: string }[],
  now = new Date(),
) {
  if (!products.length) return;

  const customers: { id: string; name: string; channel: Channel }[] = [];
  for (const [i, c] of DEMO_CUSTOMERS.entries()) {
    const orders = 4 + i * 5;
    const avg = 3600 + i * 2400;
    const created = await tx.customer.create({
      data: {
        id: id("cus"), workspaceId, name: c.name, handle: c.handle, channel: c.channel,
        segment: c.segment, lifetimeValue: toPaise(orders * avg), orderCount: orders,
        avgOrderValue: toPaise(avg), returnRatePct: [4.1, 11.2, 1.4, 22.5, 2.8, 0][i] ?? 3,
        priceSensitivity: i % 3 === 0 ? "Medium" : i % 3 === 1 ? "High" : "Low",
        negotiationStyle: ["Bundle-seeking", "Discount-led", "Terms-focused", "Exchange-prone", "Volume-driven", "Direct"][i]!,
        sizeProfile: [], predictedNext: products[i % products.length]!.name,
        riskScore: [12, 38, 6, 54, 15, 9][i] ?? 20,
        lastSeenAt: new Date(now.getTime() - i * 3_600_000),
      },
    });
    customers.push({ id: created.id, name: c.name, channel: c.channel });
  }

  const stages = ["Quoted", "Paid", "Packed", "Shipped", "Delivered", "Returned"] as const;
  const orderIds: string[] = [];

  for (const [i, customer] of customers.entries()) {
    const product = products[i % products.length]!;
    const qty = 1 + ((i * 3) % 6);
    const variant = await tx.variant.findFirstOrThrow({
      where: { productId: product.id, optionA: product.optionA, optionB: product.optionB },
    });
    const created = await tx.order.create({
      data: {
        id: id("ord"), workspaceId, variant: `${product.optionA} / ${product.optionB}`,
        qty, value: toPaise(product.priceInr * qty), stage: stages[i % stages.length]!,
        channel: customer.channel, createdAt: new Date(now.getTime() - i * 86_400_000),
        customerId: customer.id, productId: product.id, variantId: variant.id,
      },
    });
    orderIds.push(created.id);
  }

  // A fortnight of conversation history, so the volume chart and intent mix
  // have real rows to count rather than a single point. Deterministic rather
  // than random: a demo that reshuffles on every reseed is hard to talk about.
  const INTENTS = ["buy", "inventory_request", "quote_request", "support", "return", "purchase_order", "complaint"] as const;
  const CHANNELS: Channel[] = ["whatsapp", "instagram", "telegram", "email", "webchat"];
  const WEIGHTS = [5, 4, 3, 2, 2, 3, 4, 5, 6, 4, 5, 6, 7, 8];

  let seq = 0;

  for (const [dayOffset, perDay] of WEIGHTS.entries()) {
    const dayStart = new Date(now.getTime() - (13 - dayOffset) * 86_400_000);
    for (let n = 0; n < perDay; n++) {
      const customer = customers[seq % customers.length]!;
      const product = products[seq % products.length]!;
      const intent = INTENTS[seq % INTENTS.length]!;
      const channel = CHANNELS[seq % CHANNELS.length]!;
      const at = new Date(dayStart.getTime() + (9 + (n % 8)) * 3_600_000);

      await tx.conversation.create({
        data: {
          id: id("cnv"), workspaceId, channel,
          subject: `${product.name} · ${intent.replace("_", " ")}`,
          unread: false, lastAt: at, intent,
          signals: [{ label: `intent: ${intent}`, tone: "violet" }],
          customerId: customer.id,
          messages: {
            create: [
              { from: "customer", text: `About the ${product.name}.`, sentAt: at },
              { from: "agent", text: "Looked that up for you.", sentAt: new Date(at.getTime() + 30_000) },
            ],
          },
        },
      });

      await tx.twinEvent.create({
        data: {
          id: id("evt"), workspaceId, occurredAt: at, type: "message.received",
          twin: "conversation", payload: `channel=${channel} intent=${intent}`,
        },
      });

      seq++;
    }
  }

  const first = customers[0]!;
  const product = products[0]!;
  const conversation = await tx.conversation.create({
    data: {
      id: id("cnv"), workspaceId, channel: first.channel,
      subject: `Asking about ${product.name}`, unread: true, lastAt: now,
      intent: "inventory_request",
      signals: [
        { label: "intent: inventory_request", tone: "violet" },
        { label: `product: ${product.name.toLowerCase()}`, tone: "neutral" },
      ],
      customerId: first.id,
      messages: {
        create: [
          { from: "customer", text: `Do you have the ${product.name} in ${product.optionA}?`, sentAt: new Date(now.getTime() - 60_000) },
          { from: "agent", text: `Yes, ${product.optionA} in ${product.optionB} is in stock. Want me to hold one?`, sentAt: now },
        ],
      },
    },
  });

  const run = await tx.agentRun.create({
    data: {
      id: id("run"), workspaceId, agent: "Inventory",
      action: `Checked availability of ${product.name}`, status: "done",
      durationMs: 340, ranAt: now, conversationId: conversation.id,
    },
  });

  const held = await tx.agentRun.create({
    data: {
      id: id("run"), workspaceId, agent: "Sales",
      action: `Drafted a quote for ${product.name}`, status: "needs_approval",
      durationMs: 1800, ranAt: now, conversationId: conversation.id,
    },
  });

  await tx.approval.create({
    data: {
      id: id("apr"), workspaceId, agent: "Sales", summary: `Quote for ${product.name}`,
      detail: `${product.optionA} / ${product.optionB} at ₹${product.priceInr.toLocaleString("en-IN")}`,
      impact: "Awaiting your price confirmation", raisedAt: now, severity: "attention", runId: held.id,
    },
  });

  await tx.twinEvent.createMany({
    data: [
      { id: id("evt"), workspaceId, occurredAt: new Date(now.getTime() - 60_000), type: "message.received", twin: "conversation", payload: `channel=${first.channel} conversation=${conversation.id}` },
      { id: id("evt"), workspaceId, occurredAt: new Date(now.getTime() - 59_000), type: "intent.extracted", twin: "conversation", payload: "intent=inventory_request via=rules" },
      { id: id("evt"), workspaceId, occurredAt: new Date(now.getTime() - 58_000), type: "product_twin.matched", twin: "product", payload: `${product.id} variant=${product.optionA}/${product.optionB}` },
      { id: id("evt"), workspaceId, occurredAt: now, type: "agent.dispatched", twin: "conversation", payload: `sales -> needs_approval run=${run.id}` },
    ],
  });

  // Invoices against the settled end of the order list, so ageing has something to show.
  const invoiceable = orderIds.slice(0, 4);
  for (const [i, orderId] of invoiceable.entries()) {
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
    const number = `INV-${4400 + i}-${workspaceId.slice(-4)}`;
    await tx.invoice.create({
      data: {
        number, workspaceId, source: (["zoho", "manual", "quickbooks"] as const)[i % 3]!,
        issuedOn: new Date(now.getTime() - (30 - i * 7) * 86_400_000),
        dueOn: new Date(now.getTime() - (16 - i * 7) * 86_400_000),
        amount: order.value, customerId: order.customerId, orderId: order.id,
      },
    });

    // Two of the four are partly or fully paid, so the ageing buckets are not all one colour.
    if (i % 2 === 0) {
      await tx.payment.create({
        data: {
          id: id("pay"), workspaceId, receivedAt: new Date(now.getTime() - (10 - i) * 86_400_000),
          method: "bank_transfer", reference: `TXN-${70000 + i}`, loggedBy: "Sam",
          amount: i === 0 ? order.value : Math.round(order.value / 2),
          invoiceNumber: number, customerId: order.customerId,
        },
      });
    }
  }
}
