import { toRupees } from "../lib/money";
import { prisma } from "../lib/prisma";
import { buildRecommendations, type Recommendation } from "./recommend";
import { rankKnowledge } from "./voice";
import type { KnowledgeEntry, Prisma } from "@/generated/prisma/client";

/**
 * The briefing: everything the twin is allowed to know about its own business,
 * rendered as text a model can read.
 *
 * This is the whole reason the chat is worth having. A model without it
 * answers plausibly and wrongly; a model with it answers from the same rows
 * the dashboard shows, so the operator can trust a number without going to
 * check it. Nothing here is invented and nothing is fetched twice: one pass
 * over the twins, capped so a large catalogue cannot blow the context window.
 */

/** Units at or below which a variant is worth flagging to the operator. */
export const LOW_STOCK = 6;

const CAPS = {
  products: 40, variants: 12, orders: 20, customers: 8, knowledge: 20, events: 12,
  /**
   * How many entries the ranking reads before it starts ignoring the oldest.
   * Deliberately far above the ceiling on what the block can carry: relevance
   * has to beat recency, and a store scanned only to its 20 newest rows can
   * never answer a question about the policy written first.
   */
  knowledgeScan: 1000,
  /** Products from the matched product's own category, behind it. */
  neighbours: 6,
};

/**
 * The size ceiling on a grounding block, in characters -- roughly 2000 tokens.
 * A block is assembled per turn and paid for per turn, so a workspace that has
 * taught its twin 500 things must not be charged for all of them to answer one
 * question about returns.
 */
export const GROUNDING_MAX_CHARS = 8000;

const rupees = (amount: number) => `₹${amount.toLocaleString("en-IN")}`;
const inr = (paise: number) => rupees(toRupees(paise));

export type Briefing = {
  text: string;
  /** Headline numbers, returned to the UI so it can show what grounded a reply. */
  facts: {
    products: number;
    unitsAvailable: number;
    lowStock: number;
    openOrders: number;
    pipelineInr: number;
    pendingApprovals: number;
  };
};

