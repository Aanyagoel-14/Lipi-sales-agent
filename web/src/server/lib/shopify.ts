import { env } from "../env";

/**
 * One place that talks to a Shopify store.
 *
 * Every push connector Lipi has is a system that calls *us*. Shopify is the
 * other direction: it hands out an OAuth token and expects to be polled and
 * webhooked. That asymmetry is the whole reason this module exists — the
 * connector framework already has everything else, and `applySync()` stays
 * the only thing that moves stock.
 *
 * The surface is deliberately the six calls the connector makes and nothing
 * else. Tests swap the whole client through `setShopifyClient`, exactly as
 * `lib/composio.ts` does, so the suite never reaches a real store.
 */

/* ---------------------------------- types --------------------------------- */

export type ShopifyVariant = {
  id: number;
  title: string;
  sku: string | null;
  /** Decimal string in the shop's currency, e.g. "1299.00". */
  price: string;
  option1: string | null;
  option2: string | null;
  option3: string | null;
  /** How Shopify *stocks* this variant. `inventory_levels/update` carries only this. */
  inventory_item_id: number;
  inventory_quantity: number;
};

export type ShopifyProduct = {
  id: number;
  title: string;
  handle: string;
  vendor: string | null;
  product_type: string | null;
  updated_at: string;
  options: { name: string; position: number }[];
  variants: ShopifyVariant[];
};

export type ShopifyLineItem = {
  id: number;
  variant_id: number | null;
  sku: string | null;
  quantity: number;
  /** Per-unit, decimal string, same currency as the order. */
  price: string;
};

export type ShopifyOrder = {
  id: number;
  name: string;
  created_at: string;
  updated_at: string;
  cancelled_at: string | null;
  financial_status: string | null;
  fulfillment_status: string | null;
  /** The first page of the store this buyer landed on, query string included. */
  landing_site: string | null;
  referring_site: string | null;
  customer: {
    id: number;
    email: string | null;
    phone: string | null;
    first_name: string | null;
    last_name: string | null;
  } | null;
  line_items: ShopifyLineItem[];
};

export type ShopifyWebhook = { id: number; topic: string; address: string };

/**
 * What a sync reads, in the shop's own vocabulary. `sinceId` is Shopify's own
 * paging handle — records come back in ascending id, so the last id of a full
 * page is where the next one starts.
 */
export type PullOptions = { updatedAtMin?: string | null; limit?: number; sinceId?: number };

export interface ShopifyClient {
  /** Trades the one-time `code` from the callback for a lasting token. */
  exchangeToken(shop: string, code: string): Promise<{ accessToken: string; scope: string }>;
  products(shop: string, token: string, options: PullOptions): Promise<ShopifyProduct[]>;
  orders(shop: string, token: string, options: PullOptions): Promise<ShopifyOrder[]>;
  listWebhooks(shop: string, token: string): Promise<ShopifyWebhook[]>;
  createWebhook(shop: string, token: string, topic: string, address: string): Promise<ShopifyWebhook>;
  deleteWebhook(shop: string, token: string, id: number): Promise<void>;
}

/* ------------------------------ the shop name ----------------------------- */

/**
 * The shop domain arrives from a form field, a query parameter and a webhook
 * header, and it is then used to build the URL we call. Anything that is not
 * a `*.myshopify.com` host would make this module a request forwarder for
 * whoever typed it, so the shape is checked at every entrance rather than
 * trusted from any of them.
 */
const SHOP = /^[a-z0-9][a-z0-9-]{0,59}\.myshopify\.com$/;

export function normaliseShop(input: string): string | null {
  const bare = input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const shop = bare.includes(".") ? bare : `${bare}.myshopify.com`;
  return SHOP.test(shop) ? shop : null;
}

/** `acme.myshopify.com` -> `acme`, for ids that should read as provenance. */
export const shopSlug = (shop: string) => shop.replace(/\.myshopify\.com$/, "");

/** Where the operator consents. Built here so the shop name is validated once. */
export function authorizeUrl(shop: string, state: string, redirectUri: string): string {
  const query = new URLSearchParams({
    client_id: env.SHOPIFY_API_KEY ?? "",
    scope: env.SHOPIFY_SCOPES,
    redirect_uri: redirectUri,
    state,
  });
  return `https://${shop}/admin/oauth/authorize?${query}`;
}

/* ------------------------------- the client ------------------------------- */

export class ShopifyError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const httpShopify: ShopifyClient = {
  async exchangeToken(shop, code) {
    const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_id: env.SHOPIFY_API_KEY,
        client_secret: env.SHOPIFY_API_SECRET,
        code,
      }),
    });
    const data = (await readJson(response)) as { access_token?: string; scope?: string };
    if (!data.access_token) throw new ShopifyError(response.status, "Shopify returned no access token");
    return { accessToken: data.access_token, scope: data.scope ?? "" };
  },

  async products(shop, token, options) {
    const data = await call<{ products: ShopifyProduct[] }>(shop, token, "GET", "products.json", pullQuery(options));
    return data.products ?? [];
  },

  async orders(shop, token, options) {
    // `status=any` because a cancelled order is still revenue that happened
    // and then un-happened; leaving it out would freeze it at its last state.
    const data = await call<{ orders: ShopifyOrder[] }>(shop, token, "GET", "orders.json", {
      ...pullQuery(options),
      status: "any",
    });
    return data.orders ?? [];
  },

  async listWebhooks(shop, token) {
    const data = await call<{ webhooks: ShopifyWebhook[] }>(shop, token, "GET", "webhooks.json");
    return data.webhooks ?? [];
  },

  async createWebhook(shop, token, topic, address) {
    const data = await call<{ webhook: ShopifyWebhook }>(shop, token, "POST", "webhooks.json", undefined, {
      webhook: { topic, address, format: "json" },
    });
    return data.webhook;
  },

  async deleteWebhook(shop, token, id) {
    await call(shop, token, "DELETE", `webhooks/${id}.json`);
  },
};

function pullQuery({ updatedAtMin, limit, sinceId }: PullOptions): Record<string, string> {
  return {
    limit: String(limit ?? 250),
    ...(updatedAtMin ? { updated_at_min: updatedAtMin } : {}),
    ...(sinceId ? { since_id: String(sinceId) } : {}),
  };
}

async function call<T>(
  shop: string,
  token: string,
  method: string,
  path: string,
  query?: Record<string, string>,
  payload?: unknown,
): Promise<T> {
  const search = query && Object.keys(query).length ? `?${new URLSearchParams(query)}` : "";
  const response = await fetch(`https://${shop}/admin/api/${env.SHOPIFY_API_VERSION}/${path}${search}`, {
    method,
    headers: {
      "X-Shopify-Access-Token": token,
      accept: "application/json",
      ...(payload ? { "content-type": "application/json" } : {}),
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  return (await readJson(response)) as T;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!response.ok) {
    // The body carries Shopify's own reason ("exceeded scope", "not found"),
    // which is the only useful thing to show an operator. Truncated, because
    // an error page is not an error message.
    throw new ShopifyError(response.status, `Shopify answered ${response.status}: ${text.slice(0, 200)}`);
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new ShopifyError(response.status, "Shopify answered with something that was not JSON");
  }
}

let client: ShopifyClient = httpShopify;

export const shopify = () => client;

/** Test seam, matching `setComposioClient`. */
export const setShopifyClient = (replacement: ShopifyClient) => {
  client = replacement;
};
