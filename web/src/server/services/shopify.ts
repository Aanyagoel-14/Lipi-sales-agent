import { randomBytes } from "node:crypto";
import type { ExceptionKind, InventoryConnector, OrderStage, Prisma } from "@/generated/prisma/client";
import { env } from "../env";
import { decrypt, encrypt } from "../lib/crypto";
import { recordEvent } from "../lib/events";
import { HttpError } from "../lib/http";
import { toPaise } from "../lib/money";
import { prisma } from "../lib/prisma";
import { generateSku } from "../lib/sku";
import {
  authorizeUrl,
  normaliseShop,
  shopify,
  shopSlug,
  type PullOptions,
  type ShopifyOrder,
  type ShopifyProduct,
  type ShopifyVariant,
  type ShopifyWebhook,
} from "../lib/shopify";
import { applySync, newConnectorSecret, type SyncOutcome, type SyncRow } from "./inventory";

/**
 * The Shopify connector.
 *
 * Every other inventory source in this repo pushes: an ERP knows when its
 * stock moved and posts a batch. Shopify is the other shape — it hands out an
 * OAuth token and expects to be polled, and it delivers webhooks in between.
 * So this module is the part that is genuinely different, and it is
 * deliberately *only* that part:
 *
 *   Stock still moves through `applySync()` and nowhere else. Products are
 *   imported here, orders are imported here, but the number the twin quotes
 *   is corrected by the same function the push connectors use, so exceptions,
 *   reconciliation, events and the cursor all behave identically. A second
 *   sync path is how two connectors end up disagreeing about one variant.
 *
 *   The store's identity and token live on the existing `InventoryConnector`
 *   row rather than in a table of their own, and the Shopify variant id is an
 *   `InventoryMapping.externalSku` like any other external SKU.
 *
 * The one thing Shopify splits in two is a variant's identity: it is *sold*
 * by `variant.id` and *stocked* by `inventory_item_id`, and
 * `inventory_levels/update` carries only the latter. Both handles hang off
 * the one mapping row — `externalSku` and `externalRef` — so the operator's
 * mapping list stays one line per thing they sell.
 */

/** Topics worth subscribing to: the two the twin's numbers depend on. */
export const WEBHOOK_TOPICS = ["products/update", "inventory_levels/update"] as const;

/** Where Shopify sends the operator's browser back to. */
export const callbackUrl = () => `${env.PUBLIC_URL}/v1/inventory/shopify/callback`;

/** Where Shopify posts. One URL for the deployment; the shop is in a header. */
export const webhookUrl = () => `${env.PUBLIC_URL}/webhooks/shopify`;

/* --------------------------------- install -------------------------------- */

/** A deployment with no Shopify app refuses at the door, rather than half-working. */
function requireApp() {
  if (!env.SHOPIFY_API_KEY || !env.SHOPIFY_API_SECRET) {
    throw new HttpError(400, "This deployment has no Shopify app configured (SHOPIFY_API_KEY is empty)");
  }
}

/**
 * Starts an install. The row lands in `pending` with a fresh nonce and no
 * token: having started is not having connected, and only `completeInstall`
 * is allowed to promote it.
 */
export async function beginInstall(workspaceId: string, rawShop: string) {
  requireApp();

  const shop = normaliseShop(rawShop);
  if (!shop) throw new HttpError(422, "That is not a myshopify.com store address");

  // A shop belongs to one workspace: the webhook names only the shop, so two
  // connectors on one store would make an inbound body unroutable.
  const owner = await prisma.inventoryConnector.findUnique({ where: { externalId: shop } });
  if (owner && owner.workspaceId !== workspaceId) {
    throw new HttpError(409, "That store is already connected to another workspace");
  }

  const installState = randomBytes(24).toString("base64url");
  const connector = await prisma.inventoryConnector.upsert({
    where: { workspaceId_source: { workspaceId, source: "shopify" } },
    create: {
      workspaceId,
      source: "shopify",
      name: shopSlug(shop),
      status: "pending",
      externalId: shop,
      installState,
      // Every connector row carries a push secret; a Shopify one simply never
      // shows it, because Shopify has nothing to push with. Minting it keeps
      // the row the same shape as every other connector's.
      secretHash: newConnectorSecret().hash,
    },
    update: {
      status: "pending",
      externalId: shop,
      installState,
      // Re-consenting to a different store must not leave the previous one's
      // token usable, and must not leave its error on the operator's screen.
      accessToken: null,
      scopes: [],
      lastError: null,
    },
  });

  return { connector, redirectUrl: authorizeUrl(shop, installState, callbackUrl()) };
}

