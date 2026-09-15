import { prisma } from "../lib/prisma";
import { toRupees } from "../lib/money";
import type { Channel } from "@/generated/prisma/client";

/**
 * Every figure on the overview is counted from the workspace's own rows.
 *
 * Where there is no prior period to compare against, the change is null and
 * the tile says so rather than showing an invented percentage. A dashboard
 * that makes up its own numbers is worse than one that admits it is new.
 */

const DAY = 86_400_000;
const CHANNELS: Channel[] = ["whatsapp", "instagram", "telegram", "email", "webchat"];

const change = (now: number, before: number): number | null => {
  if (before === 0) return null;
  return Math.round(((now - before) / before) * 1000) / 10;
};

export async function overviewKpis(workspaceId: string, now = new Date()) {
  const weekAgo = new Date(now.getTime() - 7 * DAY);
  const twoWeeksAgo = new Date(now.getTime() - 14 * DAY);

  const [
    conversationsWeek, conversationsPrev,
    eventsWeek, eventsPrev,
    openOrders, openOrdersPrev,
    quoted, quotedPrev,
    runsDone, runsHeld,
  ] = await Promise.all([
    prisma.conversation.count({ where: { workspaceId, lastAt: { gte: weekAgo } } }),
    prisma.conversation.count({ where: { workspaceId, lastAt: { gte: twoWeeksAgo, lt: weekAgo } } }),
    prisma.twinEvent.count({ where: { workspaceId, occurredAt: { gte: weekAgo } } }),
    prisma.twinEvent.count({ where: { workspaceId, occurredAt: { gte: twoWeeksAgo, lt: weekAgo } } }),
    prisma.order.count({ where: { workspaceId, stage: { notIn: ["Delivered", "Returned"] } } }),
    prisma.order.count({ where: { workspaceId, stage: { notIn: ["Delivered", "Returned"] }, createdAt: { lt: weekAgo } } }),
    prisma.order.aggregate({ _sum: { value: true }, where: { workspaceId, stage: "Quoted" } }),
    prisma.order.aggregate({ _sum: { value: true }, where: { workspaceId, stage: "Quoted", createdAt: { lt: weekAgo } } }),
    prisma.agentRun.count({ where: { workspaceId, status: "done" } }),
    prisma.agentRun.count({ where: { workspaceId, status: { in: ["needs_approval", "failed"] } } }),
  ]);

  const totalRuns = runsDone + runsHeld;
  const autonomy = totalRuns ? Math.round((runsDone / totalRuns) * 1000) / 10 : null;

  return [
    { id: "conversations", label: "Conversations this week", value: conversationsWeek, deltaPct: change(conversationsWeek, conversationsPrev), unit: "count" as const },
    { id: "twin_updates", label: "Twin updates", value: eventsWeek, deltaPct: change(eventsWeek, eventsPrev), unit: "count" as const },
    { id: "orders_open", label: "Open orders", value: openOrders, deltaPct: change(openOrders, openOrdersPrev), unit: "count" as const },
    { id: "quoted_value", label: "Value quoted", value: toRupees(quoted._sum.value ?? 0), deltaPct: change(quoted._sum.value ?? 0, quotedPrev._sum.value ?? 0), unit: "inr" as const },
    { id: "autonomy", label: "Handled without a human", value: autonomy ?? 0, deltaPct: null, unit: "pct" as const },
  ];
}

/** Conversation volume per channel over the last fortnight, counted per day. */
export async function conversationVolume(workspaceId: string, now = new Date()) {
  const start = new Date(now.getTime() - 13 * DAY);
  start.setUTCHours(0, 0, 0, 0);

  const rows = await prisma.conversation.findMany({
    where: { workspaceId, lastAt: { gte: start } },
    select: { channel: true, lastAt: true },
  });

  const days = Array.from({ length: 14 }, (_, i) =>
    new Date(start.getTime() + i * DAY).toISOString().slice(0, 10),
  );
  const index = new Map(days.map((d, i) => [d, i]));

  const series = CHANNELS.map((id) => ({ id, values: Array(14).fill(0) as number[] }));
  const byChannel = new Map(series.map((s) => [s.id, s]));

  for (const row of rows) {
    const i = index.get(row.lastAt.toISOString().slice(0, 10));
    const s = byChannel.get(row.channel);
    if (i !== undefined && s) s.values[i]! += 1;
  }

  return { days, series };
}

const INTENT_LABELS: Record<string, string> = {
  buy: "Buy",
  inventory_request: "Inventory request",
  quote_request: "Quote request",
  support: "Support",
  return: "Return / exchange",
  purchase_order: "Purchase order",
  complaint: "Complaint",
  other: "Unclassified",
};

export async function intentMix(workspaceId: string) {
  const grouped = await prisma.conversation.groupBy({
    by: ["intent"],
    where: { workspaceId },
    _count: { intent: true },
  });

  return grouped
    .map((g) => ({ intent: INTENT_LABELS[g.intent] ?? g.intent, count: g._count.intent }))
    .sort((a, b) => b.count - a.count);
}

/** Channels the workspace actually connected during onboarding. */
export async function connectedChannels(workspaceId: string) {
  const labels: Record<Channel, string> = {
    whatsapp: "WhatsApp", instagram: "Instagram", telegram: "Telegram",
    email: "Email", webchat: "Website chat",
  };
  const rows = await prisma.channelConnection.findMany({ where: { workspaceId }, orderBy: { createdAt: "asc" } });
  return rows.map((row) => ({
    id: row.channel,
    label: labels[row.channel],
    status: row.status,
  }));
}
