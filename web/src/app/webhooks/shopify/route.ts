import { env } from "@/server/env";
import { verifyShopifyWebhook } from "@/server/lib/crypto";
import { prisma } from "@/server/lib/prisma";
import { normaliseShop, type ShopifyProduct } from "@/server/lib/shopify";
import { onInventoryLevel, onProductUpdate } from "@/server/services/shopify";

/**
 * Every Shopify delivery, for every tenant, arrives here.
 *
 * Same shape as `/webhooks/meta`, for the same reason: a body is signed with
 * the *app's* secret, the app is Lipi's, and there is therefore one callback
 * URL for the whole deployment. The tenant is worked out from
 * `X-Shopify-Shop-Domain`, which is why a shop domain is unique across
 * connectors.
 *
 * The raw bytes are what was signed, so `req.json()` is never called: the
 * signature is checked against `req.arrayBuffer()` and the JSON is parsed
 * from those same bytes afterwards.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const status = (code: number) => new Response(null, { status: code });

export async function POST(req: Request) {
  const raw = Buffer.from(await req.arrayBuffer());

  // No API secret means no way to tell a genuine delivery from a forged one,
  // and an unverified webhook writes to real twins. Refuse every body.
  if (!env.SHOPIFY_API_SECRET) return status(401);
  if (!verifyShopifyWebhook(raw, req.headers.get("x-shopify-hmac-sha256") ?? undefined, env.SHOPIFY_API_SECRET)) {
    return status(401);
  }

  const shop = normaliseShop(req.headers.get("x-shopify-shop-domain") ?? "");
  if (!shop) return status(400);

  const connector = await prisma.inventoryConnector.findUnique({ where: { externalId: shop } });
  // A store this deployment no longer serves — disconnected, or never ours.
  // Shopify retries a non-2xx and eventually disables a callback that keeps
  // failing, so an unroutable body is accepted and dropped, never 4xx'd.
  if (!connector || !connector.accessToken) {
    console.warn(`[webhook:shopify] no connected store for ${shop}`);
    return status(200);
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
  } catch {
    return status(400);
  }

  switch (req.headers.get("x-shopify-topic")) {
    case "products/update": {
      // Shape-checked rather than schema-parsed: the import reads a handful
      // of fields off the product and tolerates the rest being absent, but a
      // body with no id and no variant list is not a product at all.
      const product = payload as unknown as ShopifyProduct;
      if (!Number.isFinite(product.id) || !Array.isArray(product.variants)) return status(400);
      await onProductUpdate(connector, product);
      return status(200);
    }

    case "inventory_levels/update": {
      const level = payload as { inventory_item_id?: number; available?: number; updated_at?: string };
      if (!Number.isInteger(level.inventory_item_id) || !Number.isFinite(level.available)) return status(400);
      await onInventoryLevel(connector, {
        inventory_item_id: level.inventory_item_id!,
        available: level.available!,
        updated_at: level.updated_at,
      });
      return status(200);
    }

    // A topic subscribed in the Shopify app that this deployment does not
    // serve. Acknowledged, for the same reason as an unroutable body.
    default:
      return status(200);
  }
}
