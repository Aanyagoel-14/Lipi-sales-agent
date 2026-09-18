import { randomUUID } from "node:crypto";
import { toRupees } from "../lib/money";
import { prisma } from "../lib/prisma";
import { extract, vocabularyFor, type ExtractionResult } from "./extract";
import { scoreLead, type LeadStage } from "./leads";
import { composeReply, DEFAULT_VOICE, findKnowledge, voiceViolations, type ReplyParts } from "./voice";
import type { Channel } from "@/generated/prisma/client";

/**
 * The ingest loop.
 *
 * A message arrives on any channel and this is what happens to it:
 *
 *   normalise -> extract intent -> resolve the customer twin -> match the
 *   product twin -> apply effects to inventory and orders -> append an event
 *   for every mutation -> dispatch agents -> ground a reply in twin state
 *
 * Everything runs in one transaction. A message either changes all of the
 * twins it should, or none of them: a reservation without its order, or an
 * order without its event, would leave the twins lying about the business.
 */

/** Units at or below which the inventory twin asks procurement to restock. */
const REORDER_POINT = 6;

const id = (prefix: string) => `${prefix}_${randomUUID().slice(0, 8)}`;

export type IngestInput = {
  workspaceId: string;
  channel: Channel;
  handle: string;
  text: string;
  name?: string;
};

export type IngestResult = {
  conversationId: string;
  customer: { id: string; name: string; isNew: boolean };
  extracted: ExtractionResult;
  matched: { product: string; variant: string } | null;
  order: { id: string; valueInr: number } | null;
  reply: string;
  replySent: boolean;
  voiceViolations: string[];
  knowledgeUsed: { title: string; kind: string } | null;
  agentRuns: { agent: string; action: string; status: "needs_approval" | "done" }[];
  events: Effect[];
};

class DryRunComplete extends Error {
  constructor(readonly result: IngestResult) { super("Dry run complete"); }
}

/** Which agent actions the workspace lets out without a human. */
function needsApproval(policy: "everything" | "money_only" | "nothing", touchesMoney: boolean) {
  if (policy === "everything") return true;
  if (policy === "nothing") return false;
  return touchesMoney;
}

/** The transactional client Prisma hands to $transaction. */
type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

type Effect = { type: string; twin: string; payload: string };

