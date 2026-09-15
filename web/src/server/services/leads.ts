import type { Customer } from "@/generated/prisma/client";

/**
 * Lead scoring (Req 2).
 *
 * Recomputed synchronously at the end of every `ingest()` call, inside the
 * same transaction that already knows what this message did — so the score
 * is never stale by more than one message, and never needs its own
 * background job to stay current.
 *
 * This is deliberately a different number from `riskScore` (which already
 * existed): `riskScore` speaks to churn/return risk on an *existing*
 * customer relationship, while `leadScore` speaks to "how close is this
 * conversation, right now, to becoming an order" — the question a growth
 * operator triaging a lead list actually has. A high-value repeat customer
 * asking a routine shipping question scores low here even though their
 * `riskScore` is fine, because nothing in *this* message signals imminent
 * purchase intent.
 */

const INTENT_WEIGHT: Record<string, number> = {
  buy: 20,
  purchase_order: 25,
  quote_request: 15,
  inventory_request: 8,
  return: -5,
  complaint: -10,
};

export type LeadStage = "visitor" | "engaged" | "qualified" | "customer";

export type LeadSignal = {
  previousScore: number;
  intent: string;
  matchedProduct: boolean;
  quantity: number | null;
  justOrdered: boolean;
  orderCount: number;
};

/**
 * A customer row only exists once someone has messaged, so `visitor` (a
 * page-load with no message yet) is a `VisitorSession`-only state — it never
 * appears here. `customer` is sticky: once an order has ever been placed,
 * a later routine question does not demote the stage back to `engaged`,
 * because the business relationship that stage describes is real and past.
 */
export function scoreLead(signal: LeadSignal): { score: number; stage: LeadStage } {
  let score = signal.previousScore;

  // Every message is some engagement; a matched, quantified ask more so.
  score += 4;
  score += INTENT_WEIGHT[signal.intent] ?? 0;
  if (signal.matchedProduct) score += 10;
  if (signal.quantity && signal.quantity >= 10) score += 10;
  if (signal.justOrdered) score += 30;

  // Undecided drift back toward neutral over repeated low-signal contact,
  // so a lead who only ever says "hi" does not creep toward "qualified"
  // purely by messaging often.
  if (!(signal.intent in INTENT_WEIGHT) || INTENT_WEIGHT[signal.intent] === undefined) score -= 2;

  score = Math.max(0, Math.min(100, Math.round(score)));

  const stage: LeadStage =
    signal.justOrdered || signal.orderCount > 0 ? "customer" : score >= 55 ? "qualified" : "engaged";

  return { score, stage };
}

/** Only fields `scoreLead` needs off the customer row, kept narrow so a
 *  caller does not have to fetch (or mock) the whole `Customer`. */
export type ScorableCustomer = Pick<Customer, "leadScore" | "orderCount">;