export async function buildBriefing(workspaceId: string, now = new Date()): Promise<Briefing> {
  const [workspace, products, orders, customers, approvals, events, conversations] = await Promise.all([
    prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: { voice: true, knowledge: { take: CAPS.knowledge, orderBy: { createdAt: "desc" } } },
    }),
    prisma.product.findMany({
      where: { workspaceId },
      include: { variants: { orderBy: [{ optionA: "asc" }, { optionB: "asc" }] }, supplier: true },
      orderBy: { name: "asc" },
      take: CAPS.products,
    }),
    prisma.order.findMany({
      where: { workspaceId },
      include: { customer: { select: { name: true } }, product: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
    prisma.customer.findMany({ where: { workspaceId }, orderBy: { lifetimeValue: "desc" }, take: CAPS.customers }),
    prisma.approval.findMany({ where: { workspaceId }, orderBy: { raisedAt: "desc" }, take: 10 }),
    prisma.twinEvent.findMany({ where: { workspaceId }, orderBy: { occurredAt: "desc" }, take: CAPS.events }),
    prisma.conversation.count({ where: { workspaceId, unread: true } }),
  ]);

  if (!workspace) throw new Error(`Unknown workspace ${workspaceId}`);

  const lines: string[] = [];
  const axes = (products[0]?.axes as string[] | undefined) ?? ["Option A", "Option B"];

  lines.push(
    `BUSINESS: ${workspace.name} (trade: ${workspace.vertical.replace("_", " ")}).`,
    `Variants are sold by ${axes[0]} and ${axes[1]}.`,
    `Autonomy policy: ${workspace.approvalPolicy}. Unread conversations: ${conversations}.`,
    `Today is ${now.toISOString().slice(0, 10)}. All money is Indian rupees.`,
  );

  /* ------------------------------------------------------------ inventory */
  let unitsAvailable = 0;
  let lowStock = 0;

  lines.push("", "INVENTORY (available = stock minus reserved):");
  if (!products.length) lines.push("- No products yet. The catalogue is empty.");

  for (const product of products) {
    const total = product.variants.reduce((a, v) => a + (v.stock - v.reserved), 0);
    unitsAvailable += total;

    const shown = product.variants.slice(0, CAPS.variants);
    const detail = shown
      .map((v) => {
        const available = v.stock - v.reserved;
        if (available <= LOW_STOCK) lowStock += 1;
        const reserved = v.reserved ? `, ${v.reserved} reserved` : "";
        return `${v.optionA}/${v.optionB}: ${available}${reserved}${available <= LOW_STOCK ? " [LOW]" : ""}`;
      })
      .join("; ");
    const more = product.variants.length > shown.length ? ` (+${product.variants.length - shown.length} more variants)` : "";

    lines.push(
      `- ${product.name} [${product.category}] ${inr(product.price)} each, margin ${product.marginPct}%, ` +
        `lead time ${product.leadTimeDays}d, supplier ${product.supplier.name}. ` +
        `Total available ${total}. Variants — ${detail}${more}`,
    );
  }

  /* --------------------------------------------------------------- orders */
  const byStage = new Map<string, { count: number; value: number }>();
  for (const order of orders) {
    const bucket = byStage.get(order.stage) ?? { count: 0, value: 0 };
    byStage.set(order.stage, { count: bucket.count + 1, value: bucket.value + order.value });
  }

  const OPEN = ["Quoted", "Paid", "Packed", "Shipped"];
  const openOrders = OPEN.reduce((a, s) => a + (byStage.get(s)?.count ?? 0), 0);
  const pipeline = OPEN.reduce((a, s) => a + (byStage.get(s)?.value ?? 0), 0);

  lines.push("", `ORDERS (${orders.length} most recent, ${openOrders} still open worth ${inr(pipeline)}):`);
  for (const [stage, b] of byStage) lines.push(`- ${stage}: ${b.count} orders, ${inr(b.value)}`);

  const blocked = orders.filter((o) => o.blocked);
  if (blocked.length) {
    lines.push(`Blocked or deadlined orders (${blocked.length}):`);
    for (const o of blocked.slice(0, 10)) lines.push(`- ${o.id} ${o.product.name} ${o.variant} — ${o.blocked}`);
  }

  lines.push("Latest orders:");
  for (const o of orders.slice(0, CAPS.orders)) {
    lines.push(
      `- ${o.id} ${o.createdAt.toISOString().slice(0, 10)} ${o.customer.name} — ${o.qty} × ${o.product.name} ` +
        `${o.variant}, ${inr(o.value)}, ${o.stage}, via ${o.channel}`,
    );
  }

  /* ------------------------------------------------------------ customers */
  if (customers.length) {
    lines.push("", "TOP CUSTOMERS by lifetime value:");
    for (const c of customers) {
      lines.push(
        `- ${c.name} (${c.handle}, ${c.channel}) ${c.segment}, ${c.orderCount} orders, ` +
          `lifetime ${inr(c.lifetimeValue)}, returns ${c.returnRatePct}%, risk ${c.riskScore}/100`,
      );
    }
  }

  /* ------------------------------------------------------------ approvals */
  if (approvals.length) {
    lines.push("", `PENDING APPROVALS (${approvals.length}):`);
    for (const a of approvals) lines.push(`- ${a.agent}: ${a.summary} — ${a.impact}`);
  }

  /* ------------------------------------------------------------ knowledge */
  if (workspace.knowledge.length) {
    lines.push("", "POLICIES AND FACTS THE BUSINESS HAS TAUGHT YOU (only these may be asserted as policy):");
    for (const k of workspace.knowledge) lines.push(`- [${k.kind}] ${k.title}: ${k.body}`);
  }

  if (events.length) {
    lines.push("", "RECENT TWIN ACTIVITY:");
    for (const e of events) lines.push(`- ${e.occurredAt.toISOString().slice(11, 16)} ${e.type} ${e.payload}`);
  }

  return {
    text: lines.join("\n"),
    facts: {
      products: products.length,
      unitsAvailable,
      lowStock,
      openOrders,
      pipelineInr: toRupees(pipeline),
      pendingApprovals: approvals.length,
    },
  };
}

/** What the message is about, as far as `ingest()` could tell. */
export type Focus = {
  text: string;
  intent?: string;
  matched?: { product: string; variant: string } | null;
};

export type Grounding = {
  text: string;
  /** The entries that answered this message, most relevant first. */
  knowledge: { title: string; kind: string; score: number }[];
  /** What the system chose to put in front of them, strongest reason first. */
  recommendations: Recommendation[];
};

// No supplier, no margin: the customer is buying the product, not the
// business behind it.
const catalogueSelect = {
  id: true, name: true, category: true, price: true, leadTimeDays: true, crossSell: true, axes: true,
  variants: {
    select: { optionA: true, optionB: true, stock: true, reserved: true },
    orderBy: [{ optionA: "asc" }, { optionB: "asc" }],
  },
} satisfies Prisma.ProductSelect;

type CatalogueProduct = Prisma.ProductGetPayload<{ select: typeof catalogueSelect }>;

const RECOMMEND =
  "WHAT TO PUT IN FRONT OF THEM (the system chose these from stock and this shop's own past orders — " +
  "recommend from this list and nothing else, with these numbers):";
const FOR_SALE = "WHAT IS FOR SALE (these counts are what a customer can buy today):";
const ANSWERS = "POLICY THAT ANSWERS THIS MESSAGE (state these if they ask, and nothing beyond them):";
const MORE_POLICY = "WHAT ELSE YOU MAY TELL THEM ABOUT POLICY (nothing beyond this):";
const ALL_POLICY = "WHAT YOU MAY TELL THEM ABOUT POLICY (nothing beyond this):";
/**
 * Said only when it is true, and without a count: the catalogue is read one
 * page at a time, so how many products are missing is not a number this block
 * can state honestly. What matters is that the model stops treating the list
 * as exhaustive and telling a customer no.
 */
const PARTIAL = "- (This is not the whole catalogue. If they ask for something that is not listed, offer to check rather than saying you do not have it.)";

/**
 * What to say when the answer is no. An empty shelf is a fact like any other,
 * and a model left to fill the silence fills it with a product that does not
 * exist.
 */
const nothingLikeIt = (soldOut: { product: string; variant: string }) =>
  `- ${soldOut.product} ${soldOut.variant} is sold out, and nothing else in stock replaces it. ` +
  `Say so plainly. Do not offer a substitute.`;

/**
 * Everything the block spends on scaffolding rather than facts, reserved
 * before the facts are chosen so a section's own heading cannot be what
 * pushes the block over its ceiling. Over-reserved on purpose: `MORE_POLICY`
 * and `ALL_POLICY` are alternatives, and the sold-out sentence only appears
 * when the recommendation list carries no alternative.
 */
const SCAFFOLDING = [
  FOR_SALE, RECOMMEND, ANSWERS, MORE_POLICY, ALL_POLICY, PARTIAL,
  // Reserved at a generous product and variant name, so the sentence that
  // admits the shelf is empty is never the line that does not fit.
  nothingLikeIt({ product: "".padEnd(60), variant: "".padEnd(30) }),
  "", "", "", "",
];

const size = (lines: string[]) => lines.reduce((a, line) => a + line.length + 1, 0);

/** One candidate, with the price and count that were read from its own rows. */
const recommendationLines = (r: Recommendation) => [
  `- ${r.why}: ${r.product}${r.variant ? ` in ${r.variant}` : ""} — ${rupees(r.priceInr)} each, ${r.available} available.`,
];


/** One taught policy, as the block states it. */
const knowledgeLines = (entry: KnowledgeEntry) => [`- ${entry.title}: ${entry.body}`];

/** One product, priced and counted from its own rows. */
function productLines(product: CatalogueProduct): string[] {
  // Availability only. How much is reserved, and who for, is none of a
  // customer's business -- that is what leaked an order id into a reply.
  const inStock = product.variants
    .map((v) => ({ label: `${v.optionA} / ${v.optionB}`, available: v.stock - v.reserved }))
    .filter((v) => v.available > 0);

  const soldOut = product.variants
    .filter((v) => v.stock - v.reserved <= 0)
    .map((v) => `${v.optionA} / ${v.optionB}`);

  const total = inStock.reduce((a, v) => a + v.available, 0);

  const lines = [
    `- ${product.name} (${product.category}) — ${inr(product.price)} each, ${total} available, ` +
      `${product.leadTimeDays} day lead time if ordered in.`,
  ];
  if (inStock.length) {
    lines.push(`  In stock: ${inStock.slice(0, CAPS.variants).map((v) => `${v.label} (${v.available})`).join(", ")}`);
  }
  if (soldOut.length) lines.push(`  Sold out: ${soldOut.slice(0, CAPS.variants).join(", ")}`);
  if (product.crossSell.length) lines.push(`  Goes well with: ${product.crossSell.join(", ")}`);
  return lines;
}

/** Words worth matching on: short ones match everything and mean nothing. */
const termsOf = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3);

