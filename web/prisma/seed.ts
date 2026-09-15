import { PrismaPg } from "@prisma/adapter-pg";
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { hashPassword } from "../src/server/lib/passwords";
import { provisionCatalogue, provisionHistory, provisionKnowledge, provisionVoice } from "../src/server/services/provision";

const DEMO_EMAIL = "demo@lipi.test";
const DEMO_PASSWORD = "lipidemo123";

/**
 * Seeds one demo workspace through the same provisioning path onboarding uses,
 * so a seeded tenant and an onboarded one cannot drift apart.
 */
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

async function main() {
  await prisma.workspace.deleteMany({ where: { name: "Nair Apparel" } });
  await prisma.user.deleteMany({ where: { email: DEMO_EMAIL } });

  const demoUser = await prisma.user.create({
    data: { email: DEMO_EMAIL, name: "Sam Nair", passwordHash: await hashPassword(DEMO_PASSWORD) },
  });

  const workspace = await prisma.$transaction(
    async (tx) => {
      const created = await tx.workspace.create({
        data: {
          name: "Nair Apparel",
          vertical: "apparel",
          channels: ["whatsapp", "telegram", "email", "webchat", "instagram"],
          approvalPolicy: "money_only",
          catalogueSeeded: true,
          onboardedAt: new Date(),
          memberships: { create: { userId: demoUser.id, role: "owner" } },
        },
      });
      await provisionVoice(tx, created.id, created.name);
      await provisionKnowledge(tx, created.id, created.vertical);
      const { products } = await provisionCatalogue(tx, created.id, created.vertical);
      await provisionHistory(tx, created.id, products);
      return created;
    },
    { timeout: 60_000 },
  );

  const counts = {
    products: await prisma.product.count({ where: { workspaceId: workspace.id } }),
    variants: await prisma.variant.count({ where: { product: { workspaceId: workspace.id } } }),
    customers: await prisma.customer.count({ where: { workspaceId: workspace.id } }),
    orders: await prisma.order.count({ where: { workspaceId: workspace.id } }),
    conversations: await prisma.conversation.count({ where: { workspaceId: workspace.id } }),
    invoices: await prisma.invoice.count({ where: { workspaceId: workspace.id } }),
    knowledge: await prisma.knowledgeEntry.count({ where: { workspaceId: workspace.id } }),
    examples: await prisma.voiceExample.count({ where: { workspaceId: workspace.id } }),
  };

  console.log(`  workspace: ${workspace.name} (${workspace.id})`);
  console.log(`  sign in:   ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  console.log(Object.entries(counts).map(([k, v]) => `  ${k}: ${v}`).join("\n"));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