/**
 * Finishes it. The `state` is what proves the operator started this install
 * rather than being walked into someone else's, and it is spent on use: a
 * replayed callback finds no nonce to match.
 */
export async function completeInstall(workspaceId: string, params: { shop: string; code: string; state: string }) {
  requireApp();

  const shop = normaliseShop(params.shop);
  if (!shop) throw new HttpError(422, "That callback did not name a myshopify.com store");

  const connector = await prisma.inventoryConnector.findFirst({
    where: { workspaceId, source: "shopify", externalId: shop },
  });
  if (!connector?.installState) throw new HttpError(404, "No Shopify install is in progress for that store");
  if (connector.installState !== params.state) throw new HttpError(403, "That callback does not match the install");

  const { accessToken, scope } = await callShopify(() => shopify().exchangeToken(shop, params.code));

  const connected = await prisma.inventoryConnector.update({
    where: { id: connector.id },
    data: {
      status: "connected",
      // Encrypted at rest, exactly as a channel credential is. Nothing reads
      // it back except `credentials()` below, and no endpoint returns it.
      accessToken: encrypt(accessToken),
      scopes: scope ? scope.split(",").map((s) => s.trim()).filter(Boolean) : [],
      installState: null,
      lastError: null,
    },
  });

  await subscribe(connected, accessToken);
  await recordEvent(workspaceId, "inventory_connector.connected", "inventory", `shopify ${shop}`);

  return connected;
}

/**
 * Unplugs the store. Shopify's webhooks are withdrawn first, because a
 * subscription we can no longer answer for is the orphan that matters, and
 * then the token is cleared — a token that outlived the operator's decision
 * is a credential nobody is watching.
 */
export async function disconnect(connector: InventoryConnector) {
  const token = tokenOf(connector);
  if (token && connector.externalId) await unsubscribe(connector.externalId, token);

  return prisma.inventoryConnector.update({
    where: { id: connector.id },
    data: { status: "disconnected", accessToken: null, scopes: [], installState: null },
  });
}

/**
 * Subscribing and withdrawing are both best effort: a store that will not
 * answer must not fail an install that otherwise worked, nor stand between an
 * operator and the disconnect they asked for.
 */
async function subscribe(connector: InventoryConnector, token: string) {
  if (!connector.externalId) return;
  const address = webhookUrl();

  const existing = await shopify()
    .listWebhooks(connector.externalId, token)
    .catch(() => [] as ShopifyWebhook[]);

  for (const topic of WEBHOOK_TOPICS) {
    if (existing.some((w) => w.topic === topic && w.address === address)) continue;
    await shopify()
      .createWebhook(connector.externalId, token, topic, address)
      .catch((error: unknown) => console.error(`shopify: could not subscribe to ${topic}`, error));
  }
}

async function unsubscribe(shop: string, token: string) {
  const address = webhookUrl();
  const existing = await shopify().listWebhooks(shop, token).catch(() => []);

  for (const webhook of existing.filter((w) => w.address === address)) {
    await shopify()
      .deleteWebhook(shop, token, webhook.id)
      .catch((error: unknown) => console.error(`shopify: could not remove webhook ${webhook.id}`, error));
  }
}

/* ------------------------------- credentials ------------------------------ */

const tokenOf = (connector: InventoryConnector) =>
  connector.accessToken ? decrypt(connector.accessToken) : null;

/**
 * The shop and token a call needs, or a 409 naming what the operator has to
 * do. A token that will not decrypt means APP_SECRET was rotated under it —
 * indistinguishable, from here, from never having been connected.
 */
export function credentials(connector: InventoryConnector): { shop: string; token: string } {
  const token = tokenOf(connector);
  if (!connector.externalId || !token) {
    throw new HttpError(409, "That Shopify store is not connected. Install it again to continue.");
  }
  return { shop: connector.externalId, token };
}

