/**
 * Twin shapes and defaults, free of any server-only import.
 *
 * Client components need these, so this module must never reach for
 * next/headers. `lib/train` re-exports them for server callers. This is the
 * second time a server-only import reached the browser through a shared
 * module, so the rule is: types and constants live here, fetching lives there.
 */
export type Formality = "formal" | "neutral" | "friendly";
export type Length = "terse" | "balanced" | "detailed";
export type KnowledgeKind = "policy" | "faq" | "sizing" | "shipping" | "warranty" | "pricing";

export type Voice = {
  formality: Formality;
  length: Length;
  useEmoji: boolean;
  signOff: string | null;
  greeting: string | null;
  languages: string[];
  neverSay: string[];
  alwaysSay: string[];
};

export type KnowledgeEntry = { id: string; kind: KnowledgeKind; title: string; body: string };
export type VoiceExample = { id: string; customerSays: string; twinReplies: string };

export type WorkspaceSummary = {
  id: string;
  name: string;
  vertical: string;
  approvalPolicy: "everything" | "money_only" | "nothing";
  channels: string[];
  catalogueSeeded: boolean;
  voice: Voice | null;
  _count: {
    knowledge: number; examples: number; products: number; customers: number;
    connections: number; agentRuns: number;
  };
};

export const DEFAULT_VOICE: Voice = {
  formality: "friendly",
  length: "balanced",
  useEmoji: false,
  signOff: null,
  greeting: null,
  languages: ["English"],
  neverSay: [],
  alwaysSay: [],
};
