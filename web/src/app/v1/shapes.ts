import type { z } from "zod";
import { toRupees } from "@/server/lib/money";
import { type AttributionTouch, hasAttribution } from "@/server/services/attribution";
import type {
  conversationShape, conversationSummaryShape, conversionShape, customerShape,
  eventShape, messageShape, productShape, quoteShape,
} from "./contract";

/* Row shapes are converted here so the API contract stays in whole rupees and
 * ISO strings, exactly what the dashboard already consumes.
 *
 * Each projection's return type is the Zod schema `contract.ts` publishes for
 * it, so a field added here without being described there — or described with
 * the wrong type — fails typecheck rather than shipping undocumented. */

type Out<T extends z.ZodTypeAny> = z.infer<T>;

/* Row columns are typed as the contract's own unions rather than `string`.
 * Prisma's generated enums are unions of the same members, so they assign
 * straight in, and a column the schema does not cover fails here instead of
 * being cast into shape on the way out. */
type Channel = Out<typeof customerShape>["channel"];
type Delivery = NonNullable<Out<typeof messageShape>["delivery"]>;

export const customerOut = (c: {
  id: string; name: string; handle: string; channel: Channel;
  segment: Out<typeof customerShape>["segment"];
  lifetimeValue: number; orderCount: number; avgOrderValue: number; returnRatePct: number;
  priceSensitivity: Out<typeof customerShape>["priceSensitivity"];
  negotiationStyle: string; sizeProfile: string[];
  predictedNext: string; riskScore: number; lastSeenAt: Date;
}): Out<typeof customerShape> => ({
  id: c.id, name: c.name, handle: c.handle, channel: c.channel, segment: c.segment,
  lifetimeValueInr: toRupees(c.lifetimeValue), orders: c.orderCount,
  avgOrderInr: toRupees(c.avgOrderValue), returnRatePct: c.returnRatePct,
  priceSensitivity: c.priceSensitivity, negotiationStyle: c.negotiationStyle,
  sizeProfile: c.sizeProfile, predictedNext: c.predictedNext, riskScore: c.riskScore,
  lastSeenIso: c.lastSeenAt.toISOString(),
});

export const messageOut = (m: {
  from: string; text: string; sentAt: Date; quote: unknown;
  deliveryStatus: Delivery | "not_applicable"; deliveryError: string | null;
}): Out<typeof messageShape> => ({
  from: m.from, text: m.text, atIso: m.sentAt.toISOString(),
  quote: (m.quote ?? undefined) as Out<typeof quoteShape> | undefined,
  // Only agent messages carry a delivery state; a customer's message was
  // never ours to deliver, so the field is left off rather than sent as a
  // status the inbox would have to know to ignore.
  ...(m.deliveryStatus === "not_applicable"
    ? {}
    : { delivery: m.deliveryStatus, deliveryError: m.deliveryError ?? undefined }),
});

type ConversationRow = {
  id: string; customerId: string; channel: Channel; subject: string; unread: boolean;
  lastAt: Date; intent: string; signals: unknown;
  customer: Parameters<typeof customerOut>[0];
};

type Signals = Out<typeof conversationShape>["signals"];

/** The fields a thread list row and an open thread agree on. */
const conversationCommon = (c: ConversationRow, messageCount: number) => ({
  id: c.id, customerId: c.customerId, channel: c.channel,
  subject: c.subject, unread: c.unread, lastAtIso: c.lastAt.toISOString(),
  intent: c.intent, signals: (c.signals ?? []) as Signals,
  messageCount,
  customer: customerOut(c.customer),
});

export const conversationSummaryOut = (
  c: ConversationRow & { messageCount: number; lastMessage: Parameters<typeof messageOut>[0] | undefined },
): Out<typeof conversationSummaryShape> => ({
  ...conversationCommon(c, c.messageCount),
  lastMessage: c.lastMessage ? messageOut(c.lastMessage) : null,
});

export const conversationOut = (
  c: ConversationRow & { messages: Parameters<typeof messageOut>[0][] },
): Out<typeof conversationShape> => ({
  ...conversationCommon(c, c.messages.length),
  messages: c.messages.map(messageOut),
});

export const variantOut = (v: {
  id: string; optionA: string; optionB: string; stock: number; reserved: number;
}) => ({
  // The id is what an inventory mapping points at, so it has to leave
  // the API; a variant is not addressable by its option pair alone.
  id: v.id, optionA: v.optionA, optionB: v.optionB, stock: v.stock, reserved: v.reserved,
});

export const productOut = (p: {
  id: string; name: string; category: string; axes: string[]; attributes: unknown;
  price: number; marginPct: number; leadTimeDays: number; supplierId: string;
  crossSell: string[]; variants: Parameters<typeof variantOut>[0][];
}): Out<typeof productShape> => ({
  id: p.id, name: p.name, category: p.category,
  axes: p.axes as [string, string],
  attributes: (p.attributes ?? {}) as Record<string, string>,
  priceInr: toRupees(p.price), marginPct: p.marginPct, leadTimeDays: p.leadTimeDays,
  supplierId: p.supplierId, crossSell: p.crossSell,
  variants: p.variants.map(variantOut),
});

export const eventOut = (e: {
  id: string; occurredAt: Date; type: string; twin: string; payload: string;
}): Out<typeof eventShape> => ({
  id: e.id, atIso: e.occurredAt.toISOString(), type: e.type, twin: e.twin, payload: e.payload,
});

/** The eight first-touch columns `services/attribution.ts` writes, plus when. */
type AttributionRow = AttributionTouch & { firstTouchAt: Date | null };

/**
 * An order as a conversion: the paise are exact, and the customer's
 * first-touch attribution rides along so an external funnel can close the
 * loop back to the ad that paid for the visitor without a second call.
 */
export const conversionOut = (o: {
  id: string; createdAt: Date; customerId: string; productId: string; variant: string;
  qty: number; value: number; stage: Out<typeof conversionShape>["stage"]; channel: Channel;
  customer: AttributionRow;
}): Out<typeof conversionShape> => ({
  id: o.id, occurredIso: o.createdAt.toISOString(),
  customerId: o.customerId, productId: o.productId, variant: o.variant, qty: o.qty,
  valuePaise: o.value, valueInr: toRupees(o.value),
  stage: o.stage, channel: o.channel,
  attribution: attributionOut(o.customer),
});

/** Null rather than nine nulls: a customer who never arrived via a tracked link.
 *  `hasAttribution` is the same test that decided whether to write the row, so
 *  the two cannot disagree about what counts as a tracked arrival. */
function attributionOut(c: AttributionRow): Out<typeof conversionShape>["attribution"] {
  if (!c.firstTouchAt && !hasAttribution(c)) return null;
  return {
    utmSource: c.utmSource, utmMedium: c.utmMedium, utmCampaign: c.utmCampaign,
    utmTerm: c.utmTerm, utmContent: c.utmContent, adClickId: c.adClickId,
    landingPage: c.landingPage, referrer: c.referrer,
    firstTouchIso: c.firstTouchAt?.toISOString() ?? null,
  };
}

export const runOut = (r: {
  id: string; agent: string; action: string; status: string;
  durationMs: number; ranAt: Date; conversationId: string | null;
}) => ({
  id: r.id, agent: r.agent, action: r.action, status: r.status,
  durationMs: r.durationMs, atIso: r.ranAt.toISOString(),
  conversationId: r.conversationId ?? undefined,
});
