import { env } from "../env";
import { chatForReply } from "../lib/openrouter";
import { prisma } from "../lib/prisma";
import { toRupees } from "../lib/money";
import { buildGrounding } from "./briefing";
import { ingest, type IngestResult } from "./ingest";
import { invoiceForOrder } from "./invoicing";
import { DEFAULT_VOICE, voiceViolations, type Voice } from "./voice";
import type { Channel } from "@/generated/prisma/client";

/**
 * The twin as a salesperson.
 *
 * A deliberate split, and the whole safety story of this feature:
 *
 *   ingest  decides what is TRUE  — matches the product, checks stock,
 *           reserves it, prices it, creates the order, writes the events.
 *   this    decides what is SAID  — turns those facts into something that
 *           reads like a shopkeeper rather than a form letter.
 *
 * The model never touches stock or money. It is handed the outcome and asked
 * to voice it, because a model allowed to compute a total will eventually
 * quote one the business cannot honour, and the customer has no way to tell
 * that from a real quote. If the model is missing or fails, `ingest`'s own
 * composed reply is used: less warm, still correct.
 */

export type SellTurn = { role: "user" | "assistant"; content: string };

export type SellResult = {
  reply: string;
  /** Which path wrote the words. The facts are deterministic either way. */
  voicedBy: "openrouter" | "template";
  conversationId: string;
  /**
   * The stored message carrying `reply`, for whoever delivers it. Every
   * channel but webchat sends out of band — see `channels/inbound.ts`.
   */
  replyMessageId: string;
  customer: IngestResult["customer"];
  matched: IngestResult["matched"];
  /**
   * The policies the block was grounded in, most relevant first, so the
   * dashboard can show why the twin said what it said.
   */
  knowledgeUsed: { title: string; kind: string }[];
  order: (IngestResult["order"] & { stage: string }) | null;
  invoice: { number: string; amountInr: number; dueIso: string; url: string } | null;
  intent: string;
  held: boolean;
  degraded?: string;
};

/** How much of the conversation the salesperson remembers. */
export const HISTORY_TURNS = 10;

/**
 * What the channel does to a reply, in the only terms a model can act on.
 *
 * Asked for up front rather than enforced afterwards. Every provider accepts
 * thousands of characters, so a model that wrote four paragraphs for WhatsApp
 * produces a message that is deliverable and unreadable, and cutting it to
 * length afterwards would cut a verified price in half — inventing a number
 * nobody computed, which is precisely what the fact/voice split exists to
 * prevent. The formatting note beside the length is the same kind of fact
 * about the surface: nothing in `channels/registry.ts` asks a provider to
 * parse markdown, so `**bold**` reaches a WhatsApp customer as four
 * asterisks, and only the widget renders a list as a list.
 */
const CHANNEL_STYLE: Record<Channel, string> = {
  webchat:
    "This is the chat panel on the website and it renders as markdown. Two or three sentences, plus the "
    + "list when there is one, and put each product's name in **bold**.",
  whatsapp:
    "This is a WhatsApp message, read on a phone. Two short sentences before any list, and write plain "
    + "text — asterisks and hashes arrive as punctuation, not formatting.",
  telegram:
    "This is a Telegram message, read on a phone. Two short sentences before any list, and write plain "
    + "text — asterisks and hashes arrive as punctuation, not formatting.",
  instagram:
    "This is an Instagram DM. One or two short sentences, at most three options, and plain text only — "
    + "asterisks and hashes arrive as punctuation, not formatting.",
  facebook:
    "This is a Messenger DM. One or two short sentences, at most three options, and plain text only — "
    + "asterisks and hashes arrive as punctuation, not formatting.",
  email:
    "This is a reply to an email, so a short paragraph is fine where a chat bubble would not be — but "
    + "still no more than a paragraph and a list. Write plain text; it is not rendered as markdown.",
};

