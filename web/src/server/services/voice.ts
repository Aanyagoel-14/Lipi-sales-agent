import type { KnowledgeEntry, TwinVoice } from "@/generated/prisma/client";

/**
 * Twin voice.
 *
 * Voice governs phrasing; knowledge governs claims. They are deliberately
 * separate: an assistant that sounds perfect while asserting a returns policy
 * you do not have is worse than a blunt one that is correct. So the caller
 * decides *what* is true from twin state, and this only decides how it reads.
 */

export type Voice = Pick<
  TwinVoice,
  "formality" | "length" | "useEmoji" | "signOff" | "greeting" | "neverSay" | "alwaysSay"
>;

export const DEFAULT_VOICE: Voice = {
  formality: "friendly",
  length: "balanced",
  useEmoji: false,
  signOff: null,
  greeting: null,
  neverSay: [],
  alwaysSay: [],
};

/** A reply is a core fact plus optional supporting detail, assembled per voice. */
export type ReplyParts = {
  core: string;
  detail?: string;
  question?: string;
};

const FORMAL_SWAPS: [RegExp, string][] = [
  [/\bI'll\b/g, "I will"],
  [/\bI've\b/g, "I have"],
  [/\byou'd\b/gi, "you would"],
  [/\byou'll\b/gi, "you will"],
  [/\bcan't\b/gi, "cannot"],
  [/\bwon't\b/gi, "will not"],
  [/\bWant me to\b/g, "Would you like me to"],
  [/\bWant the\b/g, "Would you like the"],
];

export function composeReply(parts: ReplyParts, voice: Voice): string {
  const pieces: string[] = [];

  if (voice.greeting && voice.formality !== "formal") pieces.push(voice.greeting);

  pieces.push(parts.core);

  // Length decides how much supporting detail survives.
  if (voice.length !== "terse" && parts.detail) pieces.push(parts.detail);
  if (voice.length !== "terse" && parts.question) pieces.push(parts.question);
  if (voice.length === "terse" && parts.question && !parts.detail) pieces.push(parts.question);

  let text = pieces.join(" ");

  if (voice.formality === "formal") {
    for (const [pattern, replacement] of FORMAL_SWAPS) text = text.replace(pattern, replacement);
  }

  if (voice.useEmoji) text += " 👍";
  if (voice.signOff) text += `\n${voice.signOff}`;

  return text;
}

/**
 * Money off, in the forms a model reaches for when a customer pushes back on
 * price. Deliberately narrow: what is caught is the twin *offering* it, not a
 * taught policy that mentions it, because restating "discounts beyond 10%
 * need owner approval" is exactly what the twin should do when asked.
 */
const MONEY_OFF = String.raw`\d+\s*(?:%|percent)|discount|off the (?:price|total|order)|off for you|free (?:shipping|delivery)|waive|on the house|no charge`;
const SUBJECT = String.raw`\b(?:I|we|let me)\s*(?:'ll|'d|can|could|will|would|shall|am able to|are able to)?\s*`;
/**
 * Three shapes, because a concession is not always a number. The gap in the
 * last two cannot cross a sentence boundary, so "I can do the Polo Classic.
 * Discounts need owner approval." is two true sentences rather than an offer.
 */
const OFFERS_A_DISCOUNT = new RegExp(
  [
    // Verbs that are themselves the concession, whatever follows them.
    String.raw`${SUBJECT}(?:waive|knock|throw in|match)\b`,
    // Moving the price, said without ever naming a percentage.
    String.raw`${SUBJECT}(?:drop|reduce|lower|bring down|cut)\b[^.!?]{0,20}\b(?:price|total|cost|rate)\b`,
    // Offering money off in so many words.
    String.raw`${SUBJECT}(?:offer|give|do|take|make it)\b[^.!?]{0,40}(?:${MONEY_OFF})`,
  ].join("|"),
  "i",
);

/**
 * Flags what the twin may not say: the phrases the workspace has banned, and
 * money it was never authorised to give away. Returned rather than silently
 * stripped: an operator needs to see that their twin tried to say it.
 *
 * The discount gate is not the workspace's to relax. A price is a fact
 * `ingest()` computed from the catalogue (invariant 2), so a model that
 * decides to take 15% off it has invented a number the business never agreed
 * to and the customer cannot tell from a real one. An *authorised* discount is
 * its own path, with its own approval -- when that exists this consults what
 * it approved, rather than refusing outright.
 */
export function voiceViolations(text: string, voice: Voice): string[] {
  const banned = voice.neverSay.filter((phrase) => phrase.trim() && text.toLowerCase().includes(phrase.toLowerCase()));

  const offer = text.match(OFFERS_A_DISCOUNT);
  return offer ? [...banned, `unauthorised discount or waiver ("${offer[0].trim()}")`] : banned;
}

const KIND_FOR_INTENT: Record<string, KnowledgeEntry["kind"][]> = {
  return: ["policy", "sizing"],
  support: ["policy", "shipping", "warranty"],
  inventory_request: ["shipping"],
  quote_request: ["pricing"],
  purchase_order: ["pricing", "shipping"],
  complaint: ["warranty", "policy"],
};

/** A knowledge entry with the score that earned it its place. */
export type RankedKnowledge = { entry: KnowledgeEntry; score: number };

/**
 * Below this an entry is a coincidence rather than an answer: a single word
 * in common, or nothing but the right kind for the intent.
 */
const RELEVANT = 4;

/** How many entries a single message can pull in. */
const KNOWLEDGE_TOP = 5;

/** A to Z, so equal scores break the same way whatever order the rows arrived in. */
function compare(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Ranks what the business has taught the twin against this message. Scored on
 * word overlap so a customer does not have to name the policy to get it, with
 * a bonus for the kind the intent implies.
 *
 * The order is total — score, then title, then id — so the same message and
 * the same workspace produce the same block however the rows arrive from
 * Postgres. A block that reshuffles between two identical turns is a block
 * nobody can debug.
 */
export function rankKnowledge(
  text: string,
  intent: string,
  entries: KnowledgeEntry[],
  limit = KNOWLEDGE_TOP,
): RankedKnowledge[] {
  const preferred = KIND_FOR_INTENT[intent] ?? [];
  const words = new Set(
    text.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3),
  );

  return entries
    .map((entry) => {
      const haystack = `${entry.title} ${entry.body}`.toLowerCase();
      let score = 0;
      for (const word of words) if (haystack.includes(word)) score += 2;
      if (preferred.includes(entry.kind)) score += 3;
      return { entry, score };
    })
    .filter((r) => r.score >= RELEVANT)
    .sort((a, b) => b.score - a.score || compare(a.entry.title, b.entry.title) || compare(a.entry.id, b.entry.id))
    .slice(0, limit);
}

/**
 * The single entry that best answers this message, for the composed reply,
 * which has room for one. The same ranking the grounding block uses -- one
 * retrieval path, read two ways -- so the template and the model never
 * disagree about which policy applies.
 */
export function findKnowledge(text: string, intent: string, entries: KnowledgeEntry[]): KnowledgeEntry | null {
  return rankKnowledge(text, intent, entries, 1)[0]?.entry ?? null;
}
