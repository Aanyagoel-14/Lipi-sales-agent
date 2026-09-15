import { apiFetch } from "./client";

export type Vertical = "apparel" | "auto_parts" | "marine" | "wholesale";
export type ChannelKey = "whatsapp" | "telegram" | "email" | "webchat" | "instagram";
export type Policy = "everything" | "money_only" | "nothing";

export type WorkspaceDraft = {
  name: string;
  vertical: Vertical;
  channels: ChannelKey[];
  approvalPolicy: Policy;
  seedCatalogue: boolean;
};

export type Workspace = WorkspaceDraft & {
  id: string;
  catalogueSeeded: boolean;
  onboardedAt: string | null;
};

/** What the API actually built, so the wizard can report it rather than guess. */
export type Provisioned = {
  products: number;
  variants: number;
  customers: number;
  orders: number;
  knowledge: number;
  examples: number;
};

export type CatalogueImportRow = {
  product: string;
  category: string;
  axisAName: string;
  axisAValue: string;
  axisBName: string;
  axisBValue: string;
  priceInr: number;
  stock: number;
  marginPct: number;
  leadTimeDays: number;
};

export async function createWorkspace(draft: WorkspaceDraft): Promise<{ workspace: Workspace; provisioned: Provisioned }> {
  const res = await apiFetch("workspaces", { method: "POST", body: JSON.stringify(draft) });

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? "Could not create the workspace.");
  }

  return (await res.json()) as { workspace: Workspace; provisioned: Provisioned };
}

/** The id is the tenant every API read carries; the name is only for display. */
export const WORKSPACE_ID_COOKIE = "lipi_workspace_id";
export const WORKSPACE_COOKIE = "lipi_workspace";