/**
 * What this customer and the twin have already said to each other, oldest
 * first — the salesperson's memory across turns, and the same memory on every
 * channel.
 *
 * `ingest()` opens a conversation per message, so a customer's history is the
 * tail of their conversations rather than the tail of one, and it has to be
 * read by conversation: the agent's reply is stamped a second after the
 * message it answers, so ordering every row by `sentAt` alone would slot the
 * next question in front of the answer to the last one.
 *
 * Keyed by handle, which is what `ingest()` resolves a customer twin by, and
 * scoped by workspace, so the same phone number in two tenants is two
 * customers and neither is ever replayed into the other's prompt
 * (invariant 5).
 */
async function historyFor(workspaceId: string, handle: string): Promise<SellTurn[]> {
  const customer = await prisma.customer.findFirst({
    where: { workspaceId, handle },
    select: { id: true },
  });
  if (!customer) return [];

  // The newest `HISTORY_TURNS` conversations are more than enough to fill the
  // window, since every one of them holds at least the customer's own message.
  const newestFirst = await prisma.conversation.findMany({
    where: { workspaceId, customerId: customer.id },
    orderBy: { lastAt: "desc" },
    take: HISTORY_TURNS,
    select: { messages: { orderBy: { sentAt: "asc" }, select: { from: true, text: true } } },
  });

  return newestFirst
    .reverse()
    .flatMap((conversation) => conversation.messages)
    .map((message): SellTurn => ({
      role: message.from === "agent" ? "assistant" : "user",
      content: message.text,
    }))
    .slice(-HISTORY_TURNS);
}

function voiceRules(voice: Voice) {
  const rules = [
    `Formality: ${voice.formality}. Length: ${voice.length}.`,
    voice.useEmoji ? "Emoji are welcome, sparingly." : "Do not use emoji.",
  ];
  if (voice.greeting) rules.push(`Preferred greeting: "${voice.greeting}".`);
  if (voice.signOff) rules.push(`Sign off with: "${voice.signOff}".`);
  if (voice.alwaysSay.length) rules.push(`Work in where natural: ${voice.alwaysSay.join("; ")}.`);
  if (voice.neverSay.length) rules.push(`NEVER use these phrases: ${voice.neverSay.join("; ")}.`);
  return rules.join(" ");
}

/**
 * What actually happened, in the model's own briefing. Only these numbers may
 * appear in the reply.
 */
function outcome(result: IngestResult, invoice: SellResult["invoice"]) {
  const lines = [`The customer's intent read as: ${result.extracted.intent}.`];

  if (result.matched) lines.push(`Matched product: ${result.matched.product}, variant ${result.matched.variant}.`);
  else lines.push("No product in the catalogue matched what they said.");

  if (result.order) {
    lines.push(
      `AN ORDER WAS CREATED: ${result.order.id}, total INR ${result.order.valueInr.toLocaleString("en-IN")}. ` +
        `Stock is reserved for them. Confirm this warmly and say what happens next.`,
    );
  }

  if (invoice) {
    lines.push(
      `Invoice ${invoice.number} has been raised for INR ${invoice.amountInr.toLocaleString("en-IN")}, ` +
        `due ${invoice.dueIso}. Tell them it is ready to download.`,
    );
  }

  lines.push(
    "",
    "The system composed this plain reply. Every number in it is verified, so treat it as the source of truth " +
      "for what was promised -- but you are writing the actual message, not copying this one:",
    `"${result.reply}"`,
  );

  return lines.join("\n");
}

