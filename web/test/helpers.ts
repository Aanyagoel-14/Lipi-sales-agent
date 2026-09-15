import { prisma } from "@/server/lib/prisma";
import { hashPassword } from "@/server/lib/passwords";
import { provisionCatalogue, provisionKnowledge, provisionVoice } from "@/server/services/provision";
import type { Vertical } from "@/server/services/catalogues";

export { agent } from "./dispatch";
import { agent } from "./dispatch";

/** Order matters: children before parents, because the schema has real keys. */
export async function resetDatabase() {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      payments, invoices, approvals, agent_runs, messages, conversations,
      inventory_exceptions, inventory_sync_runs, inventory_mappings,
      inventory_connectors,
      processed_messages,
      orders, variants, products, suppliers, customers, twin_events,
      knowledge_entries, voice_examples, twin_voice, channel_connections,
      sessions, memberships, workspaces, users, waitlist_entries
    RESTART IDENTITY CASCADE
  `);
}

export async function createUser(email = "owner@test.local", password = "testing12345") {
  const user = await prisma.user.create({
    data: { email, name: "Test Owner", passwordHash: await hashPassword(password) },
  });
  return { user, email, password };
}

/** A workspace with a catalogue, voice and knowledge, owned by `userId`. */
export async function createWorkspace(opts: {
  userId: string;
  name?: string;
  vertical?: Vertical;
  policy?: "everything" | "money_only" | "nothing";
  withCatalogue?: boolean;
}) {
  const vertical = opts.vertical ?? "apparel";

  const workspace = await prisma.workspace.create({
    data: {
      name: opts.name ?? "Test Co",
      vertical,
      channels: ["whatsapp"],
      approvalPolicy: opts.policy ?? "money_only",
      onboardedAt: new Date(),
      memberships: { create: { userId: opts.userId, role: "owner" } },
    },
  });

  await provisionVoice(prisma, workspace.id, workspace.name);
  await provisionKnowledge(prisma, workspace.id, vertical);
  if (opts.withCatalogue !== false) await provisionCatalogue(prisma, workspace.id, vertical);

  return workspace;
}

/** A logged-in agent whose cookie jar persists across requests. */
export async function signedIn(email = "owner@test.local", password = "testing12345") {
  const a = agent();
  await a.post("/v1/auth/login").send({ email, password }).expect(200);
  return a;
}
