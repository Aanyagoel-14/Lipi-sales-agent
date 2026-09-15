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

/**
 * Picks the knowledge entry that best answers this message. Scored on word
 * overlap so a customer does not have to name the policy to get it, but
 * anything with no overlap at all returns nothing rather than a guess.
 */
export function findKnowledge(text: string, intent: string, entries: KnowledgeEntry[]): KnowledgeEntry | null {
  if (!entries.length) return null;

  const preferred = KIND_FOR_INTENT[intent] ?? [];
  const words = new Set(
    text.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3),
  );

  let best: { entry: KnowledgeEntry; score: number } | null = null;

  for (const entry of entries) {
    const haystack = `${entry.title} ${entry.body}`.toLowerCase();
    let score = 0;
    for (const word of words) if (haystack.includes(word)) score += 2;
    if (preferred.includes(entry.kind)) score += 3;
    if (score > (best?.score ?? 0)) best = { entry, score };
  }

  return best && best.score >= 4 ? best.entry : null;
}
