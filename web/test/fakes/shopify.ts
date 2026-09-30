import { createHmac } from "node:crypto";
import type {
  PullOptions,
  ShopifyClient,
  ShopifyOrder,
  ShopifyProduct,
  ShopifyVariant,
  ShopifyWebhook,
} from "@/server/lib/shopify";

/**
 * A Shopify store that exists only in memory.
 *
 * It holds products, orders and webhook subscriptions the way the real one
 * does, answers `updated_at_min` the way the real one does, and records every
 * call so a test can assert what the connector asked for. Nothing here reaches
 * the network — the suite must never touch a real store, and a fake that can
 * only be reached through `setShopifyClient` is how that stays true.
 *
 *   fake.storeProducts.push(productFixture(...))   what a sync will find
 *   fake.storeOrders.push(orderFixture(...))       what an order import will find
 *   fake.calls.products / .orders / …              what happened, in order
 *   fake.sign(body)                                a valid webhook signature
 */
export class FakeShopify implements ShopifyClient {
  /** The one Shopify app the deployment owns, as the suite configures it. */
  apiSecret = "test-shopify-api-secret";
  storeProducts: ShopifyProduct[] = [];
  storeOrders: ShopifyOrder[] = [];
  webhooks: ShopifyWebhook[] = [];
  /** Codes the fake will trade for a token, and what it hands back. */
  token = "shpat_test_token";
  scope = "read_products,read_inventory,read_orders";
  /** Set to make the next call of that kind throw, the way a 401 would. */
  failWith: Error | null = null;

  calls = {
    exchangeToken: [] as { shop: string; code: string }[],
    products: [] as { shop: string; token: string; options: PullOptions }[],
    orders: [] as { shop: string; token: string; options: PullOptions }[],
    listWebhooks: [] as string[],
    createWebhook: [] as { shop: string; topic: string; address: string }[],
    deleteWebhook: [] as { shop: string; id: number }[],
  };

  private nextWebhookId = 900_001;

  reset() {
    this.apiSecret = "test-shopify-api-secret";
    this.storeProducts = [];
    this.storeOrders = [];
    this.webhooks = [];
    this.token = "shpat_test_token";
    this.scope = "read_products,read_inventory,read_orders";
    this.failWith = null;
    this.nextWebhookId = 900_001;
    for (const key of Object.keys(this.calls) as (keyof FakeShopify["calls"])[]) {
      this.calls[key].length = 0;
    }
  }

  private check() {
    const error = this.failWith;
    if (error) {
      this.failWith = null;
      throw error;
    }
  }

  async exchangeToken(shop: string, code: string) {
    this.check();
    this.calls.exchangeToken.push({ shop, code });
    return { accessToken: this.token, scope: this.scope };
  }

  async products(shop: string, token: string, options: PullOptions) {
    this.check();
    this.calls.products.push({ shop, token, options });
    return since(this.storeProducts, options);
  }

  async orders(shop: string, token: string, options: PullOptions) {
    this.check();
    this.calls.orders.push({ shop, token, options });
    return since(this.storeOrders, options);
  }

  async listWebhooks(shop: string) {
    this.check();
    this.calls.listWebhooks.push(shop);
    return [...this.webhooks];
  }

  async createWebhook(shop: string, _token: string, topic: string, address: string) {
    this.check();
    this.calls.createWebhook.push({ shop, topic, address });
    const webhook = { id: this.nextWebhookId++, topic, address };
    this.webhooks.push(webhook);
    return webhook;
  }

  async deleteWebhook(shop: string, _token: string, id: number) {
    this.check();
    this.calls.deleteWebhook.push({ shop, id });
    this.webhooks = this.webhooks.filter((w) => w.id !== id);
  }

  /** `X-Shopify-Hmac-Sha256` for a body, as Shopify would compute it. */
  sign(body: string) {
    return createHmac("sha256", this.apiSecret).update(Buffer.from(body, "utf8")).digest("base64");
  }
}

/** Filtered, then paged the way Shopify pages: ascending id, from `sinceId`. */
const since = <T extends { id: number; updated_at: string }>(
  rows: T[],
  { updatedAtMin, limit, sinceId }: PullOptions,
) =>
  rows
    .filter((row) => !updatedAtMin || row.updated_at >= updatedAtMin)
    .filter((row) => !sinceId || row.id > sinceId)
    .sort((a, b) => a.id - b.id)
    .slice(0, limit ?? 250);

export const fakeShopify = new FakeShopify();

/* -------------------------------- fixtures -------------------------------- */

let sequence = 0;
const nextId = () => 8_000_000 + ++sequence;

export function variantFixture(overrides: Partial<ShopifyVariant> = {}): ShopifyVariant {
  const id = overrides.id ?? nextId();
  return {
    id,
    title: "M / Cobalt",
    sku: `SHOP-${id}`,
    price: "1299.00",
    option1: "M",
    option2: "Cobalt",
    option3: null,
    inventory_item_id: id + 500_000,
    inventory_quantity: 12,
    ...overrides,
  };
}

export function productFixture(overrides: Partial<ShopifyProduct> = {}): ShopifyProduct {
  return {
    id: overrides.id ?? nextId(),
    title: "Cotton Polo",
    handle: "cotton-polo",
    vendor: "Acme Mills",
    product_type: "Shirts",
    updated_at: "2026-09-19T10:00:00Z",
    options: [
      { name: "Size", position: 1 },
      { name: "Colour", position: 2 },
    ],
    variants: [variantFixture()],
    ...overrides,
  };
}

export function orderFixture(overrides: Partial<ShopifyOrder> = {}): ShopifyOrder {
  const id = overrides.id ?? nextId();
  return {
    id,
    name: `#${id}`,
    created_at: "2026-09-19T11:00:00Z",
    updated_at: "2026-09-19T11:00:00Z",
    cancelled_at: null,
    financial_status: "paid",
    fulfillment_status: null,
    landing_site: "/collections/polos?utm_source=google&utm_medium=cpc&gclid=abc123",
    referring_site: "https://www.google.com/",
    customer: { id: 5_100_001, email: "buyer@example.com", phone: null, first_name: "Riya", last_name: "Nair" },
    line_items: [],
    ...overrides,
  };
}