async function callShopify<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw new HttpError(502, (error instanceof Error ? error.message : String(error)).slice(0, 300));
  }
}

/* ---------------------------- product + variants --------------------------- */

/**
 * Shopify allows three option axes; the twin is two-axis by design, because
 * two is what a business actually reasons about ("M in cobalt"). Rather than
 * drop the third and collapse two distinct variants onto one row — which the
 * `(productId, optionA, optionB)` key would refuse anyway — the trailing axes
 * are folded into the second, names and values together. Nothing is lost and
 * the pairs stay unique.
 */
export function axesOf(product: ShopifyProduct): [string, string] {
  const names = (product.options ?? []).map((o) => o?.name).filter(Boolean);
  return [names[0] ?? "Option", names.slice(1).join(" / ") || "Variant"];
}

export const optionsOf = (variant: ShopifyVariant): [string, string] => [
  variant.option1?.trim() || "Default",
  [variant.option2, variant.option3].map((v) => v?.trim()).filter(Boolean).join(" / ") || "Default",
];

/**
 * Ids are derived from the store and the Shopify id, never minted fresh, so
 * a second import of the same product updates the row it made the first time
 * instead of adding another one. The shop name scopes them: two workspaces
 * can each connect a store whose product happens to be id 8001, and an id
 * that collided across them would put one tenant's product in the other's
 * workspace.
 */
const idFor = (prefix: string, shop: string, ...parts: (string | number)[]) =>
  `${prefix}_shopify_${shopSlug(shop)}_${parts.join("_")}`;

export type ImportSummary = {
  products: number;
  variants: number;
  /** Variants Shopify sent that we could not turn into a sellable row. */
  skipped: number;
};

/**
 * Brings products and variants into the product twin and maps every variant.
 *
 * It writes no stock. New variants land at zero and the correction to their
 * real count is `applySync()`'s to make, which is what keeps one path over
 * the number the twin quotes.
 */
export async function importProducts(
  connector: InventoryConnector,
  products: ShopifyProduct[],
): Promise<ImportSummary> {
  const { shop } = credentials(connector);
  const summary: ImportSummary = { products: 0, variants: 0, skipped: 0 };
  if (!products.length) return summary;

  await prisma.$transaction(async (tx) => {
    const supplier = await ensureSupplier(tx, connector.workspaceId, shop);

    for (const incoming of products) {
      const sellable = (incoming.variants ?? []).filter((v) => Number.isFinite(v?.id));
      if (!sellable.length) continue;

      const productId = idFor("prd", shop, incoming.id);
      const [axisA, axisB] = axesOf(incoming);
      const name = incoming.title?.trim() || `Shopify product ${incoming.id}`;
      // One price per product is what the twin models; Shopify prices per
      // variant. The first variant's price is the one quoted, and a variant
      // grid with real price spread is a gap worth naming rather than
      // averaging into a number no customer was ever charged.
      const price = toPaise(Number(sellable[0]!.price) || 0);

      // Everything the store has a say over, written the same way whether the
      // product is new or already here.
      const fromStore = {
        name,
        category: incoming.product_type?.trim() || "Shopify",
        axes: [axisA, axisB],
        attributes: { vendor: incoming.vendor ?? "", shopifyHandle: incoming.handle ?? "" },
        price,
      };

      await tx.product.upsert({
        where: { id: productId },
        create: {
          id: productId,
          workspaceId: connector.workspaceId,
          ...fromStore,
          marginPct: 0,
          leadTimeDays: 0,
          supplierId: supplier,
          crossSell: [],
        },
        // `id` and `workspaceId` are not in the update: a re-import corrects
        // what the store says about a product, never which tenant owns it.
        update: fromStore,
      });
      summary.products += 1;

      const claimed = new Set<string>();
      for (const variant of sellable) {
        const [optionA, optionB] = optionsOf(variant);
        const pair = `${optionA}|||${optionB}`;
        // The two handles Shopify identifies one sellable thing by: sold as
        // `variant.id`, stocked as `inventory_item_id`.
        const externalSku = String(variant.id);
        const externalRef = String(variant.inventory_item_id);

        // Two variants that fold onto the same pair would fight over one row.
        // The first wins and the rest become visible work, not a silent
        // overwrite of a stock figure.
        if (claimed.has(pair)) {
          await raise(tx, connector, externalSku, "ambiguous_sku",
            `${name} sends "${optionA} / ${optionB}" more than once`, variant);
          summary.skipped += 1;
          continue;
        }
        claimed.add(pair);

        const row = await tx.variant.upsert({
          where: { productId_optionA_optionB: { productId, optionA, optionB } },
          // `stock` and `reserved` appear only on create, and only as zero.
          // applySync() owns the number from here.
          create: { productId, optionA, optionB, stock: 0, reserved: 0, sku: generateSku(name, optionA, optionB) },
          update: {},
        });
        summary.variants += 1;

        await tx.inventoryMapping.upsert({
          where: { connectorId_externalSku: { connectorId: connector.id, externalSku } },
          create: { connectorId: connector.id, externalSku, externalRef, variantId: row.id },
          update: { externalRef, variantId: row.id },
        });
      }

      await tx.twinEvent.create({
        data: {
          id: eventIdFor(productId),
          workspaceId: connector.workspaceId,
          occurredAt: new Date(),
          type: "product_twin.imported",
          twin: "product",
          payload: `${productId} name="${name}" variants=${sellable.length} source=shopify`,
        },
      });
    }
  }, { timeout: 30_000 });

  return summary;
}

