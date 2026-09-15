import { apiBaseUrl } from "./api";
import { apiHeaders } from "./session";

export type {
  Formality, Length, KnowledgeKind, Voice, KnowledgeEntry, VoiceExample, WorkspaceSummary,
} from "./twin-types";
export { DEFAULT_VOICE } from "./twin-types";

import type { KnowledgeEntry, VoiceExample, WorkspaceSummary } from "./twin-types";

export async function getWorkspace(): Promise<WorkspaceSummary | null> {
  const res = await fetch(`${apiBaseUrl}/v1/workspaces/current`, {
    headers: await apiHeaders(),
    cache: "no-store",
  });
  if (!res.ok) return null;
  return ((await res.json()) as { workspace: WorkspaceSummary | null }).workspace;
}

export async function getTraining(): Promise<{ knowledge: KnowledgeEntry[]; examples: VoiceExample[] }> {
  const res = await fetch(`${apiBaseUrl}/v1/twin/knowledge`, {
    headers: await apiHeaders(),
    cache: "no-store",
  });
  if (!res.ok) return { knowledge: [], examples: [] };
  return (await res.json()) as { knowledge: KnowledgeEntry[]; examples: VoiceExample[] };
}

