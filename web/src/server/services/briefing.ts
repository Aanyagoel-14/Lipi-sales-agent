import { toRupees } from "../lib/money";
import { prisma } from "../lib/prisma";

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

const CAPS = { products: 40, variants: 12, orders: 20, customers: 8, knowledge: 20, events: 12 };

const inr = (paise: number) => `₹${toRupees(paise).toLocaleString("en-IN")}`;

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

/**
 * The catalogue as a customer is allowed to see it.
 *
 * A separate function rather than a flag on `buildBriefing`, because the
 * difference is not cosmetic and a boolean is too easy to get backwards. The
 * operator briefing contains other customers' names and lifetime values, every
 * recent order and what it was worth, pending approvals, margins, supplier
 * names and reservation internals. None of that may reach someone shopping,
 * and the safe way to guarantee that is to never load it.
 *
 * What survives: what is for sale, how much of it there is, what it costs, how
 * long it takes, and the policies the business has chosen to publish.
 */
export async function buildCustomerCatalogue(workspaceId: string): Promise<string> {
  const [workspace, products] = await Promise.all([
    prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: { knowledge: { take: CAPS.knowledge, orderBy: { createdAt: "desc" } } },
    }),
    prisma.product.findMany({
      where: { workspaceId },
      // No supplier, no margin: the customer is buying the product, not the
      // business behind it.
      select: {
        name: true, category: true, price: true, leadTimeDays: true, crossSell: true, axes: true,
        variants: { select: { optionA: true, optionB: true, stock: true, reserved: true }, orderBy: [{ optionA: "asc" }, { optionB: "asc" }] },
      },
      orderBy: { name: "asc" },
      take: CAPS.products,
    }),
  ]);

  if (!workspace) throw new Error(`Unknown workspace ${workspaceId}`);

  const axes = (products[0]?.axes as string[] | undefined) ?? ["Option A", "Option B"];
  const lines = [
    `You work at ${workspace.name}.`,
    `Everything is sold by ${axes[0]} and ${axes[1]}.`,
    "",
    "WHAT IS FOR SALE (these counts are what a customer can buy today):",
  ];

  if (!products.length) lines.push("- Nothing is listed yet.");

  for (const product of products) {
    // Availability only. How much is reserved, and who for, is none of a
    // customer's business -- that is what leaked an order id into a reply.
    const inStock = product.variants
      .map((v) => ({ label: `${v.optionA} / ${v.optionB}`, available: v.stock - v.reserved }))
      .filter((v) => v.available > 0);

    const soldOut = product.variants
      .filter((v) => v.stock - v.reserved <= 0)
      .map((v) => `${v.optionA} / ${v.optionB}`);

    const total = inStock.reduce((a, v) => a + v.available, 0);

    lines.push(
      `- ${product.name} (${product.category}) — ${inr(product.price)} each, ${total} available, ` +
        `${product.leadTimeDays} day lead time if ordered in.`,
    );
    if (inStock.length) {
      lines.push(`  In stock: ${inStock.slice(0, CAPS.variants).map((v) => `${v.label} (${v.available})`).join(", ")}`);
    }
    if (soldOut.length) lines.push(`  Sold out: ${soldOut.slice(0, CAPS.variants).join(", ")}`);
    if (product.crossSell.length) lines.push(`  Goes well with: ${product.crossSell.join(", ")}`);
  }

  if (workspace.knowledge.length) {
    lines.push("", "WHAT YOU MAY TELL THEM ABOUT POLICY (nothing beyond this):");
    for (const k of workspace.knowledge) lines.push(`- ${k.title}: ${k.body}`);
  }

  return lines.join("\n");
}