/** Products need a supplier; a store is one, and it is created once. */
async function ensureSupplier(tx: Prisma.TransactionClient, workspaceId: string, shop: string) {
  const id = idFor("sup", shop, "store");
  await tx.supplier.upsert({
    where: { id },
    create: {
      id, workspaceId, name: shopSlug(shop),
      onTimePct: 100, avgLeadDays: 7, defectRatePct: 0, moq: 1, responseHours: 24,
    },
    update: {},
  });
  return id;
}

/**
 * One open exception per problem, not one per poll. A watermark is inclusive,
 * so the newest product is re-read on every tick; raising the same row again
 * each time would bury the queue it exists to keep readable. A resolved
 * exception whose cause has come back does raise again — that is news.
 */
async function raise(
  tx: Prisma.TransactionClient,
  connector: InventoryConnector,
  externalSku: string,
  kind: ExceptionKind,
  detail: string,
  payload: unknown,
) {
  const open = await tx.inventoryException.findFirst({
    where: { connectorId: connector.id, externalSku, kind, resolvedAt: null },
    select: { id: true },
  });
  if (open) return;

  await tx.inventoryException.create({
    data: { connectorId: connector.id, kind, externalSku, detail, payload: payload as Prisma.InputJsonValue },
  });
}

const eventIdFor = (seed: string) =>
  `evt_${Date.now().toString(36)}${seed.slice(-6)}${randomBytes(2).toString("hex")}`;

/* ---------------------------------- stock --------------------------------- */

/**
 * The stock rows a batch of products implies, keyed the way the mappings are.
 * A variant Shopify does not report a count for is left out rather than sent
 * as zero: "unknown" and "none left" are different claims and only one of
 * them should make the twin stop selling.
 *
 * An oversold store reports a negative count. Zero is the honest reading of
 * it for a twin that is about to be asked "can I have one" — and if units are
 * already reserved against it, `applySync` refuses the correction and raises
 * `below_reserved` rather than quietly promising them twice.
 */
const stockRows = (products: ShopifyProduct[]): SyncRow[] =>
  products.flatMap((p) =>
    (p.variants ?? [])
      .filter((v) => Number.isInteger(v.inventory_quantity))
      .map((v) => ({ sku: String(v.id), stock: Math.max(0, v.inventory_quantity) })),
  );

/* ---------------------------------- orders -------------------------------- */

/**
 * Shopify's own words for where an order stands, in the twin's vocabulary.
 * Cancelled and refunded both read as `Returned`: the money came back, which
 * is the fact the order twin is holding.
 */
export function stageOf(order: ShopifyOrder): OrderStage {
  if (order.cancelled_at || order.financial_status === "refunded") return "Returned";
  if (order.fulfillment_status === "fulfilled") return "Shipped";
  if (order.financial_status === "paid" || order.financial_status === "partially_refunded") return "Paid";
  return "Quoted";
}

