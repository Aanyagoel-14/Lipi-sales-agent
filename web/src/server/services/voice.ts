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
 * Flags phrases the workspace has banned. Returned rather than silently
 * stripped: an operator needs to see that their twin tried to say it.
 */
export function voiceViolations(text: string, voice: Voice): string[] {
  return voice.neverSay.filter((phrase) => phrase.trim() && text.toLowerCase().includes(phrase.toLowerCase()));
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
export const KNOWLEDGE_TOP = 5;

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

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