function systemPrompt(grounding: string, voice: Voice, facts: string, channel: Channel) {
  return `You are a salesperson at this business, chatting with a customer who is deciding what to buy. Your job is to help them choose and then close the sale — friendly, confident, never pushy.

${grounding}

WHAT THE SYSTEM DID WITH THEIR LAST MESSAGE:
${facts}

How to reply:
- NUMBERS ARE NOT YOURS TO CHOOSE. Every price, quantity, stock count, order id and invoice number must appear verbatim above. Never add, total, estimate or round. If a number you want is not written above, leave it out.
- If the system reserved something, created an order or raised an invoice, it is ALREADY DONE. Confirm it as done and say what happens next. Never ask permission for it ("shall I go ahead?") — the customer has been promised it, and asking makes the twin look like it did not do what it did.
- Sell. Recommend something specific, say why, and end with a question that moves them forward — which size, how many, shall I reserve it.
- BUT if an order was already created above, the sale is closed: do not ask "shall I reserve/proceed/go ahead". Confirm it, tell them the invoice is ready, and ask only whether they need anything else.
- Put the closing question on its own line, after any list. Never let it run onto the end of a list item.
- When you are showing more than one option, lay them out as a list with a real newline before each "- ", one product per line with its price. Never bury choices in a paragraph.
- Only offer things with stock above. If something is sold out, say so plainly and put the nearest available option in front of them.
- Never mention other customers, other orders, reservations, stock you are holding for someone else, margins, suppliers, or anything about how the business runs. You know only the catalogue above.
- Never promise a delivery date, discount, refund or policy that is not written above.
- Short, and shaped for where it is going. ${CHANNEL_STYLE[channel]}

Voice: ${voiceRules(voice)}

Reply with JSON only: {"reply": "<the message>"}. Do not write your reasoning.`;
}

const voiceReply = (system: string, history: SellTurn[]) =>
  chatForReply({
    messages: [{ role: "system", content: system }, ...history.slice(-HISTORY_TURNS)],
    temperature: 0.4,
    // Room for a reasoning model to think before it fills the field. Too tight
    // and the reply is truncated mid-thought, which reads as a broken twin.
    maxTokens: 2000,
  });

/**
 * A sale that is already made must not be asked about.
 *
 * The order is created before the model speaks, so "shall I reserve those for
 * you?" is not a harmless flourish — it tells the customer the opposite of
 * what happened, and they wait for a confirmation that never comes while
 * stock sits reserved against their name. A weaker model ignores being told
 * this in the prompt, so it is checked rather than requested.
 *
 * Returns the repaired reply, or null when nothing useful is left, in which
 * case the caller sends the composed reply, which is always correct.
 */
const ASKS_PERMISSION =
  /\b(shall|should|may|can|would you like me to|do you want me to|want me to)\b[^.!?]{0,60}\b(reserve|proceed|go ahead|place|book|confirm|checkout|check out|order)\b/i;

export function repairSettledSale(reply: string, signOff: string | null, invoiceNumber: string | null): string | null {
  // The sign-off is glued to the last sentence, which is the one being cut.
  const trimmed = signOff && reply.endsWith(signOff) ? reply.slice(0, -signOff.length).trimEnd() : reply;

  const sentences = trimmed.split(/(?<=[.!?])\s+/);
  const kept = sentences.filter((sentence) => !ASKS_PERMISSION.test(sentence));
  if (kept.length === sentences.length) return null;

  let repaired = kept.join(" ").trim();
  // Cutting the only substantial sentence leaves nothing worth sending.
  if (repaired.length < 20) return null;

  repaired += invoiceNumber
    ? ` Invoice ${invoiceNumber} is ready to download.`
    : " It is reserved for you.";

  return signOff ? `${repaired}\n${signOff}` : repaired;
}

const WANTS_INVOICE = /\b(invoice|bill|receipt|proforma)\b/i;