export async function ingest(input: IngestInput, options: { dryRun?: boolean } = {}): Promise<IngestResult> {
  const now = new Date();

  const workspace = await prisma.workspace.findUnique({
    where: { id: input.workspaceId },
    include: { voice: true, knowledge: true },
  });
  if (!workspace) throw new Error(`Unknown workspace ${input.workspaceId}`);

  const voice = workspace.voice ?? DEFAULT_VOICE;
  // Built from what this workspace actually stocks, not just its trade's demo
  // catalogue, so hand-added products are findable.
  const live = await prisma.product.findMany({
    where: { workspaceId: workspace.id },
    select: { name: true, category: true, axes: true, variants: { select: { optionA: true, optionB: true } } },
  });

  const vocab = vocabularyFor(workspace.vertical, {
    categories: [...new Set(live.map((p) => p.category))],
    optionsA: [...new Set(live.flatMap((p) => p.variants.map((v) => v.optionA)))],
    optionsB: [...new Set(live.flatMap((p) => p.variants.map((v) => v.optionB)))],
    axes: (live[0]?.axes as [string, string]) ?? undefined,
  });
  const extracted = await extract(input.text, vocab, now);

  try {
    return await prisma.$transaction(async (tx) => {
    const effects: Effect[] = [];
    const record = (type: string, twin: string, payload: string) => effects.push({ type, twin, payload });

    /* ---------------------------------------------------- customer twin */
    let customer = await tx.customer.findFirst({ where: { handle: input.handle, workspaceId: workspace.id } });
    const isNew = !customer;

    if (!customer) {
      customer = await tx.customer.create({
        data: {
          id: id("cus"), workspaceId: workspace.id, name: input.name ?? input.handle, handle: input.handle,
          channel: input.channel, segment: "Retail", lifetimeValue: 0, orderCount: 0,
          avgOrderValue: 0, returnRatePct: 0, priceSensitivity: "Medium",
          negotiationStyle: "Unknown", sizeProfile: [], predictedNext: "Unknown",
          riskScore: 20, lastSeenAt: now,
        },
      });
      record("customer_twin.created", "customer", `${customer.id} channel=${input.channel}`);
    }

    // A stated size is a fact about the customer, not just about this message.
    const learned = extracted.optionA ? `${vocab.axes[0].toLowerCase()}: ${extracted.optionA}` : null;
    const sizeProfile =
      learned && !customer.sizeProfile.includes(learned)
        ? [...customer.sizeProfile, learned]
        : customer.sizeProfile;

    // Volume is what separates a retail buyer from a wholesale one.
    const segment =
      extracted.quantity && extracted.quantity >= 50 ? "Wholesale"
      : extracted.intent === "purchase_order" ? "Corporate"
      : customer.segment;

    // L-1(b) fix: the length comparison below needs the size profile as it
    // stood BEFORE this message's update, but `customer` is reassigned to
    // the updated row immediately after this. Captured here, before the
    // reassignment, so the comparison is not comparing the new array against
    // itself (which made it always false and left only the `|| learned`
    // clause doing anything).
    const previousSizeProfileLength = customer.sizeProfile.length;
    const segmentChanged = segment !== customer.segment;

    customer = await tx.customer.update({
      where: { id: customer.id },
      data: { lastSeenAt: now, sizeProfile, segment },
    });

    if (sizeProfile.length !== previousSizeProfileLength || segmentChanged || learned) {
      record("customer_twin.updated", "customer", `${customer.id} size_profile=[${sizeProfile.join(", ")}] segment=${segment}`);
    }

    /* ------------------------------------------------------ conversation */
    const conversation = await tx.conversation.create({
      data: {
        id: id("cnv"), workspaceId: workspace.id, channel: input.channel, subject: input.text.slice(0, 80),
        unread: true, lastAt: now, intent: extracted.intent,
        signals: signalsFor(extracted, vocab.axes),
        customerId: customer.id,
        messages: { create: { from: "customer", text: input.text, sentAt: now } },
      },
    });
    record("message.received", "conversation", `channel=${input.channel} conversation=${conversation.id}`);
    record(
      "intent.extracted",
      "conversation",
      `intent=${extracted.intent}` +
        (extracted.quantity ? ` qty=${extracted.quantity}` : "") +
        (extracted.optionA ? ` ${vocab.axes[0].toLowerCase()}=${extracted.optionA}` : "") +
        (extracted.optionB ? ` ${vocab.axes[1].toLowerCase()}=${extracted.optionB}` : "") +
        (extracted.deadline ? ` deadline=${extracted.deadline}` : "") +
        ` via=${extracted.extractor}`,
    );

    /* ----------------------------------------------------- product match */
    const match = await matchVariant(tx, extracted, workspace.id, input.text);
    if (match) {
      record(
        "product_twin.matched",
        "product",
        `${match.product.id} variant=${match.variant.optionA}/${match.variant.optionB}`,
      );
    }

    /* ---------------------------------------------------------- effects */
    // `mandatory` overrides the workspace's approval policy: a purchase order
    // is a commercial commitment on the customer's own terms (net-30, a PO
    // number), not a self-serve retail buy, so it always needs a human's eyes
    // even under a policy of "nothing".
    const runs: { agent: string; action: string; touchesMoney: boolean; ms: number; mandatory?: boolean }[] = [];
    let order: { id: string; valueInr: number } | null = null;
    let parts: ReplyParts;

    const wants = extracted.quantity ?? 1;
    const knowledge = findKnowledge(input.text, extracted.intent, workspace.knowledge);

    if (extracted.intent === "buy" && match && match.precise) {
      const available = match.variant.stock - match.variant.reserved;

      if (available >= wants) {
        await tx.variant.update({ where: { id: match.variant.id }, data: { reserved: { increment: wants } } });
        const remaining = available - wants;
        record("inventory_twin.reserved", "inventory", `sku=${match.sku} qty=${wants} remaining=${remaining}`);

        const created = await tx.order.create({
          data: {
            id: id("ord"), workspaceId: workspace.id, variant: `${match.variant.optionA} / ${match.variant.optionB}`,
            qty: wants, value: match.product.price * wants, stage: "Quoted",
            channel: input.channel, createdAt: now, customerId: customer.id,
            productId: match.product.id, variantId: match.variant.id,
            blocked: extracted.deadline ? `Deliver by ${extracted.deadline}` : null,
          },
        });
        order = { id: created.id, valueInr: toRupees(created.value) };
        record("order_twin.created", "order", `${created.id} status=quoted value=${toRupees(created.value)}`);

        runs.push({ agent: "Sales", action: `Quoted ${wants} × ${match.product.name} ${match.variant.optionA} ${match.variant.optionB}, reserved stock`, touchesMoney: true, ms: 1200 });
        runs.push({ agent: "Inventory", action: `Reserved ${wants} units, ${remaining} left unreserved`, touchesMoney: false, ms: 380 });

        if (remaining <= REORDER_POINT) {
          record("inventory_twin.threshold_breached", "inventory", `sku=${match.sku} reorder_point=${REORDER_POINT}`);
          runs.push({ agent: "Procurement", action: `Draft restock of ${match.product.name} ${match.variant.optionA} ${match.variant.optionB}`, touchesMoney: true, ms: 2100 });
        }

        parts = {
          core: `Reserved ${wants} × ${match.product.name}, ${match.variant.optionA} / ${match.variant.optionB}.`,
          detail: `₹${toRupees(match.product.price).toLocaleString("en-IN")} each, ₹${order.valueInr.toLocaleString("en-IN")} total.`,
          question: "Want the invoice?",
        };
      } else {
        record("inventory_twin.shortfall", "inventory", `sku=${match.sku} requested=${wants} available=${available}`);
        runs.push({ agent: "Procurement", action: `Shortfall of ${wants - available} on ${match.product.name} ${match.variant.optionA} ${match.variant.optionB}`, touchesMoney: true, ms: 1800 });

        parts = available > 0
          ? { core: `I have ${available} of those, not ${wants}.`, detail: `Lead time on the rest is ${match.product.leadTimeDays} days.`, question: `Want me to hold the ${available} and order the rest?` }
          : { core: "That variant is out of stock.", detail: `Lead time is ${match.product.leadTimeDays} days.`, question: "Shall I put it on order?" };
      }
    } else if (extracted.intent === "purchase_order" && match && match.precise) {
      // C-1 fix: a purchase order is the highest-value message type this twin
      // receives ("PO for 5 olive L polos, net 30") and previously fell
      // through every branch below, discarding the order entirely. It is
      // handled like a precise buy — the same stock check, the same
      // reservation, the same order row — but every agent run raised from it
      // is forced to `needs_approval` regardless of the workspace's approval
      // policy, because a PO is the customer's own commercial terms, not a
      // self-serve retail purchase, and a human should confirm the terms
      // (net-30, delivery date) before it is treated as committed.
      const available = match.variant.stock - match.variant.reserved;

      if (available >= wants) {
        await tx.variant.update({ where: { id: match.variant.id }, data: { reserved: { increment: wants } } });
        const remaining = available - wants;
        record("inventory_twin.reserved", "inventory", `sku=${match.sku} qty=${wants} remaining=${remaining} via=purchase_order`);

        const created = await tx.order.create({
          data: {
            id: id("ord"), workspaceId: workspace.id, variant: `${match.variant.optionA} / ${match.variant.optionB}`,
            qty: wants, value: match.product.price * wants, stage: "Quoted",
            channel: input.channel, createdAt: now, customerId: customer.id,
            productId: match.product.id, variantId: match.variant.id,
            blocked: extracted.deadline ? `Deliver by ${extracted.deadline}` : "Purchase order awaiting confirmation",
          },
        });
        order = { id: created.id, valueInr: toRupees(created.value) };
        record("order_twin.created", "order", `${created.id} status=quoted value=${toRupees(created.value)} source=purchase_order`);

        runs.push({
          agent: "Sales",
          action: `Purchase order for ${wants} × ${match.product.name} ${match.variant.optionA} ${match.variant.optionB}, reserved stock pending confirmation`,
          touchesMoney: true, ms: 1200, mandatory: true,
        });
        runs.push({ agent: "Inventory", action: `Reserved ${wants} units against PO, ${remaining} left unreserved`, touchesMoney: false, ms: 380 });

        if (remaining <= REORDER_POINT) {
          record("inventory_twin.threshold_breached", "inventory", `sku=${match.sku} reorder_point=${REORDER_POINT}`);
          runs.push({ agent: "Procurement", action: `Draft restock of ${match.product.name} ${match.variant.optionA} ${match.variant.optionB}`, touchesMoney: true, ms: 2100 });
        }

        parts = {
          core: `Got your PO for ${wants} × ${match.product.name}, ${match.variant.optionA} / ${match.variant.optionB}.`,
          detail: `₹${toRupees(match.product.price).toLocaleString("en-IN")} each, ₹${order.valueInr.toLocaleString("en-IN")} total. Stock is held pending confirmation.`,
          question: "Someone will confirm the order terms shortly. Anything else on the PO?",
        };
      } else {
        record("inventory_twin.shortfall", "inventory", `sku=${match.sku} requested=${wants} available=${available} via=purchase_order`);
        runs.push({
          agent: "Procurement",
          action: `PO shortfall of ${wants - available} on ${match.product.name} ${match.variant.optionA} ${match.variant.optionB}`,
          touchesMoney: true, ms: 1800, mandatory: true,
        });

        parts = available > 0
          ? { core: `I can only cover ${available} of the ${wants} on your PO right now.`, detail: `Lead time on the rest is ${match.product.leadTimeDays} days.`, question: "Shall I hold what I have and put the rest on order?" }
          : { core: "That variant is out of stock for the PO as written.", detail: `Lead time is ${match.product.leadTimeDays} days.`, question: "Shall I put the full quantity on order?" };
      }
    } else if (extracted.intent === "purchase_order" && match) {
      // PO named a product but not a precise variant. Same caution as a buy:
      // reserving a guess would misstate what was actually promised.
      runs.push({ agent: "Sales", action: `Asked which variant to fulfil the PO for ${match.product.name}`, touchesMoney: false, ms: 300, mandatory: true });
      parts = {
        core: `I can raise the PO for ${match.product.name}.`,
        detail: `${match.totalStock} in stock across ${match.variantCount} variants.`,
        question: `Which ${vocab.axes[0].toLowerCase()} and ${vocab.axes[1].toLowerCase()} is the PO for?`,
      };
    } else if (extracted.intent === "purchase_order") {
      // No product matched at all: still a commercial request, so it is
      // routed to a human rather than answered generically and dropped.
      runs.push({ agent: "Sales", action: "Received a purchase order with no product identified", touchesMoney: true, ms: 900, mandatory: true });
      parts = {
        core: "I can raise that purchase order.",
        detail: knowledge?.body,
        question: "Which product, and how many, is the PO for?",
      };
    } else if (extracted.intent === "inventory_request" && match) {
      const available = match.variant.stock - match.variant.reserved;
      const axisNames = `${vocab.axes[0].toLowerCase()} and ${vocab.axes[1].toLowerCase()}`;

      if (!match.precise) {
        runs.push({ agent: "Inventory", action: `Checked ${match.product.name}, ${match.totalStock} across ${match.variantCount} variants`, touchesMoney: false, ms: 320 });
        parts = match.totalStock > 0
          ? {
              core: `Yes, ${match.totalStock} of the ${match.product.name} in stock across ${match.variantCount} variants.`,
              detail: knowledge?.body,
              question: `Which ${axisNames} do you need?`,
            }
          : {
              core: `The ${match.product.name} is out of stock right now.`,
              detail: `Lead time is ${match.product.leadTimeDays} days.`,
              question: "Shall I put you down for it?",
            };
      } else {
        runs.push({ agent: "Inventory", action: `Checked ${match.sku}, ${available} available`, touchesMoney: false, ms: 320 });
        parts = available > 0
          ? { core: `${available} left in ${match.variant.optionA} / ${match.variant.optionB}.`, detail: knowledge?.body, question: "Want me to hold one for 24 hours?" }
          : { core: `None left in ${match.variant.optionA} / ${match.variant.optionB}.`, detail: `I can restock in ${match.product.leadTimeDays} days.`, question: "Shall I put you down for it?" };
      }
    } else if (extracted.intent === "buy" && match) {
      // Product named but not the variant. Reserving a guess would be worse
      // than asking, because the twin would promise the wrong thing.
      runs.push({ agent: "Sales", action: `Asked which variant of ${match.product.name}`, touchesMoney: false, ms: 300 });
      parts = {
        core: `I can do the ${match.product.name}.`,
        detail: `${match.totalStock} in stock across ${match.variantCount} variants.`,
        question: `Which ${vocab.axes[0].toLowerCase()} and ${vocab.axes[1].toLowerCase()}?`,
      };
    } else if (extracted.intent === "return") {
      runs.push({ agent: "Support", action: "Opened a return", touchesMoney: false, ms: 700 });
      parts = { core: "I can start that exchange.", detail: knowledge?.body, question: "Which order is it for?" };
    } else if (extracted.intent === "quote_request") {
      runs.push({ agent: "Sales", action: "Drafted a volume quote", touchesMoney: true, ms: 2400 });
      parts = { core: "I can quote that.", detail: knowledge?.body, question: "How many units are you thinking?" };
    } else if (knowledge) {
      // No product matched, but the workspace has taught the twin this answer.
      runs.push({ agent: "Support", action: `Answered from knowledge: ${knowledge.title}`, touchesMoney: false, ms: 300 });
      record("knowledge.used", "conversation", `entry="${knowledge.title}" kind=${knowledge.kind}`);
      parts = { core: knowledge.body, question: "Anything else?" };
    } else {
      runs.push({ agent: "Support", action: "Triaged an unmatched message", touchesMoney: false, ms: 260 });
      parts = { core: "Got it.", detail: "Let me look into that and come back to you." };
    }

    const reply = composeReply(parts, voice);
    const violations = voiceViolations(reply, voice);
    if (violations.length) {
      record("voice.violation", "conversation", `banned=[${violations.join(", ")}]`);
    }

    /* -------------------------------------------------------- lead score */
    // Req 2: recomputed after every message, inside the same transaction —
    // a lead list is never more than one message stale, and needs no
    // background job of its own. `orderCount` on the customer row is not
    // reliable here (nothing in this loop increments it — see leads.ts's
    // own note), so "has this customer ever ordered" is asked of `Order`
    // directly rather than trusted from a field that may already be stale.
    const priorOrders = await tx.order.count({ where: { customerId: customer.id } });
    const { score: leadScore, stage: leadStage } = scoreLead({
      previousScore: customer.leadScore,
      intent: extracted.intent,
      matchedProduct: Boolean(match),
      quantity: extracted.quantity,
      justOrdered: Boolean(order),
      orderCount: priorOrders,
    });
    if (leadScore !== customer.leadScore || leadStage !== customer.leadStage) {
      customer = await tx.customer.update({
        where: { id: customer.id },
        data: { leadScore, leadStage: leadStage as LeadStage },
      });
      record("lead.scored", "customer", `${customer.id} score=${leadScore} stage=${leadStage}`);
    }

    /* -------------------------------------------------- agents and reply */
    const held = needsApproval(workspace.approvalPolicy, false);

    for (const r of runs) {
      const status = r.mandatory || needsApproval(workspace.approvalPolicy, r.touchesMoney) ? "needs_approval" : "done";

      const run = await tx.agentRun.create({
        data: {
          id: id("run"), workspaceId: workspace.id, agent: r.agent, action: r.action, status,
          durationMs: r.ms, ranAt: now, conversationId: conversation.id,
        },
      });
      record("agent.dispatched", "conversation", `${r.agent.toLowerCase()} -> ${status}`);

      if (status === "needs_approval") {
        await tx.approval.create({
          data: {
            id: id("apr"), workspaceId: workspace.id, agent: r.agent, summary: r.action,
            detail: `Raised from ${conversation.id}`,
            impact: order ? `Order ${order.id}, ₹${order.valueInr.toLocaleString("en-IN")}` : "No order value yet",
            raisedAt: now, severity: "attention", runId: run.id,
          },
        });
      }
    }

    // Under a strict policy the drafted reply is recorded but not sent. It is
    // written either way, and marked `held` when it is: the approval queue
    // releases a message by sending it, and until now the held branch wrote
    // no message at all, so there was nothing for an approval to release.
    // Still one write on either branch, so the transaction is unchanged in
    // shape — only the held path stopped losing the reply it drafted.
    await tx.message.create({
      data: {
        from: "agent", text: reply, sentAt: new Date(now.getTime() + 1000),
        conversationId: conversation.id,
        ...(held ? { deliveryStatus: "held" as const } : {}),
      },
    });
    if (held) record("reply.held", "conversation", "policy=everything awaiting approval");

    /* --------------------------------------------------- the event trail */
    await tx.twinEvent.createMany({
      data: effects.map((e, i) => ({
        id: id("evt"),
        workspaceId: workspace.id,
        occurredAt: new Date(now.getTime() + i),
        type: e.type,
        twin: e.twin,
        payload: e.payload,
      })),
    });

    const result: IngestResult = {
      conversationId: conversation.id,
      customer: { id: customer.id, name: customer.name, isNew },
      extracted,
      matched: match ? { product: match.product.name, variant: `${match.variant.optionA} / ${match.variant.optionB}` } : null,
      order,
      reply,
      replySent: !held,
      voiceViolations: violations,
      knowledgeUsed: knowledge ? { title: knowledge.title, kind: knowledge.kind } : null,
      agentRuns: runs.map((r) => ({
        agent: r.agent,
        action: r.action,
        status: r.mandatory || needsApproval(workspace.approvalPolicy, r.touchesMoney) ? "needs_approval" : "done",
      })),
      events: effects,
    };
    // Evaluation must exercise the same writes and constraints as production,
    // then roll them all back so tests never become customers, orders or KPIs.
    if (options.dryRun) throw new DryRunComplete(result);
    return result;
    });
  } catch (error) {
    if (error instanceof DryRunComplete) return error.result;
    throw error;
  }
}

