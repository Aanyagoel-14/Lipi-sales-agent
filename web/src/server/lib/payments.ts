import { env } from "../env";

/**
 * Checkout links, behind one seam.
 *
 * The PRD wants a Stripe checkout link generated when a sale closes (§2 Step
 * 01 `Stripe_Invoice`, §3 Phase 2, §6 Use Case 1). Stripe needs a secret key,
 * and this deployment does not have one.
 *
 * What that must NOT mean is a link-shaped string that nobody can pay. A
 * plausible URL that 404s is worse than no URL: the customer believes they
 * have been sent a way to pay, the operator believes the sale is closing, and
 * the first person to find out otherwise is the customer. So the contract here
 * is explicit — a provider either returns a link it can honour, or it returns
 * `null` and says why, and every caller has to render that difference.
 *
 * Two implementations:
 *
 *   stripe    real, reached only when STRIPE_SECRET_KEY is set
 *   none      the default: issues no link and reports `unconfigured`
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
  /** Our own reference, echoed back by the provider's webhook. */
  reference: string;
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

export type PaymentProvider = {
  name: string;
  /** False when the deployment holds no credential for it. */
  configured(): boolean;
  createCheckoutLink(request: CheckoutRequest): Promise<CheckoutOutcome>;
};

/**
 * No provider configured. Honest rather than convenient: it never invents a
 * URL, and the reason it gives names the environment variable that would fix
 * it, because that is the only actionable thing anybody can do about it.
 */
export const noPaymentProvider: PaymentProvider = {
  name: "none",
  configured: () => false,
  async createCheckoutLink() {
    return {
      ok: false,
      provider: "none",
      reason: "No payment provider is configured — set STRIPE_SECRET_KEY to issue checkout links",
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

let provider: PaymentProvider | null = null;

/** The provider this deployment actually has, decided once from the env. */
export function paymentProvider(): PaymentProvider {
  provider ??= stripePaymentProvider.configured() ? stripePaymentProvider : noPaymentProvider;
  return provider;
}

/** The test seam. Reset by passing `null`. */
export function setPaymentProvider(next: PaymentProvider | null) {
  provider = next;
}
