import { z } from "zod";
import { body, json, route } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { requireUser } from "@/server/lib/session";
import { provisionCatalogue, provisionVoice } from "@/server/services/provision";

const createSchema = z.object({
  name: z.string().trim().min(2).max(80),
  vertical: z.enum(["apparel", "auto_parts", "marine", "wholesale"]),
  channels: z.array(z.enum(["whatsapp", "instagram", "facebook", "telegram", "email", "webchat"])).min(1),
  approvalPolicy: z.enum(["everything", "money_only", "nothing"]),
  seedCatalogue: z.boolean(),
});

/**
 * Onboarding provisions a working tenant, not just a row: the workspace, its
 * default voice, and optionally a sample catalogue. Business knowledge must
 * be confirmed by the operator rather than installed as plausible defaults.
 * Business activity is never fabricated: a new workspace must remain genuinely
 * empty until data is imported or real conversations arrive.
 */
export const POST = route(async (req) => {
  const user = await requireUser();
  const data = await body(req, createSchema, "Invalid workspace");

  const { seedCatalogue, ...fields } = data;

  const workspace = await prisma.$transaction(
    async (tx) => {
      const created = await tx.workspace.create({
        data: {
          ...fields,
          catalogueSeeded: seedCatalogue,
          // Left null until the wizard is finished, so an abandoned setup
          // can be resumed rather than silently half-applied.
          onboardedAt: null,
          memberships: { create: { userId: user.userId, role: "owner" } },
        },
      });

      await provisionVoice(tx, created.id, created.name);
      if (seedCatalogue) {
        await provisionCatalogue(tx, created.id, created.vertical);
      }

      return created;
    },
    { timeout: 30_000 },
  );

  return json({ workspace, provisioned: await countsFor(workspace.id) }, 201);
});

async function countsFor(workspaceId: string) {
  const [products, variants, customers, orders, knowledge, examples] = await Promise.all([
    prisma.product.count({ where: { workspaceId } }),
    prisma.variant.count({ where: { product: { workspaceId } } }),
    prisma.customer.count({ where: { workspaceId } }),
    prisma.order.count({ where: { workspaceId } }),
    prisma.knowledgeEntry.count({ where: { workspaceId } }),
    prisma.voiceExample.count({ where: { workspaceId } }),
  ]);
  return { products, variants, customers, orders, knowledge, examples };
}