export async function sell(input: {
  workspaceId: string;
  channel: Channel;
  handle: string;
  name?: string;
  text: string;
  /**
   * The turns to replay, when the caller already has them — the storefront
   * panel holds its own transcript. Omitted means "read them", which is what
   * every channel that arrives as a webhook does.
   */
  history?: SellTurn[];
}): Promise<SellResult> {
  // Read before the message is ingested, or this turn would be replayed to
  // the model as something the customer had already said. Skipped entirely
  // when there is no model to replay it to.
  const history = input.history
    ?? (env.OPENROUTER_API_KEY ? await historyFor(input.workspaceId, input.handle) : []);

  // Real writes. A customer buying something has to reserve real stock and
  // create a real order, or the invoice at the end of it is a fiction.
  const result = await ingest({
    workspaceId: input.workspaceId,
    channel: input.channel,
    handle: input.handle,
    name: input.name,
    text: input.text,
  });

  /* ------------------------------------------------------------- invoicing */
  // An order always gets its invoice. Asking for "the invoice" with no new
  // order falls back to their most recent one, which is what a customer means.
  let invoiceOrderId = result.order?.id ?? null;
  if (!invoiceOrderId && WANTS_INVOICE.test(input.text)) {
    const last = await prisma.order.findFirst({
      where: { workspaceId: input.workspaceId, customerId: result.customer.id },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    invoiceOrderId = last?.id ?? null;
  }

  let invoice: SellResult["invoice"] = null;
  if (invoiceOrderId) {
    const { invoice: row } = await invoiceForOrder(input.workspaceId, invoiceOrderId);
    invoice = {
      number: row.number,
      amountInr: toRupees(row.amount),
      dueIso: row.dueOn.toISOString().slice(0, 10),
      url: `/v1/invoices/${encodeURIComponent(row.number)}/pdf`,
    };
  }

  const order = result.order
    ? { ...result.order, stage: "Quoted" }
    : null;

  const base: Omit<SellResult, "reply" | "voicedBy"> = {
    conversationId: result.conversationId,
    replyMessageId: result.replyMessageId,
    customer: result.customer,
    matched: result.matched,
    order,
    invoice,
    intent: result.extracted.intent,
    held: !result.replySent,
    // What grounded the composed reply: `findKnowledge`'s single entry, which
    // is the first row of the ranking the grounding block below uses, so the
    // two never contradict each other.
    knowledgeUsed: result.knowledgeUsed ? [result.knowledgeUsed] : [],
  };

  if (!env.OPENROUTER_API_KEY) return { ...base, reply: result.reply, voicedBy: "template" };

  const [grounding, workspace] = await Promise.all([
    // The customer-safe block, never the operator briefing: that one carries
    // other customers, their order values and this month's approvals. Narrowed
    // to this message, so the policies it asks about are stated rather than
    // buried, and the catalogue leads with what was matched.
    buildGrounding(input.workspaceId, {
      text: input.text,
      intent: result.extracted.intent,
      matched: result.matched,
    }),
    prisma.workspace.findUnique({ where: { id: input.workspaceId }, include: { voice: true } }),
  ]);
  const voice = workspace?.voice ?? DEFAULT_VOICE;
  // The model speaks from the whole ranked block, so that is what grounded the turn.
  base.knowledgeUsed = grounding.knowledge.map(({ title, kind }) => ({ title, kind }));

  try {
    const spoken = await voiceReply(
      systemPrompt(grounding.text, voice, outcome(result, invoice), input.channel),
      [...history, { role: "user", content: input.text }],
    );

    // The voice rules are the workspace's, so a model that ignores them does
    // not get to speak. Falling back is better than shipping a banned phrase.
    const violations = voiceViolations(spoken, voice);
    if (violations.length) {
      return {
        ...base, reply: result.reply, voicedBy: "template",
        degraded: `Model used banned phrases (${violations.join(", ")}), so the plain reply was sent`,
      };
    }

    // A model that asks to do what it has already done is stating the
    // opposite of what happened, so the claim is repaired before sending.
    let finalReply = spoken;
    if (result.order) {
      const repaired = repairSettledSale(spoken, voice.signOff, invoice?.number ?? null);
      if (repaired === null && ASKS_PERMISSION.test(spoken)) {
        return {
          ...base, reply: result.reply, voicedBy: "template",
          degraded: "Model asked to place an order it had already placed, so the plain reply was sent",
        };
      }
      if (repaired) finalReply = repaired;
    }

    // The spoken reply is what the customer actually got, so it is what the
    // conversation must show — written onto the row ingest composed into,
    // which is also the row a channel is about to deliver. The plain one was
    // never sent.
    if (result.replySent) {
      await prisma.message.update({
        where: { id: result.replyMessageId },
        data: { text: finalReply },
      });
    }

    return { ...base, reply: finalReply, voicedBy: "openrouter" };
  } catch (error) {
    const reason = (error as Error).message;
    console.warn(`[selling] voicing failed, sending the composed reply: ${reason}`);
    return { ...base, reply: result.reply, voicedBy: "template", degraded: reason };
  }
}
