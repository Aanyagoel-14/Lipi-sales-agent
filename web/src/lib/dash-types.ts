import type { ChannelId } from "./channels";

/**
 * Dashboard row shapes and the formatters that render them.
 *
 * Split out of `lib/dash` because that module reaches for `next/headers` to
 * forward the session, which makes it server-only. Client components need the
 * same shapes to append a page of rows, and importing them from `lib/dash`
 * would drag server code into the browser bundle — the leak the module
 * boundary test exists to catch.
 */

export type { ChannelId } from "./channels";

/** A cursor-paged list. `nextCursor` is null on the last page. */
export type Paged<K extends string, T> = { [P in K]: T[] } & { nextCursor: string | null };

export type Kpi = { id: string; label: string; value: number; deltaPct: number | null; unit: "count" | "inr" | "pct" };
export type Signal = { label: string; tone: "neutral" | "violet" | "teal" | "amber" | "magenta" };

export type Customer = {
  id: string; name: string; handle: string; channel: ChannelId;
  segment: "Retail" | "Wholesale" | "Corporate";
  lifetimeValueInr: number; orders: number; avgOrderInr: number; returnRatePct: number;
  priceSensitivity: "Low" | "Medium" | "High"; negotiationStyle: string;
  sizeProfile: string[]; predictedNext: string; riskScore: number; lastSeenIso: string;
};

export type QuoteCard = {
  product: string; variant: string; qty: number;
  unitInr: number; totalInr: number; dispatch: string; eta: string;
};
/** Absent on customer messages, and on agent messages older than delivery tracking. */
export type DeliveryState = "pending" | "sent" | "failed" | "held";

export type Message = {
  from: "customer" | "agent"; text: string; atIso: string; quote?: QuoteCard;
  delivery?: DeliveryState; deliveryError?: string;
};

/** A row in the thread list: one preview line, never the whole thread. */
export type ConversationSummary = {
  id: string; customerId: string; channel: ChannelId; subject: string; unread: boolean;
  lastAtIso: string; intent: string; signals: Signal[];
  messageCount: number; lastMessage: Message | null; customer: Customer | null;
};

/** The open thread, fetched by id. */
export type Conversation = ConversationSummary & { messages: Message[] };

export type Variant = { id: string; optionA: string; optionB: string; stock: number; reserved: number };
export type Product = {
  id: string; name: string; category: string;
  axes: [string, string]; attributes: Record<string, string>;
  priceInr: number; marginPct: number; leadTimeDays: number;
  supplierId: string; crossSell: string[]; variants: Variant[];
};
export type Supplier = {
  id: string; name: string; onTimePct: number; avgLeadDays: number;
  defectRatePct: number; moq: number; responseHours: number;
};

export type Order = {
  id: string; customerId: string; productId: string; variant: string; qty: number;
  valueInr: number; stage: "Quoted" | "Paid" | "Packed" | "Shipped" | "Delivered" | "Returned";
  channel: ChannelId; createdIso: string; blocked?: string; customerName: string; productName: string;
};

export type AgentRun = {
  id: string; agent: string; action: string; conversationId?: string;
  status: "done" | "needs_approval" | "scheduled" | "failed"; durationMs: number; atIso: string;
};

export type Approval = {
  id: string; runId: string; agent: string; summary: string; detail: string;
  impact: string; raisedIso: string; severity: "routine" | "attention" | "policy";
};

export type TwinEvent = { id: string; atIso: string; type: string; twin: string; payload: string };

export type AgeBucket = "not_due" | "late_1_15" | "late_16_30" | "late_30_plus";
export type Invoice = {
  number: string; customerId: string; customerName: string; orderId: string | null;
  source: "quickbooks" | "zoho" | "manual"; issuedIso: string; dueIso: string;
  amountInr: number; receivedInr: number; owedInr: number; daysLate: number;
  status: "paid" | "partial" | "awaiting" | "overdue"; bucket: AgeBucket;
};
export type Payment = {
  id: string; receivedIso: string; customerId: string; customerName: string;
  invoiceNumber: string; method: string; reference: string | null; loggedBy: string;
  amountInr: number; balanceAfterInr: number;
};
export type Ageing = {
  rows: { bucket: AgeBucket; amountInr: number; invoices: number }[];
  totalOutstanding: number; avgDaysToPay: number; settledCount: number;
};

export type Overview = {
  kpis: Kpi[];
  volume: { days: string[]; series: { id: ChannelId; values: number[] }[] };
  intentMix: { intent: string; count: number }[];
  channels: { id: ChannelId; label: string; status: string }[];
  pendingApprovals: number;
  lowStock: { product: string; variant: string; stock: number }[];
  recentEvents: TwinEvent[];
  recentRuns: AgentRun[];
};

/* ------------------------------- formatters ------------------------------- */
/* Pinned to UTC so a server render and a client render agree; a locale
 * timezone here is a hydration mismatch waiting for a user in another one. */

export const inr = (n: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);
export const num = (n: number) => new Intl.NumberFormat("en-IN").format(n);
export const timeOf = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).format(new Date(iso));
export const dayOf = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" }).format(new Date(iso));
