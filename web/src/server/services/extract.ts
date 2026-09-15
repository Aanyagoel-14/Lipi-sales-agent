import { z } from "zod";
import { env } from "../env";
import { chatCompletion } from "../lib/openrouter";
import { catalogueFor, type Vertical } from "./catalogues";

/**
 * Conversation intelligence: turns a raw message into structured intent.
 *
 * The vocabulary is the workspace's own. An apparel twin resolves "blue" to
 * Cobalt and "XL" to a size; a parts twin resolves "swift" to a fitment and
 * "genuine" to OEM. Hardcoding one trade's words is how you get a system that
 * only works for the vertical it was demoed on.
 *
 * Two implementations behind one interface. The rule extractor is
 * deterministic and needs no key, so the loop is always testable. OpenRouter
 * takes over when OPENROUTER_API_KEY is set, and falls back to rules if the
 * call fails or returns a shape that does not validate.
 */

export const extractedSchema = z.object({
  intent: z.enum([
    "buy", "inventory_request", "quote_request", "return",
    "support", "purchase_order", "complaint", "other",
  ]),
  quantity: z.number().int().positive().nullable(),
  optionA: z.string().nullable(),
  optionB: z.string().nullable(),
  category: z.string().nullable(),
  deadline: z.string().nullable(),
  priority: z.enum(["low", "normal", "high"]),
});

export type Extracted = z.infer<typeof extractedSchema>;
export type ExtractionResult = Extracted & { extractor: "rules" | "openrouter" };

export type Vocabulary = {
  categories: Record<string, string>;
  optionAliases: Record<string, string>;
  optionsA: string[];
  optionsB: string[];
  axes: [string, string];
};

/** What the workspace actually sells, as opposed to what its trade usually sells. */
export type LiveCatalogue = {
  categories: string[];
  optionsA: string[];
  optionsB: string[];
  axes?: [string, string];
};

/**
 * The vocabulary is the trade's *plus the workspace's own*.
 *
 * The vertical supplies aliases and the words customers use loosely ("blue"
 * means Cobalt, "genuine" means OEM). The live catalogue supplies the options
 * and categories that actually exist here, so a product the operator added
 * themselves is findable. Without that, anything outside the demo catalogue is
 * invisible and the twin confidently matches the wrong product.
 */
