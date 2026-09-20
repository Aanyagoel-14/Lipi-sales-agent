import { env } from "@/server/env";
import { verifyShopifyCallback } from "@/server/lib/crypto";
import { HttpError, route } from "@/server/lib/http";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { completeInstall } from "@/server/services/shopify";

/**
 * Where Shopify's consent screen sends the browser back to.
 *
 * Two different things are proved here and neither substitutes for the other.
 * The `hmac` proves the redirect came from Shopify rather than from a link
 * someone sent the operator. The `state` — matched inside `completeInstall`
 * against the nonce written when the install started — proves this workspace
 * is the one that asked for it.
 */
export const GET = route(async (req) => {
  const workspaceId = await resolveWorkspaceId();
  const url = new URL(req.url);

  // Over `url.search` rather than the parsed parameters: the signature covers
  // the query string exactly as it arrived, percent-encoding included.
  if (!env.SHOPIFY_API_SECRET || !verifyShopifyCallback(url.search, env.SHOPIFY_API_SECRET)) {
    throw new HttpError(401, "That callback was not signed by Shopify");
  }

  const shop = url.searchParams.get("shop");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!shop || !code || !state) throw new HttpError(400, "That callback is missing shop, code or state");

  const connector = await completeInstall(workspaceId, { shop, code, state });

  // 303 so the browser follows with GET, back to the page the operator
  // started from, which now shows the store connected.
  return new Response(null, {
    status: 303,
    headers: { location: `/dashboard/inventory/connectors?connector=${connector.id}` },
  });
});