/**
 * How much this product has to do with what was said. Matched either way
 * round, so "polos" finds "Polo Classic" and "polo" finds "polos".
 */
function mentions(words: string[], product: CatalogueProduct): number {
  const terms = termsOf(`${product.name} ${product.category}`);
  return words.filter((word) => terms.some((term) => term.includes(word) || word.includes(term))).length;
}

/** A to Z, so the tie-break between equally relevant products is its own, not the database's. */
function byName(a: CatalogueProduct, b: CatalogueProduct): number {
  if (a.name === b.name) return 0;
  return a.name < b.name ? -1 : 1;
}

/**
 * The catalogue, most relevant first: the product `ingest()` matched, then the
 * rest of its category, then whatever the message named, then the rest A to Z.
 *
 * The matched product and its neighbours are fetched by name and category
 * rather than filtered out of the A-to-Z page, which would miss them entirely
 * in a catalogue larger than that page.
 */
async function byRelevance(
  workspaceId: string,
  catalogue: CatalogueProduct[],
  focus: Focus,
): Promise<CatalogueProduct[]> {
  const matched = focus.matched
    ? await prisma.product.findFirst({ where: { workspaceId, name: focus.matched.product }, select: catalogueSelect })
    : null;

  const neighbours = matched
    ? await prisma.product.findMany({
        where: { workspaceId, category: matched.category, id: { not: matched.id } },
        select: catalogueSelect,
        orderBy: { name: "asc" },
        take: CAPS.neighbours,
      })
    : [];

  const words = termsOf(focus.text);
  const named = new Map(catalogue.map((p) => [p.id, mentions(words, p)]));
  const mentioned = (product: CatalogueProduct) => named.get(product.id) ?? 0;
  const rest = [...catalogue].sort((a, b) => mentioned(b) - mentioned(a) || byName(a, b));

  const ordered: CatalogueProduct[] = [];
  const seen = new Set<string>();
  for (const product of [...(matched ? [matched] : []), ...neighbours, ...rest]) {
    if (seen.has(product.id)) continue;
    seen.add(product.id);
    ordered.push(product);
  }
  return ordered;
}