export function vocabularyFor(vertical: Vertical, live?: LiveCatalogue): Vocabulary {
  const catalogue = catalogueFor(vertical);

  const categories = { ...catalogue.vocabulary.categories };
  for (const category of live?.categories ?? []) {
    // A category is findable by its own name as well as by the trade's slang.
    categories[category.toLowerCase()] = category;
  }

  return {
    categories,
    optionAliases: catalogue.vocabulary.optionAliases,
    optionsA: [...new Set([...(live?.optionsA ?? []), ...catalogue.products.flatMap((p) => p.optionsA)])],
    optionsB: [...new Set([...(live?.optionsB ?? []), ...catalogue.products.flatMap((p) => p.optionsB)])],
    axes: live?.axes ?? ((catalogue.products[0]?.axes ?? ["Option A", "Option B"]) as [string, string]),
  };
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, dozen: 12,
};

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function nextWeekday(name: string, from: Date): string {
  const target = WEEKDAYS.indexOf(name);
  const d = new Date(from);
  const delta = (target - d.getUTCDay() + 7) % 7 || 7;
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const UNIT_WORDS = "x|pcs|pieces|units?|kg|kgs|l|litres";

/**
 * H-2 fix: the original regex read any standalone 1-5 digit number as a
 * quantity, which collided with two things this vertical's own vocabulary
 * ships: calendar years ("2026 season olive L polo" -> quantity 2026) and
 * auto-parts fitment tokens ("Swift 2018-24" -> quantity 2018, or "brake pads
 * for Swift 2018" -> quantity 2018). Ten-digit phone numbers were already
 * safe -- \b\d{1,5}\b cannot match inside a longer unbroken digit run -- but
 * a 4-digit year sitting on its own reads exactly like a quantity.
 *
 * Fix: a number followed by an explicit unit word ("3 units", "5kg") is
 * unambiguous and always wins, regardless of its value. Failing that, a bare
 * number is trusted as a quantity only if it does not look like a calendar
 * year (1900-2099) -- a customer who really means "give me 2018 units" says
 * so with a unit word, exactly like the case above.
 */
function parseQuantity(t: string): number | null {
  const withUnit = t.match(new RegExp(`\\b(\\d{1,5})\\s*(?:${UNIT_WORDS})\\b`));
  if (withUnit) return Number(withUnit[1]);

  const bare = t.match(/\b(\d{1,5})\b/);
  if (bare) {
    const value = Number(bare[1]);
    const looksLikeYear = bare[1].length === 4 && value >= 1900 && value <= 2099;
    if (!looksLikeYear) return value;
    // A year-shaped number is not read as a quantity; fall through to a
    // spelled-out number word instead of returning it.
  }

  const word = Object.keys(NUMBER_WORDS).find((w) => new RegExp(`\\b${w}\\b`).test(t));
  return word ? NUMBER_WORDS[word]! : null;
}

/** Longest first, so "Swift 2018-24" wins over a bare "swift". */
function matchOption(text: string, options: string[], aliases: Record<string, string>): string | null {
  const direct = [...options]
    .sort((a, b) => b.length - a.length)
    .find((o) => new RegExp(`\\b${escape(o.toLowerCase())}\\b`).test(text));
  if (direct) return direct;

  // Aliases are shared across both axes ("genuine" is a Grade, "swift" a
  // Fitment), so keep looking until one resolves into *this* axis. Stopping at
  // the first alias found in the text loses the other axis entirely.
  for (const key of Object.keys(aliases).sort((a, b) => b.length - a.length)) {
    if (!new RegExp(`\\b${escape(key.toLowerCase())}\\b`).test(text)) continue;
    const resolved = aliases[key]!;
    if (options.includes(resolved)) return resolved;
  }

  return null;
}

export function extractWithRules(text: string, vocab: Vocabulary, now = new Date()): ExtractionResult {
  const t = text.toLowerCase();

  const intent: Extracted["intent"] =
    /\b(return|exchange|swap|refund)\b/.test(t) ? "return"
    : /\b(po|purchase order|net \d+)\b/.test(t) ? "purchase_order"
    : /\b(price|pricing|rate|cost|discount|quote|quotation|how much)\b/.test(t) ? "quote_request"
    : /\b(broken|damaged|faulty|complain|terrible|awful)\b/.test(t) ? "complaint"
    : /\b(in stock|back in stock|available|availability|do you have|got any)\b/.test(t) ? "inventory_request"
    // "give me two polos" is as much a purchase as "I need two polos". A
    // buy phrase the rules do not know reads as `other`, and the twin answers
    // "let me look into that" to someone who was ready to pay.
    : /\b(need|want|order|buy|send me|take|purchase|give me|get me|grab|reserve|book|add)\b/.test(t) ? "buy"
    : /\b(where|help|how|when|status|fit|fits)\b/.test(t) ? "support"
    : "other";

  const quantity = parseQuantity(t);

  const categoryKey = Object.keys(vocab.categories)
    .sort((a, b) => b.length - a.length)
    .find((k) => new RegExp(`\\b${escape(k)}\\b`).test(t));

  let deadline: string | null = null;
  const day = WEEKDAYS.find((d) => new RegExp(`\\b${d}\\b`).test(t));
  if (day) deadline = nextWeekday(day, now);
  else if (/\btomorrow\b/.test(t)) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() + 1);
    deadline = d.toISOString().slice(0, 10);
  }

  const urgent = /\b(urgent|asap|today|immediately|rush)\b/.test(t) || Boolean(deadline);

  return {
    intent,
    quantity,
    optionA: matchOption(t, vocab.optionsA, vocab.optionAliases),
    optionB: matchOption(t, vocab.optionsB, vocab.optionAliases),
    category: categoryKey ? vocab.categories[categoryKey]! : null,
    deadline,
    priority: urgent ? "high" : intent === "complaint" ? "high" : "normal",
    extractor: "rules",
  };
}