/** The `utm_*` and click id a Shopify buyer arrived with, off `landing_site`. */
export function touchOf(order: ShopifyOrder) {
  const query = new URLSearchParams((order.landing_site ?? "").split("?")[1] ?? "");
  const pick = (key: string) => query.get(key)?.slice(0, 200) || null;

  return {
    utmSource: pick("utm_source"),
    utmMedium: pick("utm_medium"),
    utmCampaign: pick("utm_campaign"),
    utmTerm: pick("utm_term"),
    utmContent: pick("utm_content"),
    adClickId: pick("gclid") ?? pick("fbclid") ?? pick("msclkid"),
    landingPage: order.landing_site?.slice(0, 2000) ?? null,
    referrer: order.referring_site?.slice(0, 2000) ?? null,
  };
}

export type OrderImport = { orders: number; lines: number; skipped: number };

/**
 * Brings revenue that happened in Shopify into the order twin.
 *
 * Deliberately narrow about stock: Shopify has already decremented its own
 * count and the next sync carries that number, so an imported order neither
 * reserves nor deducts anything. Reserving here would charge the twin twice
 * for one sale.
 *
 * Attribution is written on first touch only, and only for a customer this
 * import is meeting for the first time — a returning buyer's acquisition is
 * not re-credited to the campaign that brought them back (invariant 3).
 */
export async function importOrders(connector: InventoryConnector, orders: ShopifyOrder[]): Promise<OrderImport> {
  const { shop } = credentials(connector);
  const summary: OrderImport = { orders: 0, lines: 0, skipped: 0 };
  if (!orders.length) return summary;

  const mappings = await prisma.inventoryMapping.findMany({
    where: { connectorId: connector.id },
    include: { variant: { include: { product: { select: { id: true, workspaceId: true } } } } },
  });
  const byVariantId = new Map(mappings.map((m) => [m.externalSku, m]));

  const touched = new Set<string>();

  await prisma.$transaction(async (tx) => {
    for (const order of orders) {
      const lines = (order.line_items ?? []).filter((line) => line.variant_id !== null);
      if (!lines.length) continue;

      const customerId = await upsertCustomer(tx, connector, shop, order);
      touched.add(customerId);
      const stage = stageOf(order);
      let imported = 0;

      for (const line of lines) {
        const mapping = byVariantId.get(String(line.variant_id));
        // Belt and braces on invariant 5: a mapping cascades with its variant,
        // so this can only differ if a connector were pointed elsewhere.
        if (!mapping || mapping.variant.product.workspaceId !== connector.workspaceId) {
          summary.skipped += 1;
          continue;
        }

        const id = idFor("ord", shop, order.id, line.id);
        const value = toPaise(Number(line.price) || 0) * line.quantity;
        const variant = `${mapping.variant.optionA} / ${mapping.variant.optionB}`;

        await tx.order.upsert({
          where: { id },
          create: {
            id,
            workspaceId: connector.workspaceId,
            variant,
            qty: line.quantity,
            value,
            stage,
            // The twin's channels are the ones it can reply on, and a
            // storefront order is not one of them. `email` is what the
            // follow-up would actually go out on, which is what the field
            // is for.
            channel: "email",
            createdAt: new Date(order.created_at),
            customerId,
            productId: mapping.variant.product.id,
            variantId: mapping.variantId,
          },
          // A re-import corrects where the order stands, nothing else: the
          // quantity and the money are what the buyer was charged and are
          // not ours to restate.
          update: { stage },
        });
        imported += 1;
        summary.lines += 1;
      }

      if (imported) {
        summary.orders += 1;
        await tx.twinEvent.create({
          data: {
            id: eventIdFor(String(order.id)),
            workspaceId: connector.workspaceId,
            occurredAt: new Date(),
            type: "order_twin.imported",
            twin: "order",
            payload: `${order.name} stage=${stage} lines=${imported} source=shopify`,
          },
        });
      }
    }

    // Recomputed from the rows themselves rather than incremented, so a
    // re-import cannot double-count and a corrected order is reflected.
    for (const customerId of touched) await recount(tx, customerId);
  }, { timeout: 30_000 });

  return summary;
}

