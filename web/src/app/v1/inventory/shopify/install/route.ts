import { z } from "zod";
import { body, json, route } from "@/server/lib/http";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { beginInstall } from "@/server/services/shopify";
import { connectorView } from "../../view";

/**
 * Starts a Shopify install and answers with the URL to send the browser to.
 *
 * `shopify` is a static segment and `/v1/inventory/[id]/sync` a dynamic one,
 * so Next resolves this file first; a connector id is a cuid and can never be
 * the literal string.
 */
const installSchema = z.object({ shop: z.string().trim().min(3).max(120) });

export const POST = route(async (req) => {
  const workspaceId = await resolveWorkspaceId();
  const { shop } = await body(req, installSchema, "Name the store, e.g. acme.myshopify.com");

  const { connector, redirectUrl } = await beginInstall(workspaceId, shop);

  return json({ redirectUrl, connector: connectorView(connector) }, 201);
});
