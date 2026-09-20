import { join } from "node:path";
import { z } from "zod";
import {
  conversationShape, conversationSummaryShape, conversionShape, createConversationBody,
  createEventBody, createWebhookBody, customerShape, errorShape, eventShape, messageShape,
  orderStage, productShape, quoteShape, responses, supplierShape, updateWebhookBody,
  variantShape, webhookDeliveryShape, webhookDeliveryStatus, webhookSubscriptionShape,
} from "./contract";

/**
 * The OpenAPI document, generated from the Zod schemas the routes actually
 * use.
 *
 * A hand-written specification drifts from the code the first time somebody
 * adds a field, and the drift is invisible until an integrator's generated
 * client breaks on it. Here there is nothing to keep in step: the schemas in
 * `contract.ts` type the projections in `shapes.ts`, and this file turns the
 * same schemas into the document. `docs/openapi.json` is the generated output
 * checked in so a diff is reviewable, and `test/openapi.test.ts` regenerates
 * it on every run — a stale file fails the suite, which is what makes the
 * checked-in copy trustworthy.
 */

/** Where the generated document is checked in, relative to `web/`. */
export const OPENAPI_PATH = join(process.cwd(), "..", "docs", "openapi.json");

/** One documented endpoint. The table below is the whole public surface. */
type Endpoint = {
  method: "get" | "post" | "patch" | "delete";
  path: string;
  operationId: string;
  summary: string;
  description: string;
  /** Path parameter names, in the order they appear in `path`. */
  params?: string[];
  /** True for the endpoints that take `limit` and `cursor`. */
  paged?: boolean;
  query?: { name: string; description: string; schema: Record<string, unknown> }[];
  requestBody?: z.ZodType;
  status: number;
  response: z.ZodType;
};