function systemPrompt(vocab: Vocabulary, now: Date) {
  return `You extract structured commerce intent from a single customer message.

This business sells by two axes: "${vocab.axes[0]}" and "${vocab.axes[1]}".
Valid ${vocab.axes[0]} values: ${vocab.optionsA.join(", ")}.
Valid ${vocab.axes[1]} values: ${vocab.optionsB.join(", ")}.
Valid categories: ${[...new Set(Object.values(vocab.categories))].join(", ")}.

Intent definitions — read carefully, these two are the ones most often confused:
- "buy": an ordinary retail purchase request, however it is phrased. "I need 3 olive
  L polos", "send me two", "can I get one in XL" are ALL "buy", even though the
  customer is technically issuing a verbal purchase order for goods. The mere
  presence of a quantity and a product does not make something a "purchase_order".
- "purchase_order": a message that names or implies a FORMAL commercial instrument —
  it uses the words "PO" / "purchase order" explicitly, states payment terms like
  "net 30" / "net 60", references a PO number, or is clearly written on behalf of a
  business placing a trade order (letterhead tone, account terms, invoicing
  language). If the message is just a person asking to buy something in ordinary
  language, with no reference to formal terms or a PO, it is "buy", not
  "purchase_order" — regardless of quantity.
- Examples: "need 3 olive L polos" -> buy. "want 200 units" -> buy (large
  quantity alone does not imply a PO). "PO for 5 olive L polos, net 30" ->
  purchase_order. "raising a purchase order for 50 units, invoice to accounts@..."
  -> purchase_order.

Return optionA as a ${vocab.axes[0]} value and optionB as a ${vocab.axes[1]} value, exactly as listed, or null.
Customers use loose words: ${Object.entries(vocab.optionAliases).map(([k, v]) => `"${k}" means "${v}"`).join("; ")}.
Use null for anything you are not confident about. Today is ${now.toISOString().slice(0, 10)}.`;
}

const jsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["intent", "quantity", "optionA", "optionB", "category", "deadline", "priority"],
  properties: {
    intent: { type: "string", enum: ["buy", "inventory_request", "quote_request", "return", "support", "purchase_order", "complaint", "other"] },
    quantity: { type: ["integer", "null"] },
    optionA: { type: ["string", "null"] },
    optionB: { type: ["string", "null"] },
    category: { type: ["string", "null"] },
    deadline: { type: ["string", "null"] },
    priority: { type: "string", enum: ["low", "normal", "high"] },
  },
};

async function extractWithOpenRouter(text: string, vocab: Vocabulary, now: Date): Promise<ExtractionResult> {
  const content = await chatCompletion({
    model: env.OPENROUTER_MODEL,
    messages: [
      { role: "system", content: systemPrompt(vocab, now) },
      { role: "user", content: text },
    ],
    temperature: 0,
    timeoutMs: 15_000,
    responseFormat: { type: "json_schema", json_schema: { name: "extraction", strict: true, schema: jsonSchema } },
  });

  const parsed = extractedSchema.parse(JSON.parse(content));

  // A model may invent an option that does not exist in this catalogue.
  return {
    ...parsed,
    optionA: parsed.optionA && vocab.optionsA.includes(parsed.optionA) ? parsed.optionA : null,
    optionB: parsed.optionB && vocab.optionsB.includes(parsed.optionB) ? parsed.optionB : null,
    extractor: "openrouter",
  };
}

export async function extract(text: string, vocab: Vocabulary, now = new Date()): Promise<ExtractionResult> {
  if (!env.OPENROUTER_API_KEY) return extractWithRules(text, vocab, now);

  try {
    return await extractWithOpenRouter(text, vocab, now);
  } catch (error) {
    console.warn(`[extract] OpenRouter failed, using rules: ${(error as Error).message}`);
    return extractWithRules(text, vocab, now);
  }
}
