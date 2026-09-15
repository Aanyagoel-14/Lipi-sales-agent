import { json, route } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { connectedChannels, conversationVolume, intentMix, overviewKpis } from "@/server/services/analytics";
import { eventOut, runOut } from "../../shapes";

export const GET = route(async () => {
  const workspaceId = await resolveWorkspaceId();
  const [kpis, volume, mix, channels, lowVariants, pendingApprovals, events, runs] = await Promise.all([
    overviewKpis(workspaceId),
    conversationVolume(workspaceId),
    intentMix(workspaceId),
    connectedChannels(workspaceId),
    prisma.variant.findMany({
      // Variants are scoped through their product, not directly.
      where: { stock: { lte: 2 }, product: { workspaceId } },
      include: { product: { select: { name: true } } },
      orderBy: [{ stock: "asc" }],
      take: 8,
    }),
    prisma.approval.count({ where: { workspaceId } }),
    prisma.twinEvent.findMany({ where: { workspaceId }, orderBy: { occurredAt: "desc" }, take: 8 }),
    prisma.agentRun.findMany({ where: { workspaceId }, orderBy: { ranAt: "desc" }, take: 6 }),
  ]);

  return json({
    kpis,
    volume,
    intentMix: mix,
    channels,
    pendingApprovals,
    lowStock: lowVariants.map((v) => ({
      product: v.product.name,
      variant: `${v.optionA} / ${v.optionB}`,
      stock: v.stock,
    })),
    recentEvents: events.map(eventOut),
    recentRuns: runs.map(runOut),
  });
});