export const endpoints: Endpoint[] = [
  {
    method: "get", path: "/v1/customers", operationId: "listCustomers",
    summary: "List customer twins",
    description: "Most recently active first. One twin per customer, whatever channel they arrived on.",
    paged: true, status: 200, response: responses.customerList,
  },
  {
    method: "get", path: "/v1/customers/{id}", operationId: "getCustomer",
    summary: "Fetch one customer twin",
    description: "404 for an id in another workspace, which is indistinguishable from one that does not exist.",
    params: ["id"], status: 200, response: responses.customer,
  },
  {
    method: "get", path: "/v1/conversations", operationId: "listConversations",
    summary: "List conversations",
    description: "A preview line per thread, never the messages. Fetch a thread by id for those.",
    paged: true, status: 200, response: responses.conversationList,
  },
  {
    method: "post", path: "/v1/conversations", operationId: "createConversation",
    summary: "Start a conversation",
    description:
      "Delivers one inbound message and answers with the thread it landed in, plus the salesperson's reply. " +
      "A handle that has messaged before continues its existing thread.",
    requestBody: createConversationBody, status: 201, response: responses.conversationCreated,
  },
  {
    method: "get", path: "/v1/conversations/{id}", operationId: "getConversation",
    summary: "Fetch one conversation with its messages",
    description: "Messages oldest first, which is reading order.",
    params: ["id"], status: 200, response: responses.conversation,
  },
  {
    method: "get", path: "/v1/products", operationId: "listProducts",
    summary: "List the catalogue",
    description: "Alphabetical. Every page carries the workspace's suppliers, which are few and not paged.",
    paged: true, status: 200, response: responses.productList,
  },
  {
    method: "get", path: "/v1/products/{id}", operationId: "getProduct",
    summary: "Fetch one product with its variants",
    description: "Variant stock is live, not a snapshot.",
    params: ["id"], status: 200, response: responses.product,
  },
  {
    method: "get", path: "/v1/events", operationId: "listEvents",
    summary: "List twin events",
    description: "The append-only evidence log, newest first. Every twin mutation is replayable from it.",
    paged: true, status: 200, response: responses.eventList,
  },
  {
    method: "post", path: "/v1/events", operationId: "recordEvent",
    summary: "Record an event from your own site",
    description:
      "The stored type is prefixed with `external.`, so nothing posted here can be mistaken for an event " +
      "the ingest path observed. An `occurredIso` in the future is clamped to now.",
    requestBody: createEventBody, status: 201, response: responses.event,
  },
  {
    method: "get", path: "/v1/conversions", operationId: "listConversions",
    summary: "List conversions",
    description:
      "Orders seen as business outcomes: exact paise, plus the customer's first-touch attribution so a " +
      "campaign can be credited without a second call per row.",
    paged: true, status: 200, response: responses.conversionList,
    query: [{
      name: "stage",
      description: "Repeatable. Restricts to these order stages; absent means every stage.",
      schema: { type: "array", items: { type: "string", enum: orderStage.options } },
    }],
  },
  {
    method: "get", path: "/v1/webhooks", operationId: "listWebhooks",
    summary: "List webhook subscriptions",
    description: "The endpoints this workspace delivers events to. The signing secrets are not here.",
    status: 200, response: responses.webhookList,
  },
  {
    method: "post", path: "/v1/webhooks", operationId: "createWebhook",
    summary: "Subscribe an endpoint to this workspace's events",
    description:
      "The response carries the signing secret once and no read returns it again. The URL must be " +
      "https and resolve on the public internet.",
    requestBody: createWebhookBody, status: 201, response: responses.webhookCreated,
  },
  {
    method: "get", path: "/v1/webhooks/{id}", operationId: "getWebhook",
    summary: "Fetch one webhook subscription",
    params: ["id"], description: "404 for an id in another workspace.",
    status: 200, response: responses.webhook,
  },
  {
    method: "patch", path: "/v1/webhooks/{id}", operationId: "updateWebhook",
    summary: "Repoint or pause a subscription",
    description:
      "Pausing keeps the subscription's place in the event log, so resuming hands over the backlog " +
      "rather than replaying from the beginning or skipping it.",
    params: ["id"], requestBody: updateWebhookBody, status: 200, response: responses.webhook,
  },
  {
    method: "delete", path: "/v1/webhooks/{id}", operationId: "deleteWebhook",
    summary: "Remove a subscription",
    description: "Its delivery history goes with it. Pause instead to keep the history.",
    params: ["id"], status: 200, response: responses.webhook,
  },
  {
    method: "post", path: "/v1/webhooks/dispatch", operationId: "dispatchWebhooks",
    summary: "Run one pass of the outbound queue",
    description:
      "Lipi has no scheduler of its own, so this is the tick — call it from a cron. Safe to call " +
      "twice: a delivery already owed cannot be owed again, and one that is not yet due is left alone.",
    status: 200, response: responses.webhookDispatch,
  },
  {
    method: "get", path: "/v1/webhooks/deliveries", operationId: "listWebhookDeliveries",
    summary: "List webhook deliveries",
    description:
      "Newest first. `?status=dead` is the dead letter; `?subscription=` narrows to one endpoint.",
    paged: true, status: 200, response: responses.webhookDeliveryList,
    query: [
      {
        name: "status",
        description: "Repeatable. Absent means every status.",
        schema: { type: "array", items: { type: "string", enum: webhookDeliveryStatus.options } },
      },
      {
        name: "subscription",
        description: "Restricts to one subscription id.",
        schema: { type: "string" },
      },
    ],
  },
  {
    method: "post", path: "/v1/webhooks/deliveries/{id}/redeliver", operationId: "redeliverWebhook",
    summary: "Queue a finished delivery again",
    description:
      "Only a delivery that is delivered or dead can be redelivered; one still pending is already " +
      "owed, so re-sending it would be a second copy rather than a second try — that answers 409. " +
      "It queues; `/v1/webhooks/dispatch` is what sends.",
    params: ["id"], status: 200, response: responses.webhookDelivery,
  },
];

/** Named components, so a customer is one definition referenced everywhere. */
const components = {
  Customer: customerShape,
  Quote: quoteShape,
  Message: messageShape,
  ConversationSummary: conversationSummaryShape,
  Conversation: conversationShape,
  Variant: variantShape,
  Product: productShape,
  Supplier: supplierShape,
  Event: eventShape,
  Conversion: conversionShape,
  WebhookSubscription: webhookSubscriptionShape,
  WebhookDelivery: webhookDeliveryShape,
  Error: errorShape,
  CreateConversation: createConversationBody,
  CreateEvent: createEventBody,
  CreateWebhook: createWebhookBody,
  UpdateWebhook: updateWebhookBody,
  ...Object.fromEntries(
    Object.entries(responses).map(([name, schema]) => [`${name[0]!.toUpperCase()}${name.slice(1)}Response`, schema]),
  ),
} as const;

const schemaRef = (id: string) => `#/components/schemas/${id}`;

