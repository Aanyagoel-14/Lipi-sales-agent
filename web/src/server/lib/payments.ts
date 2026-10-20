import type { PaymentMethod } from "@/generated/prisma/client";
import { env } from "../env";
import { razorpayProviderFor } from "../payments/razorpay";
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
 * Four implementations:
 *
 *   razorpay  a workspace's own account, connected on the Channels page;
 *             Composio holds the key and creates each payment link
 *             (`server/payments/razorpay.ts`)
 *   stripe    deployment-wide, reached only when STRIPE_SECRET_KEY is set
 *   demo      Lipi's own test checkout, for demonstrating the order flow
 *   none      the default: issues no link and reports `unconfigured`
 *
 * The first is per workspace and the other three are per deployment, so
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
   * Razorpay payment link goes in the chat message. False when the link is a
   * checkout session to be opened from the invoice page, or is the invoice
   * page itself.
   */
  shareable: boolean;
  /** False when the deployment holds no credential for it. */
  configured(): boolean;
  createCheckoutLink(request: CheckoutRequest): Promise<CheckoutOutcome>;
  /**
   * Asks the gateway about a link, by the `providerRef` it returned. Present
   * for a gateway that can be asked; absent for one whose word only arrives
   * by webhook.
   */
  lookupLink?(providerRef: string): Promise<LinkStatus | null>;
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
      reason: "No payment provider is configured — connect Razorpay on the Channels page, or set STRIPE_SECRET_KEY",
    };
  },
};

/**
 * Stripe Checkout Sessions.
 *
 * One `fetch`, form-encoded, because that is what Stripe's API takes and
 * pulling in the SDK for a single endpoint would add a dependency that has to
 * be kept current for no benefit. Amounts go out in the minor units they are
 * already stored in, so nothing is converted anywhere in this path.
 */
export const stripePaymentProvider: PaymentProvider = {
  name: "stripe",
  get test() { return Boolean(env.STRIPE_SECRET_KEY?.startsWith("sk_test_")); },
  shareable: false,
  configured: () => Boolean(env.STRIPE_SECRET_KEY),

  async createCheckoutLink(request) {
    if (!env.STRIPE_SECRET_KEY) {
      return { ok: false, provider: "stripe", reason: "STRIPE_SECRET_KEY is not set" };
    }

    const form = new URLSearchParams({
      mode: "payment",
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": request.currency.toLowerCase(),
      "line_items[0][price_data][unit_amount]": String(request.amount),
      "line_items[0][price_data][product_data][name]": request.description,
      client_reference_id: request.reference,
      success_url: `${env.PUBLIC_URL}/checkout/done?ref=${encodeURIComponent(request.reference)}`,
      cancel_url: `${env.PUBLIC_URL}/checkout/cancelled?ref=${encodeURIComponent(request.reference)}`,
    });

    try {
      const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
          "Content-Type": "application/x-www-form-urlencoded",
          // Stripe de-duplicates on this, so a retried skill execution cannot
          // create a second session for the same order.
          "Idempotency-Key": `lipi_${request.workspaceId}_${request.reference}`,
        },
        body: form,
        signal: AbortSignal.timeout(10_000),
      });

      const payload = (await response.json().catch(() => ({}))) as {
        url?: string;
        id?: string;
        expires_at?: number;
        error?: { message?: string };
      };

      if (!response.ok || !payload.url || !payload.id) {
        return {
          ok: false,
          provider: "stripe",
          reason: payload.error?.message ?? `Stripe answered ${response.status}`,
        };
      }

      return {
        ok: true,
        provider: "stripe",
        link: {
          url: payload.url,
          providerRef: payload.id,
          expiresAt: payload.expires_at ? new Date(payload.expires_at * 1000) : null,
        },
      };
    } catch (error) {
      return {
        ok: false,
        provider: "stripe",
        reason: error instanceof Error ? error.message : "Stripe was unreachable",
      };
    }
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
 * A gateway's payment method, in the ledger's vocabulary. Razorpay's names
 * are the reference set (`upi`, `card`, `netbanking`, `wallet`, `emi`,
 * `paylater`, `bank_transfer`); anything else is recorded as `other` rather
 * than as the nearest thing it is not.
 */
export function paymentMethodFrom(method: string | undefined): PaymentMethod {
  switch ((method ?? "").toLowerCase()) {
    case "upi": return "upi";
    case "card": case "emi": return "card";
    case "netbanking": case "bank_transfer": return "bank_transfer";
    case "wallet": case "paylater": return "wallet";
    case "cash": return "cash";
    default: return "other";
  }
}

let override: PaymentProvider | null = null;
let fromEnv: PaymentProvider | null = null;

/** The deployment's fallback, decided once from the env. A real one always wins over the demo. */
export function paymentProvider(): PaymentProvider {
  if (override) return override;
  fromEnv ??= stripePaymentProvider.configured() ? stripePaymentProvider
    : demoPaymentProvider.configured() ? demoPaymentProvider
    : noPaymentProvider;
  return fromEnv;
}

/**
 * What this workspace collects through: its own gateway when it has one
 * connected and working, the deployment's fallback otherwise. Every path
 * that knows whose invoice it is holding asks this one.
 */
export async function paymentProviderFor(workspaceId: string): Promise<PaymentProvider> {
  if (override) return override;
  return (await razorpayProviderFor(workspaceId)) ?? paymentProvider();
}

/** The test seam. Reset by passing `null`. */
export function setPaymentProvider(next: PaymentProvider | null) {
  override = next;
  fromEnv = null;
}
