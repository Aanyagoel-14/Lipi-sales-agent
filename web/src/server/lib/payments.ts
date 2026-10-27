import type { PaymentMethod } from "@/generated/prisma/client";
import { env } from "../env";
import { stripeProviderFor } from "../payments/stripe";
import { invoiceToken } from "./crypto";

/**
 * Checkout links, behind one seam.
 *
 * The PRD wants a checkout link generated when a sale closes (§2 Step 01
 * `Stripe_Invoice`, §3 Phase 2, §6 Use Case 1). What that must NOT mean is a
 * link-shaped string that nobody can pay. A plausible URL that 404s is worse
 * than no URL: the customer believes they have been sent a way to pay, the
 * operator believes the sale is closing, and the first person to find out
 * otherwise is the customer. So the contract here is explicit — a provider
 * either returns a link it can honour, or it returns `null` and says why,
 * and every caller has to render that difference.
 *
 * Three implementations:
 *
 *   stripe    a workspace's own account, connected on the Channels page;
 *             Composio holds the key, makes each payment link and runs the
 *             payment triggers (`server/payments/stripe.ts`)
 *   demo      Lipi's own test checkout, for demonstrating the order flow
 *   none      the default: issues no link and reports `unconfigured`
 *
 * The first is per workspace and the other two are per deployment, so
 * there are two questions: `paymentProvider()` answers "what does this
 * deployment fall back to", and `paymentProviderFor(workspaceId)` answers
 * "what does this shop actually collect through" — its own gateway when it
 * has connected one, the fallback otherwise. Callers that know the invoice
 * ask the second.
 *
 * Swapped for the whole suite by `setPaymentProvider()`, the same seam
 * `setComposioClient` and `setShopifyClient` use, so tests exercise the real
 * calling code with a provider whose answers they control.
 */

export type CheckoutRequest = {
  workspaceId: string;
  /** Integer minor units. Never a float, never a display string. */
  amount: number;
  currency: string;
  /** What the customer sees on the payment page. */
  description: string;
  /** Our own reference, echoed back by the provider's webhook. The invoice number. */
  reference: string;
  /** Who is paying, for the gateway's receipt — whatever is known, nothing required. */
  customer?: { name?: string; email?: string; phone?: string };
  /** When the link should stop taking money. Null or absent leaves it to the provider. */
  expiresAt?: Date | null;
};

export type CheckoutLink = {
  url: string;
  /** The provider's own id for this link, for reconciliation. */
  providerRef: string;
  expiresAt: Date | null;
};

export type CheckoutOutcome =
  | { ok: true; link: CheckoutLink; provider: string }
  | { ok: false; provider: string; reason: string };

/** What a gateway says about a link it issued, when asked. */
export type LinkStatus = {
  status: "open" | "paid" | "expired" | "cancelled";
  /** The gateway's payments against it, in its own method vocabulary. */
  payments: { id: string; amount: number; method: string }[];
};

export type PaymentProvider = {
  name: string;
  /**
   * True when no real money moves through it: the demo page, a test-mode
   * key. The invoice page says so, in words, whenever this is true.
   */
  test: boolean;
  /**
   * True when the link it issues is one to hand to the customer directly — a
   * Stripe payment link goes in the chat message. False when the link is the
   * invoice page itself.
   */
  shareable: boolean;
  /** False when the deployment holds no credential for it. */
  configured(): boolean;
  createCheckoutLink(request: CheckoutRequest): Promise<CheckoutOutcome>;
  /**
   * Asks the gateway about a link, by the `providerRef` it returned — and,
   * when the customer came back carrying one, the gateway's own session for
   * the visit. Present for a gateway that can be asked; absent for one whose
   * word only arrives by webhook.
   */
  lookupLink?(providerRef: string, hint?: { session?: string }): Promise<LinkStatus | null>;
};

/**
 * No provider configured. Honest rather than convenient: it never invents a
 * URL, and the reason it gives names what would fix it, because that is the
 * only actionable thing anybody can do about it.
 */
export const noPaymentProvider: PaymentProvider = {
  name: "none",
  test: false,
  shareable: false,
  configured: () => false,
  async createCheckoutLink() {
    return {
      ok: false,
      provider: "none",
      reason: "No payment provider is configured — connect Stripe on the Channels page",
    };
  },
};

/**
 * Lipi's own test checkout, for demonstrating the order flow before a real
 * provider is connected. The link is the customer's invoice page, whose Pay
 * button settles the invoice through the same `settleInvoice` a provider's
 * webhook would — so the order, the stock and the confirmation message all
 * behave exactly as they will with real money. Nothing is charged, and the
 * page says TEST.
 */
export const demoPaymentProvider: PaymentProvider = {
  name: "demo",
  test: true,
  shareable: false,
  configured: () => env.PAYMENT_PROVIDER === "demo",

  async createCheckoutLink(request) {
    return {
      ok: true,
      provider: "demo",
      link: { url: publicInvoiceUrl(request.reference), providerRef: `demo_${request.reference}`, expiresAt: null },
    };
  },
};

/** Where a customer opens an invoice: the signed page, reachable without an account. */
export const publicInvoiceUrl = (number: string) => `${env.PUBLIC_URL.replace(/\/$/, "")}/i/${invoiceToken(number)}`;

/**
 * A gateway's payment method, in the ledger's vocabulary. Stripe's
 * `payment_method_types` are the reference set (`card`, `upi`, bank debits,
 * wallet rails); anything else is recorded as `other` rather than as the
 * nearest thing it is not.
 */
export function paymentMethodFrom(method: string | undefined): PaymentMethod {
  switch ((method ?? "").toLowerCase()) {
    case "upi": return "upi";
    case "card": case "emi": case "link": return "card";
    case "netbanking": case "bank_transfer": case "customer_balance":
    case "us_bank_account": case "sepa_debit": case "bacs_debit": case "acss_debit":
      return "bank_transfer";
    case "wallet": case "paylater": case "paypay": case "wechat_pay": case "alipay": case "cashapp": case "amazon_pay":
      return "wallet";
    case "cash": return "cash";
    default: return "other";
  }
}

let override: PaymentProvider | null = null;
let fromEnv: PaymentProvider | null = null;

/** The deployment's fallback, decided once from the env. */
export function paymentProvider(): PaymentProvider {
  if (override) return override;
  fromEnv ??= demoPaymentProvider.configured() ? demoPaymentProvider : noPaymentProvider;
  return fromEnv;
}

/**
 * What this workspace collects through: its own gateway when it has one
 * connected and working, the deployment's fallback otherwise. Every path
 * that knows whose invoice it is holding asks this one.
 */
export async function paymentProviderFor(workspaceId: string): Promise<PaymentProvider> {
  if (override) return override;
  return (await stripeProviderFor(workspaceId)) ?? paymentProvider();
}

/** The test seam. Reset by passing `null`. */
export function setPaymentProvider(next: PaymentProvider | null) {
  override = next;
  fromEnv = null;
}