/** Every error this API can answer with, and why it would. */
const ERRORS: Record<string, string> = {
  "400": "A session cookie and an API key were sent together.",
  "401": "The API key is unknown, revoked or expired.",
  "403": "The key is not scoped to this method, or names a different workspace.",
  "404": "No such row in this workspace.",
  "422": "The body or the page parameters did not validate. `details` names the fields.",
  "429": "Over the key's request budget. `Retry-After` says for how long.",
};

/**
 * `lib/page.ts` is what enforces these; importing its constants here would
 * pull the database client into a script that only writes a JSON file, so
 * `api-contract.test.ts` drives the stated bounds against a live endpoint
 * instead. A document that claims a limit the route refuses fails there.
 */
const pageParameters = [
  {
    name: "limit", in: "query", required: false,
    description: "1 to 200. Defaults to 50.",
    schema: { type: "integer", minimum: 1, maximum: 200, default: 50 },
  },
  {
    name: "cursor", in: "query", required: false,
    description: "Opaque. Take it from the previous page's `nextCursor`.",
    schema: { type: "string" },
  },
];

/** One path's worth of the document: its parameters, its body and its answers. */
function operationOf(endpoint: Endpoint, ref: (schema: z.ZodType) => { $ref: string }) {
  return {
    operationId: endpoint.operationId,
    summary: endpoint.summary,
    description: endpoint.description,
    parameters: [
      ...(endpoint.params ?? []).map((name) => ({
        name, in: "path", required: true, schema: { type: "string" },
      })),
      ...(endpoint.paged ? pageParameters : []),
      ...(endpoint.query ?? []).map((q) => ({
        name: q.name, in: "query", required: false, description: q.description, schema: q.schema,
      })),
    ],
    ...(endpoint.requestBody
      ? {
          requestBody: {
            required: true,
            content: { "application/json": { schema: ref(endpoint.requestBody) } },
          },
        }
      : {}),
    responses: {
      [String(endpoint.status)]: {
        description: endpoint.summary,
        content: { "application/json": { schema: ref(endpoint.response) } },
      },
      ...Object.fromEntries(
        Object.entries(ERRORS).map(([status, description]) => [
          status,
          { description, content: { "application/json": { schema: { $ref: schemaRef("Error") } } } },
        ]),
      ),
    },
  };
}

export function openapiDocument() {
  const registry = z.registry<{ id: string }>();
  for (const [id, schema] of Object.entries(components)) registry.add(schema, { id });

  const generated = z.toJSONSchema(registry, {
    uri: schemaRef,
    target: "draft-2020-12",
    io: "output",
    unrepresentable: "any",
  }).schemas as Record<string, Record<string, unknown>>;

  // `$schema` is a JSON Schema document header; inside an OpenAPI components
  // block it is noise that would show up in every generated client.
  const schemas = Object.fromEntries(
    Object.entries(generated).map(([id, schema]) => {
      const withoutHeader = { ...schema };
      delete withoutHeader.$schema;
      return [id, withoutHeader];
    }),
  );

  const byId = new Map(Object.entries(components).map(([id, schema]) => [schema as z.ZodType, id]));
  // A schema the table above forgot would otherwise ship as `$ref: …/undefined`,
  // which no generator complains about and every client then breaks on.
  const ref = (schema: z.ZodType) => {
    const id = byId.get(schema);
    if (!id) throw new Error("Endpoint uses a schema that is not a named component");
    return { $ref: schemaRef(id) };
  };

  const paths: Record<string, Record<string, unknown>> = {};
  for (const endpoint of endpoints) {
    paths[endpoint.path] = { ...paths[endpoint.path], [endpoint.method]: operationOf(endpoint, ref) };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Lipi AI",
      version: "1.0.0",
      description:
        "The integration surface. Authenticate with `Authorization: Bearer lipi_sk_…`; a key resolves to " +
        "exactly one workspace and every response is scoped to it. Lists page with an opaque cursor, " +
        "timestamps are ISO-8601 strings named `…Iso`, and every error at every status is " +
        "`{ error, details? }`.",
    },
    servers: [{ url: "https://your-lipi-host", description: "Your deployment" }],
    security: [{ apiKey: [] }],
    components: {
      securitySchemes: {
        apiKey: {
          type: "http",
          scheme: "bearer",
          description:
            "A key minted at `POST /v1/api-keys`. `read` scope covers GET and HEAD; `write` covers " +
            "everything else and implies read.",
        },
      },
      schemas,
    },
    paths,
  };
}