/**
 * The grounding block: what a customer is allowed to know, narrowed to what
 * this message is about.
 *
 * A separate function from `buildBriefing`, not a flag on it, because the
 * difference is not cosmetic and a boolean is too easy to get backwards. The
 * operator briefing contains other customers' names and lifetime values, every
 * recent order and what it was worth, pending approvals, margins, supplier
 * names and reservation internals. None of that may reach someone shopping,
 * and the safe way to guarantee that is to never load it.
 *
 * What survives: what is for sale, how much of it there is, what it costs, how
 * long it takes, and the policies the business has chosen to publish. Every
 * price and count is read here, from the twins, and handed to the model as a
 * fact -- the model is never in a position to compute one (invariant 2).
 *
 * Three things make it grounding rather than a dump:
 *
 *  - the policies that answer *this* message are ranked out of the whole
 *    store and stated first, so two questions in one message get two answers;
 *  - the catalogue is ordered by relevance -- the matched product, then its
 *    category, then whatever the message names -- so the thing being asked
 *    about is not the fortieth line;
 *  - it is bounded. A workspace with 500 entries would otherwise carry them
 *    all into every turn, at the operator's expense and past the point the
 *    model can read them.
 */
export async function buildGrounding(workspaceId: string, focus: Focus): Promise<Grounding> {
  const [workspace, catalogue, entries, recommended] = await Promise.all([
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } }),
    prisma.product.findMany({
      where: { workspaceId },
      select: catalogueSelect,
      orderBy: { name: "asc" },
      take: CAPS.products,
    }),
    // Ordered, and capped, so the ranking below sees the same rows in the same
    // order on every call: an unordered `findMany` is free to hand Postgres's
    // rows back in whatever order the last write left them.
    prisma.knowledgeEntry.findMany({
      where: { workspaceId },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: CAPS.knowledgeScan,
    }),
    // Deterministic candidate generation: what is worth offering is decided
    // from stock and order history here, so the model has products to choose
    // words for rather than products to choose (invariant 2).
    buildRecommendations(workspaceId, focus),
  ]);

  if (!workspace) throw new Error(`Unknown workspace ${workspaceId}`);

  const ranked = rankKnowledge(focus.text, focus.intent ?? "other", entries);
  const products = await byRelevance(workspaceId, catalogue, focus);

  /* --------------------------------------------------------------- budget */
  // Priority, highest first: the policies that answer this message, what the
  // system chose to put in front of them, the catalogue in relevance order,
  // then general policy with whatever room is left. A recommendation outranks
  // the catalogue because it is the catalogue already narrowed to the few rows
  // worth saying out loud. Nothing is truncated mid-fact -- half a price is
  // worse than no price -- so an item either fits whole or is dropped, and
  // because each list is already in relevance order, dropping from the end drops the
  // lowest-ranked first.
  const axes = (products[0]?.axes as string[] | undefined) ?? ["Option A", "Option B"];
  const header = [`You work at ${workspace.name}.`, `Everything is sold by ${axes[0]} and ${axes[1]}.`];

  let left = GROUNDING_MAX_CHARS - size(header) - size(SCAFFOLDING);
  /** Renders items until the next one would not fit, and spends what it kept. */
  const take = <T>(items: T[], render: (item: T) => string[]) => {
    const kept: T[] = [];
    const lines: string[] = [];
    for (const item of items) {
      const rendered = render(item);
      const cost = size(rendered);
      if (cost > left) break;
      left -= cost;
      kept.push(item);
      lines.push(...rendered);
    }
    return { kept, lines };
  };

  const answering = take(ranked, (r) => knowledgeLines(r.entry));
  const offers = take(recommended.items, recommendationLines);
  const shown = take(products, productLines);
  const answered = new Set(answering.kept.map((r) => r.entry.id));
  const general = take(entries.filter((e) => !answered.has(e.id)).slice(0, CAPS.knowledge), knowledgeLines);

  /* ---------------------------------------------------------------- block */
  const lines = [...header, "", FOR_SALE];

  if (!catalogue.length) lines.push("- Nothing is listed yet.");
  lines.push(...shown.lines);
  // Either the budget cut the tail, or the catalogue is bigger than one page.
  if (shown.kept.length < products.length || catalogue.length === CAPS.products) lines.push(PARTIAL);

  if (offers.kept.length || recommended.soldOut) {
    lines.push("", RECOMMEND);
    if (offers.kept.length) lines.push(...offers.lines);
    if (recommended.soldOut && !offers.kept.some((i) => i.kind === "alternative")) {
      lines.push(nothingLikeIt(recommended.soldOut));
    }
  }

  if (answering.kept.length) lines.push("", ANSWERS, ...answering.lines);
  if (general.kept.length) lines.push("", answering.kept.length ? MORE_POLICY : ALL_POLICY, ...general.lines);

  return {
    text: lines.join("\n"),
    knowledge: answering.kept.map(({ entry, score }) => ({ title: entry.title, kind: entry.kind, score })),
    recommendations: offers.kept,
  };
}
