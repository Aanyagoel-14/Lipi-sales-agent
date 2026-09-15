import { toRupees } from "@/server/lib/money";

/* Row shapes are converted here so the API contract stays in whole rupees and
 * ISO strings, exactly what the dashboard already consumes. */

export const customerOut = (c: {
  id: string; name: string; handle: string; channel: string; segment: string;
  lifetimeValue: number; orderCount: number; avgOrderValue: number; returnRatePct: number;
  priceSensitivity: string; negotiationStyle: string; sizeProfile: string[];
  predictedNext: string; riskScore: number; lastSeenAt: Date;
}) => ({
  id: c.id, name: c.name, handle: c.handle, channel: c.channel, segment: c.segment,
  lifetimeValueInr: toRupees(c.lifetimeValue), orders: c.orderCount,
  avgOrderInr: toRupees(c.avgOrderValue), returnRatePct: c.returnRatePct,
  priceSensitivity: c.priceSensitivity, negotiationStyle: c.negotiationStyle,
  sizeProfile: c.sizeProfile, predictedNext: c.predictedNext, riskScore: c.riskScore,
  lastSeenIso: c.lastSeenAt.toISOString(),
});

export const messageOut = (m: { from: string; text: string; sentAt: Date; quote: unknown }) => ({
  from: m.from, text: m.text, atIso: m.sentAt.toISOString(), quote: m.quote ?? undefined,
});

export const eventOut = (e: { id: string; occurredAt: Date; type: string; twin: string; payload: string }) => ({
  id: e.id, atIso: e.occurredAt.toISOString(), type: e.type, twin: e.twin, payload: e.payload,
});

export const runOut = (r: {
  id: string; agent: string; action: string; status: string;
  durationMs: number; ranAt: Date; conversationId: string | null;
}) => ({
  id: r.id, agent: r.agent, action: r.action, status: r.status,
  durationMs: r.durationMs, atIso: r.ranAt.toISOString(),
  conversationId: r.conversationId ?? undefined,
});