async function upsertCustomer(
  tx: Prisma.TransactionClient,
  connector: InventoryConnector,
  shop: string,
  order: ShopifyOrder,
): Promise<string> {
  const handle = order.customer?.email?.trim().toLowerCase()
    || order.customer?.phone?.trim()
    || `shopify:${order.customer?.id ?? order.id}`;

  // Matched on the handle rather than on the Shopify customer id, so a buyer
  // who already talks to the twin on email is the same customer here, not a
  // second row with the same address.
  const existing = await tx.customer.findFirst({
    where: { workspaceId: connector.workspaceId, handle },
    select: { id: true },
  });

  if (existing) {
    // Deliberately the only column a later order moves. Attribution is first
    // touch, and the name and segment are the twin's own judgements by now.
    await tx.customer.update({ where: { id: existing.id }, data: { lastSeenAt: new Date(order.created_at) } });
    return existing.id;
  }

  const name = [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(" ").trim() || handle;
  const touch = touchOf(order);
  const created = await tx.customer.create({
    data: {
      id: idFor("cus", shop, order.customer?.id ?? `guest_${order.id}`),
      workspaceId: connector.workspaceId,
      name,
      handle,
      channel: "email",
      segment: "Retail",
      lifetimeValue: 0, orderCount: 0, avgOrderValue: 0, returnRatePct: 0,
      priceSensitivity: "Medium", negotiationStyle: "Unknown", sizeProfile: [],
      predictedNext: "Unknown", riskScore: 20,
      lastSeenAt: new Date(order.created_at),
      // First touch, stamped once at creation. Nothing later moves it.
      ...(Object.values(touch).some((v) => v !== null)
        ? { ...touch, firstTouchAt: new Date(order.created_at) }
        : {}),
    },
  });

  await tx.twinEvent.create({
    data: {
      id: eventIdFor(created.id),
      workspaceId: connector.workspaceId,
      occurredAt: new Date(),
      type: "customer_twin.created",
      twin: "customer",
      payload: `${created.id} channel=email source=shopify`,
    },
  });

  return created.id;
}

/** Lifetime value is a sum of orders, so it is read off them, not accumulated. */
async function recount(tx: Prisma.TransactionClient, customerId: string) {
  const totals = await tx.order.aggregate({
    where: { customerId, stage: { not: "Returned" } },
    _sum: { value: true },
    _count: true,
  });
  const orderCount = totals._count;
  const lifetimeValue = totals._sum.value ?? 0;

  await tx.customer.update({
    where: { id: customerId },
    data: {
      orderCount,
      lifetimeValue,
      avgOrderValue: orderCount ? Math.round(lifetimeValue / orderCount) : 0,
    },
  });
}

/* ------------------------------- the sync run ------------------------------ */

export type ShopifySync = {
  products: ImportSummary;
  orders: OrderImport;
  stock: SyncOutcome | null;
  cursor: string | null;
};

/**
 * One poll.
 *
 * The cursor is an `updated_at` watermark — the shape the connector model
 * already documents — and it moves only to the newest thing this run actually
 * saw, so a run that finds nothing leaves the store's position alone. The
 * watermark is inclusive on the way back in (`updated_at_min` is `>=`), which
 * means the newest record is re-read once on the next poll: cheaper than the
 * alternative, which is a record written in the same second as the watermark
 * being skipped forever.
 *
 * `applySync()` sees a key derived from that watermark, so a poll that finds
 * the same tail twice replays rather than re-applying.
 */
export async function syncStore(connector: InventoryConnector): Promise<ShopifySync> {
  const { shop, token } = credentials(connector);
  const since = connector.cursor;

  const [products, orders] = await callShopify(() =>
    Promise.all([
      pullAll((options) => shopify().products(shop, token, options), since),
      pullAll((options) => shopify().orders(shop, token, options), since),
    ]),
  );

  const productSummary = await importProducts(connector, products);
  const orderSummary = await importOrders(connector, orders);

  const cursor = watermark(since, [...products, ...orders]);
  const rows = stockRows(products);

  // A poll that saw no stock still has to record where it got to, or the next
  // one re-reads the same orders for ever.
  if (!rows.length) {
    if (cursor !== since) {
      await prisma.inventoryConnector.update({
        where: { id: connector.id },
        data: { cursor, lastSyncAt: new Date() },
      });
    }
    return { products: productSummary, orders: orderSummary, stock: null, cursor };
  }

  const stock = await applySync(connector, {
    idempotencyKey: `shopify:poll:${cursor ?? "initial"}:${rows.length}`,
    cursor: cursor ?? undefined,
    rows,
  });

  return { products: productSummary, orders: orderSummary, stock, cursor: stock.cursor };
}

/** A page of Shopify's REST admin API, and the most a poll will read. */
export const PAGE = 250;
const MAX_PAGES = 20;

/**
 * Reads every page, not just the first.
 *
 * A watermark alone is not enough on its own: Shopify returns records in
 * ascending *id*, not ascending `updated_at`, so a store with more changes
 * than one page would have its newest record land on page two — and a
 * watermark taken from page one would then skip everything after it, for
 * ever. Paging is the `since_id` checkpoint the connector model documents,
 * used within a poll rather than across polls.
 *
 * Bounded at `MAX_PAGES`: a store that keeps changing under an open poll
 * should hand the rest to the next tick rather than hold this one open. The
 * watermark still moves, so nothing is lost.
 */
export async function pullAll<T extends { id: number; updated_at: string }>(
  page: (options: PullOptions) => Promise<T[]>,
  updatedAtMin: string | null,
  pageSize = PAGE,
): Promise<T[]> {
  const all: T[] = [];
  let sinceId = 0;

  for (let read = 0; read < MAX_PAGES; read++) {
    const rows = await page({ updatedAtMin, limit: pageSize, sinceId });
    all.push(...rows);
    if (rows.length < pageSize) break;
    sinceId = rows.reduce((highest, row) => Math.max(highest, row.id), sinceId);
  }

  return all;
}

/**
 * The newest `updated_at` seen, kept verbatim — Shopify's own string is what
 * goes back to it as `updated_at_min`. Compared as instants rather than as
 * text, because Shopify stamps in the shop's offset (`…T10:00:00-05:00`) and
 * two offsets do not sort lexically.
 */
const watermark = (current: string | null, seen: { updated_at: string }[]) =>
  seen.reduce<string | null>(
    (latest, row) => (!latest || instant(row.updated_at) > instant(latest) ? row.updated_at : latest),
    current,
  );

const instant = (iso: string) => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? -Infinity : ms;
};

