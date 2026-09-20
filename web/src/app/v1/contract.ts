import { z } from "zod";
import { inboundSchema } from "./messages/schema";

/**
 * The public API contract.
 *
 * Every documented request and response shape is declared here as a Zod
 * schema, and the OpenAPI document is generated from these declarations
 * (`openapi.ts`, next door) rather than written by hand — a hand-written
 * document drifts from the code the first time a field is added, and the
 * drift is invisible until an integrator's parser breaks.
 *
 * The projection functions in `shapes.ts` are typed as `z.infer` of the
 * schemas below, so a field that leaves the API without being described here
 * fails typecheck rather than shipping undocumented.
 *
 * Conventions this file encodes, and the reasons they are what they are:
 *
 *  - **Timestamps are ISO-8601 strings**, always named `…Iso`. A caller in
 *    another timezone parses a string; it never has to guess a unit.
 *  - **Money is in whole rupees** on the fields the dashboard already reads
 *    (`…Inr`), because renaming those would break it. New fields carry the
 *    exact stored amount in paise instead, which is the figure to reconcile
 *    against — rupees are rounded at the boundary (see `lib/money.ts`).
 *  - **Lists page with an opaque cursor**, never an offset, and answer
 *    `{ <noun>s: [...], nextCursor }`. `nextCursor` is null on the last page.
 *  - **Errors are `{ error, details? }`** at every status, produced in one
 *    place by `route()` in `lib/http.ts`.
 */

export const channel = z.enum(["whatsapp", "instagram", "facebook", "telegram", "x", "email", "webchat"]);
export const orderStage = z.enum(["Quoted", "Paid", "Packed", "Shipped", "Delivered", "Returned"]);

const isoString = z.iso.datetime();

export const errorShape = z.object({
  error: z.string(),
  details: z.unknown().optional(),
});

/** `{ <noun>s: [...], nextCursor }` — the shape every list answers with. */
const pagedShape = <T extends z.ZodTypeAny>(key: string, item: T) =>
  z.object({ [key]: z.array(item), nextCursor: z.string().nullable() });

export const customerShape = z.object({
  id: z.string(),
  name: z.string(),
  handle: z.string(),
  channel,
  segment: z.enum(["Retail", "Wholesale", "Corporate"]),
  lifetimeValueInr: z.number().int(),
  orders: z.number().int(),
  avgOrderInr: z.number().int(),
  returnRatePct: z.number(),
  priceSensitivity: z.enum(["Low", "Medium", "High"]),
  negotiationStyle: z.string(),
  sizeProfile: z.array(z.string()),
  predictedNext: z.string(),
  riskScore: z.number().int(),
  lastSeenIso: isoString,
});

export const quoteShape = z.object({
  product: z.string(),
  variant: z.string(),
  qty: z.number().int(),
  unitInr: z.number().int(),
  totalInr: z.number().int(),
  dispatch: z.string(),
  eta: z.string(),
});

export const messageShape = z.object({
  from: z.string(),
  text: z.string(),
  atIso: isoString,
  /** Present only when the agent priced something in that message. */
  quote: quoteShape.optional(),
  delivery: z.enum(["pending", "sent", "failed", "held"]).optional(),
  deliveryError: z.string().optional(),
});

const conversationFields = {
  id: z.string(),
  customerId: z.string(),
  channel,
  subject: z.string(),
  unread: z.boolean(),
  lastAtIso: isoString,
  intent: z.string(),
  signals: z.array(z.object({ label: z.string(), tone: z.string() })),
  messageCount: z.number().int(),
  customer: customerShape,
};

/** A row in the thread list: one preview line, never the whole thread. */
export const conversationSummaryShape = z.object({
  ...conversationFields,
  lastMessage: messageShape.nullable(),
});

export const conversationShape = z.object({
  ...conversationFields,
  messages: z.array(messageShape),
});

export const variantShape = z.object({
  id: z.string(),
  optionA: z.string(),
  optionB: z.string(),
  stock: z.number().int(),
  reserved: z.number().int(),
});

export const productShape = z.object({
  id: z.string(),
  name: z.string(),
  category: z.string(),
  axes: z.tuple([z.string(), z.string()]),
  attributes: z.record(z.string(), z.string()),
  priceInr: z.number().int(),
  marginPct: z.number().int(),
  leadTimeDays: z.number().int(),
  supplierId: z.string(),
  crossSell: z.array(z.string()),
  variants: z.array(variantShape),
});

export const supplierShape = z.object({
  id: z.string(),
  name: z.string(),
  onTimePct: z.number().int(),
  avgLeadDays: z.number().int(),
  defectRatePct: z.number(),
  moq: z.number().int(),
  responseHours: z.number().int(),
});

export const eventShape = z.object({
  id: z.string(),
  atIso: isoString,
  type: z.string(),
  twin: z.string(),
  payload: z.string(),
});

/**
 * Where this workspace's events are delivered. The signing secret is not a
 * field: it appears in the create response and in no read, ever.
 */
export const webhookSubscriptionShape = z.object({
  id: z.string(),
  url: z.string(),
  /** Empty means every type. */
  eventTypes: z.array(z.string()),
  active: z.boolean(),
  createdIso: isoString,
  updatedIso: isoString,
});

/** `pending` covers both "not tried yet" and "waiting out a backoff". */
export const webhookDeliveryStatus = z.enum(["pending", "delivered", "dead"]);

/**
 * One event owed to one endpoint, and what became of it. `nextAttemptIso`
 * tells the two kinds of `pending` apart. `dead` is the dead letter and waits
 * for a person.
 */