function signalsFor(e: ExtractionResult, axes: [string, string]) {
  const signals: { label: string; tone: string }[] = [{ label: `intent: ${e.intent}`, tone: "violet" }];
  if (e.quantity) signals.push({ label: `quantity: ${e.quantity}`, tone: "neutral" });

  if (e.optionA) signals.push({ label: `${axes[0].toLowerCase()}: ${e.optionA}`, tone: "neutral" });
  if (e.optionB) signals.push({ label: `${axes[1].toLowerCase()}: ${e.optionB}`, tone: "neutral" });
  if (e.category) signals.push({ label: `category: ${e.category}`, tone: "neutral" });
  if (e.deadline) signals.push({ label: `deadline: ${e.deadline}`, tone: "amber" });
  if (e.priority === "high") signals.push({ label: "priority: high", tone: "magenta" });
  signals.push({ label: `via: ${e.extractor}`, tone: "teal" });
  return signals;
}

async function matchVariant(tx: Tx, e: ExtractionResult, workspaceId: string, text: string) {
  if (!e.category && !e.optionA && !e.optionB && !text.trim()) return null;

  // Do not narrow by category up front: a customer may name the product
  // without using a word the category vocabulary knows.
  //
  // L-1(c), documented rather than fixed here: this loads every product and
  // every variant for the workspace on every single inbound message, inside
  // the ingest transaction. Fine at the seeded scale (a handful of products,
  // tens of variants); at 50,000 variants this is a full-table scan holding
  // a transaction open on every customer message. A real fix needs a
  // narrower pre-filter — e.g. a category/text search pushed into SQL, or a
  // cap with pagination and a "did we search everything" flag on the
  // result — which is a behavioural change to matching, not a pure
  // performance patch, so it is called out here rather than changed
  // unreviewed inside an audit-fix pass.
  const products = await tx.product.findMany({ where: { workspaceId }, include: { variants: true } });
  if (!products.length) return null;

  // Score every variant, so a partial description still resolves to the most
  // plausible one rather than failing outright.
  // Two scores, deliberately. `score` decides *which* product and variant is
  // the best guess; `optionScore` decides whether the customer actually named
  // a variant. Naming the product is not the same as naming the variant, and
  // conflating them makes the twin answer about something never asked for.
  let best: {
    product: (typeof products)[number];
    variant: (typeof products)[number]["variants"][number];
    score: number;
    optionScore: number;
  } | null = null;

  const haystack = text.toLowerCase();
  let nameHitAny = false;

  for (const product of products) {
    // Naming the product outright beats any option match.
    const named = product.name.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    const nameHit = named.length > 0 && named.every((w) => haystack.includes(w));
    if (nameHit) nameHitAny = true;

    for (const variant of product.variants) {
      let optionScore = 0;
      if (e.optionB && variant.optionB.toLowerCase() === e.optionB.toLowerCase()) optionScore += 3;
      if (e.optionA && variant.optionA.toLowerCase() === e.optionA.toLowerCase()) optionScore += 2;

      const score = optionScore + (nameHit ? 4 : 0) + (e.category && product.category === e.category ? 1 : 0);
      if (score > (best?.score ?? 0)) best = { product, variant, score, optionScore };
    }
  }

  if (!best) return null;

  // Precise means the customer named the variant, not merely the product.
  const precise = best.optionScore >= 2;
  if (!precise && !nameHitAny && !e.category) return null;

  const totalStock = best.product.variants.reduce((a, v) => a + (v.stock - v.reserved), 0);

  return {
    product: best.product,
    variant: best.variant,
    precise,
    totalStock,
    variantCount: best.product.variants.length,
    // L-1(d) fix: the variant's own stored SKU, not rebuilt from whatever
    // the product happens to be called right now. A rename no longer
    // changes what gets logged for an in-flight message.
    sku: best.variant.sku,
  };
}