/* --------------------------------- webhooks -------------------------------- */

/**
 * `products/update`: the store changed a product. The body carries the whole
 * product, variants and counts included, so it is the same import and the
 * same `applySync()` a poll would do — just for one product and now rather
 * than at the next tick.
 */
export async function onProductUpdate(connector: InventoryConnector, product: ShopifyProduct) {
  await importProducts(connector, [product]);

  const rows = stockRows([product]);
  if (!rows.length) return null;

  return applySync(connector, {
    idempotencyKey: `shopify:product:${product.id}:${product.updated_at}`,
    rows,
  });
}

/**
 * `inventory_levels/update`: one count moved. The body names the inventory
 * item, never the variant, so the mapping is looked up by its second handle.
 *
 * An item we have never imported is still sent through `applySync()` — under
 * a key that says what it is — rather than dropped here, so it becomes the
 * `unmapped_sku` exception the operator already knows how to clear.
 */
export async function onInventoryLevel(
  connector: InventoryConnector,
  level: { inventory_item_id: number; available: number; updated_at?: string },
) {
  const mapping = await prisma.inventoryMapping.findFirst({
    where: { connectorId: connector.id, externalRef: String(level.inventory_item_id) },
    select: { externalSku: true },
  });

  const sku = mapping?.externalSku ?? `inventory_item:${level.inventory_item_id}`;
  const stamp = level.updated_at ?? new Date().toISOString();

  return applySync(connector, {
    idempotencyKey: `shopify:inventory:${level.inventory_item_id}:${stamp}`,
    rows: [{ sku, stock: level.available }],
  });
}