export const webhookDeliveryShape = z.object({
  id: z.string(),
  subscriptionId: z.string(),
  /** The `Event.id` this carries. De-duplicate on it: delivery is at-least-once. */
  eventId: z.string(),
  eventType: z.string(),
  status: webhookDeliveryStatus,
  attempts: z.number().int(),
  nextAttemptIso: isoString,
  /** What the endpoint answered, or null where it never answered at all. */
  lastStatus: z.number().int().nullable(),
  lastError: z.string().nullable(),
  lastAttemptIso: isoString.nullable(),
  deliveredIso: isoString.nullable(),
  createdIso: isoString,
});

/** What one pass of the outbound queue did. */
export const webhookDispatchShape = z.object({
  queued: z.number().int(),
  delivered: z.number().int(),
  /** Failed this time, due again later. */
  retrying: z.number().int(),
  dead: z.number().int(),
});

/**
 * An order, seen as the business outcome a conversation produced.
 *
 * It is a projection of the same `Order` rows `/v1/orders` serves, not a
 * second record of a sale — there is one order path and this does not add
 * another. What it adds is the attribution an external analytics system
 * needs to close the loop back to the ad that paid for the visitor, and the
 * exact paise, because a funnel that reconciles against rounded rupees drifts
 * a little further from the ledger with every row.
 */
export const conversionShape = z.object({
  id: z.string(),
  occurredIso: isoString,
  customerId: z.string(),
  productId: z.string(),
  variant: z.string(),
  qty: z.number().int(),
  valuePaise: z.number().int(),
  valueInr: z.number().int(),
  stage: orderStage,
  channel,
  attribution: z
    .object({
      utmSource: z.string().nullable(),
      utmMedium: z.string().nullable(),
      utmCampaign: z.string().nullable(),
      utmTerm: z.string().nullable(),
      utmContent: z.string().nullable(),
      adClickId: z.string().nullable(),
      landingPage: z.string().nullable(),
      referrer: z.string().nullable(),
      firstTouchIso: isoString.nullable(),
    })
    .nullable(),
});

/* ---------- requests ---------- */

/**
 * Starts a conversation from the integrator's own site.
 *
 * It is the `/v1/messages` body under the name an integrator looks for. Both
 * land in `ingest()`: one message, one transaction, all twins or none.
 */
export const createConversationBody = inboundSchema;

/** What every externally posted event type is prefixed with. See below. */
export const EXTERNAL_EVENT_PREFIX = "external.";

/**
 * Records an event from the integrator's own site.
 *
 * `type` is namespaced under `external.` by the endpoint rather than taken
 * verbatim, so nothing posted from outside can forge one of the twin events
 * `ingest()` writes — the log is evidence, and evidence a caller can author
 * under the system's own names is not evidence.
 */
export const createEventBody = z.object({
  type: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[a-z][a-z0-9_.-]*$/, "Use lower-case letters, digits, dots, dashes or underscores"),
  twin: z.enum(["customer", "conversation", "product", "inventory", "order"]),
  payload: z.string().trim().min(1).max(2000),
  occurredIso: isoString.optional(),
});

/** `?stage=Paid&stage=Shipped`. Absent means every stage. */
export const conversionStageQuery = z.array(orderStage);

/* The two fields a subscription is made and remade from, so the limits a
 * create is held to are the same ones a PATCH is held to. */
const webhookUrl = z.string().trim().min(1).max(2048);
const webhookEventTypes = z.array(z.string().trim().min(1).max(80)).max(50);

/**
 * Subscribes an endpoint to this workspace's twin events.
 *
 * `eventTypes` are exact `Event.type` values as `/v1/events` reports them;
 * an empty list means every type, which is the default — an integrator who
 * has not said otherwise is better served by too much than by silence.
 */
export const createWebhookBody = z.object({
  url: webhookUrl,
  eventTypes: webhookEventTypes.default([]),
});

/** Every field optional: a PATCH that names only `active` pauses and nothing else. */
export const updateWebhookBody = z.object({
  url: webhookUrl.optional(),
  eventTypes: webhookEventTypes.optional(),
  active: z.boolean().optional(),
});

/* ---------- responses ---------- */

export const responses = {
  customerList: pagedShape("customers", customerShape),
  customer: z.object({ customer: customerShape }),
  conversationList: pagedShape("conversations", conversationSummaryShape),
  conversationCreated: z.object({
    conversation: conversationSummaryShape,
    /** What the salesperson said back, already delivered on the channel. */
    reply: z.string(),
  }),
  conversation: z.object({ conversation: conversationShape }),
  productList: pagedShape("products", productShape).extend({ suppliers: z.array(supplierShape) }),
  product: z.object({ product: productShape }),
  eventList: pagedShape("events", eventShape),
  event: z.object({ event: eventShape }),
  conversionList: pagedShape("conversions", conversionShape),
  webhookList: z.object({ subscriptions: z.array(webhookSubscriptionShape) }),
  webhookCreated: z.object({
    subscription: webhookSubscriptionShape,
    /** Shown once. No read returns it, because a shared secret two parties hold
     *  stops being one the moment a third can ask for it. */
    secret: z.string(),
  }),
  webhook: z.object({ subscription: webhookSubscriptionShape }),
  webhookDeliveryList: pagedShape("deliveries", webhookDeliveryShape),
  webhookDelivery: z.object({ delivery: webhookDeliveryShape }),
  webhookDispatch: webhookDispatchShape,
} as const;
