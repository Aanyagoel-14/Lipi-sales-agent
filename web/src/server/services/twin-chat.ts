import { env } from "../env";
import { chatForReply } from "../lib/openrouter";
import { buildBriefing, type Briefing } from "./briefing";

/**
 * Chatting with your own twin.
 *
 * Different job from `ingest`. That one is a customer talking to the business
 * and it *mutates* twins: reservations, orders, events. This is the operator
 * talking to their own twin about the business, and it writes nothing. Asking
 * "what is running low" must never reserve stock.
 *
 * The answer is grounded in `buildBriefing`, which is assembled from the same
 * rows the dashboard renders. The model is told it may only use that briefing,
 * because a twin that guesses a stock number is worse than one that says it
 * does not know: the operator cannot tell the two apart until they act on it.
 */

export type ChatTurn = { role: "user" | "assistant"; content: string };

export type ChatResult = {
  reply: string;
  /** Which path answered, so the UI never implies a model spoke when rules did. */
  source: "openrouter" | "rules";
  model: string | null;
  facts: Briefing["facts"];
  /** Present when the model was tried and failed, so a silent downgrade is visible. */
  degraded?: string;
};

/** How much of the conversation to carry. Enough for follow-ups, bounded for cost. */
const HISTORY_TURNS = 12;

function systemPrompt(briefing: string) {
  return `You are the operations twin of this business. You are talking to the owner or an operator, not to a customer.

Everything below is a live snapshot of their business, read from their database moments ago. It is the ONLY source of truth you have.

${briefing}

How to answer:
- Answer only from the snapshot. If it does not contain the answer, say plainly what is missing and name the dashboard page that would have it (Inventory, Orders, Customers, Invoices, Approvals, Twin events).
- Never invent a stock count, price, order id, customer or policy. A wrong number is worse than "I don't have that".
- Quote real numbers, ids and variant names from the snapshot when they support the answer.
- Be direct and short. Lead with the answer, then the supporting figures.
- The reply is rendered as markdown, with a real newline before each list item. Use **bold** for numbers that matter and a short bullet list when you are naming several products or variants. No headings. Use a table only when comparing three or more rows on the same columns.
- Money is rupees, already formatted. Available stock already has reservations subtracted.
- You are read-only here: you can advise on reordering, pricing or chasing an order, but you cannot perform it. Say so and point at the page that can.`;
}

const askOpenRouter = (messages: ChatTurn[], briefing: string) =>
  chatForReply({
    messages: [{ role: "system", content: systemPrompt(briefing) }, ...messages.slice(-HISTORY_TURNS)],
    temperature: 0.2,
    maxTokens: 1400,
  });

/**
 * The keyless path. Not a model, and does not pretend to be: it reads the same
 * briefing back for the handful of questions that have a literal answer in it,
 * so the feature is usable and testable without a key.
 */
function answerWithRules(question: string, briefing: Briefing): string {
  const q = question.toLowerCase();
  const f = briefing.facts;
  const section = (heading: string) => {
    const body = briefing.text.split("\n\n").find((block) => block.startsWith(heading));
    return body ? body.split("\n").slice(0, 14).join("\n") : null;
  };

  if (/\b(low|running out|reorder|restock|short)\b/.test(q)) {
    const low = briefing.text.split("\n").filter((l) => l.includes("[LOW]"));
    return low.length
      ? `${f.lowStock} variants are at or below the reorder point.\n${low.join("\n")}`
      : "Nothing is below the reorder point right now.";
  }

  if (/\b(stock|inventory|available|units|how many)\b/.test(q)) {
    return section("INVENTORY") ?? `${f.unitsAvailable} units available across ${f.products} products.`;
  }

  if (/\b(order|pipeline|sales|revenue|value|pending)\b/.test(q)) {
    return section("ORDERS") ?? `${f.openOrders} open orders worth ₹${f.pipelineInr.toLocaleString("en-IN")}.`;
  }

  if (/\b(customer|buyer|client)\b/.test(q)) return section("TOP CUSTOMERS") ?? "No customers yet.";
  if (/\b(approval|approve|waiting|held)\b/.test(q)) return section("PENDING APPROVALS") ?? "Nothing is waiting for approval.";

  return (
    `I can only answer from the snapshot without a language model connected. Right now: ` +
    `${f.products} products, ${f.unitsAvailable} units available, ${f.lowStock} variants low, ` +
    `${f.openOrders} open orders worth ₹${f.pipelineInr.toLocaleString("en-IN")}, ${f.pendingApprovals} approvals pending.\n` +
    `Set OPENROUTER_API_KEY on the API to have the twin answer properly.`
  );
}

export async function chatWithTwin(workspaceId: string, messages: ChatTurn[]): Promise<ChatResult> {
  const briefing = await buildBriefing(workspaceId);
  const latest = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";

  if (!env.OPENROUTER_API_KEY) {
    return { reply: answerWithRules(latest, briefing), source: "rules", model: null, facts: briefing.facts };
  }

  try {
    return {
      reply: await askOpenRouter(messages, briefing.text),
      source: "openrouter",
      model: env.OPENROUTER_CHAT_MODEL,
      facts: briefing.facts,
    };
  } catch (error) {
    const reason = (error as Error).message;
    console.warn(`[twin-chat] OpenRouter failed, answering from the snapshot: ${reason}`);
    return {
      reply: answerWithRules(latest, briefing),
      source: "rules",
      model: null,
      facts: briefing.facts,
      degraded: reason,
    };
  }
}
