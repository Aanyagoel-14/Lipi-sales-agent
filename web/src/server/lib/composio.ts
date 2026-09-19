import { createHmac, timingSafeEqual } from "node:crypto";
import type { Composio } from "@composio/core";
import { env } from "../env";
import { toolkitVersions } from "@/server/channels/registry";

/**
 * One place that talks to Composio.
 *
 * From the connect flow onward Composio holds every provider credential — Lipi
 * never sees a Meta token or a Telegram bot token after the connect step — so
 * this is the only module allowed to import `@composio/core`. It is
 * deliberately narrow: the nine calls the connector track makes, and nothing
 * else. Two things are kept out on purpose. There is no OAuth `initiate`:
 * Composio retired it for managed OAuth on 3 July 2026 and Connect Link is the
 * flow. And there is no `dangerouslySkipVersionCheck`: every execute carries
 * the toolkit version the registry pins, so a new toolkit release cannot
 * change what Lipi sends to a customer.
 *
 * Tests swap the whole client for `test/fakes/composio.ts` through
 * `setComposioClient`, the way `test/setup.ts` blanks OPENROUTER_API_KEY, so
 * the suite never reaches the network. The SDK itself is loaded lazily, on the
 * first real call, so a process that never connects a channel never loads it.
 */

export type AccountStatus =
  | "INITIALIZING"
  | "INITIATED"
  | "ACTIVE"
  | "FAILED"
  | "EXPIRED"
  | "INACTIVE"
  | "REVOKED";

export type ComposioAccount = {
  id: string;
  status: AccountStatus;
  statusReason: string | null;
  /** The `user_id` the account was created under. Always a workspace id here. */
  userId: string;
  /** Toolkit slug, lower-case: "whatsapp", "gmail". */
  toolkit: string;
  /**
   * The non-secret values the operator gave Composio when the account was
   * created, as its `state.val`. WhatsApp's WABA id lives here and nowhere
   * else: Composio templates it into every WhatsApp tool call but never
   * returns it, and `POST /{waba_id}/subscribed_apps` cannot be addressed
   * without it. Fields whose name reads as a credential are dropped before
   * they get this far — Composio already replaces their values with a
   * placeholder, and a type that could carry a token invites a log line
   * that prints one.
   */
  params?: Record<string, string>;
};

export type ExecuteResult = {
  successful: boolean;
  data: Record<string, unknown>;
  error: string | null;
  logId?: string;
};

export type ProxyMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

export type ProxyResult = { status: number; data: unknown };

/** Query or header values a proxied request carries alongside its body. */
export type ProxyQuery = Record<string, string | number>;

/** A verified V3 webhook event. `data` is whatever the event type carries. */
export type ComposioEvent = {
  id: string;
  timestamp: string;
  type: string;
  metadata: Record<string, unknown>;
  data: Record<string, unknown>;
};

export type WebhookHeaders = Headers | Record<string, string | string[] | undefined>;

export interface ComposioClient {
  /** Connect Link: the operator finishes OAuth on Composio's hosted page. */
  link(
    userId: string,
    authConfigId: string,
    options: { callbackUrl: string; alias?: string },
  ): Promise<{ redirectUrl: string; connectedAccountId: string }>;
  /**
   * API-key toolkits only (Telegram). The key goes straight to Composio and is
   * never stored here. `field` is the name that toolkit's auth schema requires
   * — `generic_api_key` for Telegram — and comes from the channel spec.
   */
  initiateApiKey(
    userId: string,
    authConfigId: string,
    apiKey: string,
    field?: string,
  ): Promise<{ connectedAccountId: string; status: AccountStatus }>;
  getAccount(id: string): Promise<ComposioAccount>;
  deleteAccount(id: string): Promise<void>;
  /** Runs one tool. The toolkit version comes from the registry, by slug prefix. */
  execute(
    slug: string,
    args: { userId: string; connectedAccountId: string; arguments: Record<string, unknown> },
  ): Promise<ExecuteResult>;
  /**
   * A raw provider request through Composio's credentials, for endpoints no
   * tool covers — every Meta `subscribed_apps` call. `query` becomes real
   * query parameters, which is how the Graph API takes `subscribed_fields`.
   *
   * It only works where the toolkit's credential travels in a header. A
   * toolkit that templates its credential into the path (Telegram puts the
   * bot token in `/bot{token}/…`) gets the endpoint through verbatim and the
   * provider answers 404 — verified against the live API on 2026-09-19.
   */
  proxy(args: {
    connectedAccountId: string;
    method: ProxyMethod;
    endpoint: string;
    body?: unknown;
    query?: ProxyQuery;
  }): Promise<ProxyResult>;
  /** Creates or re-enables a trigger instance; returns its `ti_…` id. */
  upsertTrigger(
    slug: string,
    args: { userId: string; connectedAccountId: string; config: Record<string, unknown> },
  ): Promise<string>;
  deleteTrigger(triggerId: string): Promise<void>;
  /** Checks a webhook delivery's signature and shape. Throws `ComposioWebhookError`; never returns an unverified event. */
  verifyWebhook(rawBody: string, headers: WebhookHeaders): ComposioEvent;
}

export class ComposioWebhookError extends Error {
  constructor(
    readonly reason:
      | "missing_header"
      | "bad_version"
      | "bad_timestamp"
      | "stale"
      | "bad_signature"
      | "bad_payload",
    message: string,
  ) {
    super(message);
  }
}

/** Seconds either side of now that a delivery may claim to have been sent. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

const header = (headers: WebhookHeaders, name: string): string | undefined => {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  const value = found?.[1];
  return Array.isArray(value) ? value[0] : value;
};

/**
 * The keys a secret could mean. The SDK signs with the secret's raw UTF-8
 * bytes, prefix and all, so that form comes first. The Standard Webhooks spec
 * the scheme follows says a `whsec_`-prefixed secret is base64 and is decoded
 * before use, so that form is accepted too. Which one Composio's servers use
 * is settled by the first live delivery, not guessed here.
 */
const keysFor = (secret: string): Buffer[] => {
  const keys = [Buffer.from(secret, "utf8")];
  if (secret.startsWith("whsec_")) keys.push(Buffer.from(secret.slice("whsec_".length), "base64"));
  return keys;
};

const sameSignature = (a: string, b: string): boolean => {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
};

/** `webhook-timestamp` is documented as Unix seconds; the docs page also shows ISO 8601. Take either. */
const timestampSeconds = (raw: string): number | null => {
  if (/^\d+$/.test(raw)) return Number(raw);
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
};

/**
 * Lipi's own check of Composio's V3 signature: `v1,<base64 HMAC-SHA256>` over
 * `"{webhook-id}.{webhook-timestamp}.{raw body}"`. Written here rather than
 * borrowed from the SDK so the tests have vectors that do not depend on SDK
 * internals; `composio.test.ts` cross-checks it against the SDK's verifier.
 */
export function verifyComposioWebhook(
  rawBody: string,
  headers: WebhookHeaders,
  secret: string,
  now: number = Date.now(),
): ComposioEvent {
  const id = header(headers, "webhook-id");
  const timestamp = header(headers, "webhook-timestamp");
  const signature = header(headers, "webhook-signature");
  const version = header(headers, "x-composio-webhook-version");
  if (!id || !timestamp || !signature) {
    throw new ComposioWebhookError("missing_header", "Missing webhook-id, webhook-timestamp or webhook-signature");
  }
  if (version?.toUpperCase() !== "V3") {
    throw new ComposioWebhookError("bad_version", `Expected a V3 payload, got ${version ?? "no version header"}`);
  }

  const sent = timestampSeconds(timestamp);
  if (sent === null) throw new ComposioWebhookError("bad_timestamp", "webhook-timestamp is not a time");
  if (Math.abs(Math.floor(now / 1000) - sent) > WEBHOOK_TOLERANCE_SECONDS) {
    throw new ComposioWebhookError("stale", `Delivery is outside the ${WEBHOOK_TOLERANCE_SECONDS}s window`);
  }

  // The header may carry several space-separated signatures (a rotation
  // period signs with old and new); any one that matches is enough.
  const offered = signature
    .split(" ")
    .map((entry) => entry.split(","))
    .filter(([scheme, value]) => scheme === "v1" && value)
    .map(([, value]) => value!);
  const signed = `${id}.${timestamp}.${rawBody}`;
  const expected = keysFor(secret).map((key) => createHmac("sha256", key).update(signed).digest("base64"));
  if (!offered.some((given) => expected.some((want) => sameSignature(given, want)))) {
    throw new ComposioWebhookError("bad_signature", "Signature does not match");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new ComposioWebhookError("bad_payload", "Body is not JSON");
  }
  const event = parsed as Partial<ComposioEvent> | null;
  if (
    !event || typeof event !== "object"
    || typeof event.id !== "string" || typeof event.type !== "string" || typeof event.timestamp !== "string"
    || !event.metadata || typeof event.metadata !== "object"
    || !event.data || typeof event.data !== "object"
  ) {
    throw new ComposioWebhookError("bad_payload", "Body is not a V3 event");
  }
  return { id: event.id, timestamp: event.timestamp, type: event.type, metadata: event.metadata, data: event.data };
}

/**
 * The pinned version for a tool, from its toolkit prefix: `WHATSAPP_SEND_MESSAGE`
 * → the registry's `whatsapp` pin. A toolkit the registry does not know has no
 * pin, and that is an error rather than a fallback to "latest".
 */
export function versionForTool(slug: string): string {
  const toolkit = slug.split("_")[0]?.toLowerCase() ?? "";
  const version = toolkitVersions()[toolkit];
  if (!version) throw new Error(`No pinned toolkit version for ${slug}; add its toolkit to the channel registry`);
  return version;
}

/**
 * A connected account's initiation state, minus anything named like a
 * credential. Composio hands back `state.val` with secret fields replaced by
 * a placeholder rather than the real value, so this is belt as well as
 * braces: the one field Lipi reads (WhatsApp's `generic_id`) is declared
 * non-secret in the toolkit's own auth schema, and nothing else is passed on.
 */
const SECRET_LOOKING = /key|token|secret|password|credential/i;

function nonSecretParams(val: unknown): Record<string, string> {
  if (!val || typeof val !== "object" || Array.isArray(val)) return {};
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(val as Record<string, unknown>)) {
    if (SECRET_LOOKING.test(name)) continue;
    if (typeof value === "string" || typeof value === "number") out[name] = String(value);
  }
  return out;
}

class RealComposio implements ComposioClient {
  private sdk: Promise<Composio> | null = null;

  private client(): Promise<Composio> {
    this.sdk ??= (async () => {
      if (!env.COMPOSIO_API_KEY) throw new Error("COMPOSIO_API_KEY is not set; channels cannot be connected");
      const { Composio } = await import("@composio/core");
      return new Composio({ apiKey: env.COMPOSIO_API_KEY, allowTracking: false, toolkitVersions: toolkitVersions() });
    })();
    return this.sdk;
  }

  async link(userId: string, authConfigId: string, options: { callbackUrl: string; alias?: string }) {
    const sdk = await this.client();
    const request = await sdk.connectedAccounts.link(userId, authConfigId, options);
    if (!request.redirectUrl) throw new Error("Composio returned a Connect Link with no redirect URL");
    return { redirectUrl: request.redirectUrl, connectedAccountId: request.id };
  }

  async initiateApiKey(userId: string, authConfigId: string, apiKey: string, field = "generic_api_key") {
    const sdk = await this.client();
    const { AuthScheme } = await import("@composio/core");
    const request = await sdk.connectedAccounts.initiate(userId, authConfigId, {
      config: AuthScheme.APIKey({ [field]: apiKey }),
    });
    return { connectedAccountId: request.id, status: (request.status ?? "INITIALIZING") as AccountStatus };
  }

  async getAccount(id: string): Promise<ComposioAccount> {
    // The raw client, not the SDK's transform: only the raw response carries
    // `user_id`, and the callback route has to prove the account belongs to
    // the workspace that asked for it.
    const sdk = await this.client();
    const account = await sdk.getClient().connectedAccounts.retrieve(id);
    return {
      id: account.id,
      status: account.status,
      statusReason: account.status_reason,
      userId: account.user_id,
      toolkit: account.toolkit.slug.toLowerCase(),
      params: nonSecretParams((account as { state?: { val?: unknown } }).state?.val),
    };
  }

  async deleteAccount(id: string) {
    const sdk = await this.client();
    await sdk.connectedAccounts.delete(id);
  }

  async execute(slug: string, args: { userId: string; connectedAccountId: string; arguments: Record<string, unknown> }) {
    const version = versionForTool(slug);
    const sdk = await this.client();
    const result = await sdk.tools.execute(slug, {
      userId: args.userId,
      connectedAccountId: args.connectedAccountId,
      arguments: args.arguments,
      version,
    });
    return { successful: result.successful, data: result.data, error: result.error, logId: result.logId };
  }

  async proxy(args: {
    connectedAccountId: string;
    method: ProxyMethod;
    endpoint: string;
    body?: unknown;
    query?: ProxyQuery;
  }) {
    const sdk = await this.client();
    const result = await sdk.tools.proxyExecute({
      connectedAccountId: args.connectedAccountId,
      endpoint: args.endpoint,
      method: args.method,
      body: args.body,
      parameters: Object.entries(args.query ?? {}).map(([name, value]) => ({ in: "query" as const, name, value })),
    });
    return { status: result.status, data: result.data };
  }

  async upsertTrigger(slug: string, args: { userId: string; connectedAccountId: string; config: Record<string, unknown> }) {
    const sdk = await this.client();
    const result = await sdk.triggers.create(args.userId, slug, {
      connectedAccountId: args.connectedAccountId,
      triggerConfig: args.config,
    });
    return result.triggerId;
  }

  async deleteTrigger(triggerId: string) {
    const sdk = await this.client();
    await sdk.triggers.delete(triggerId);
  }

  verifyWebhook(rawBody: string, headers: WebhookHeaders) {
    if (!env.COMPOSIO_WEBHOOK_SECRET) {
      throw new ComposioWebhookError("bad_signature", "COMPOSIO_WEBHOOK_SECRET is not set; refusing every delivery");
    }
    return verifyComposioWebhook(rawBody, headers, env.COMPOSIO_WEBHOOK_SECRET);
  }
}

let active: ComposioClient | null = null;

/** The client every caller goes through. Real in the app, the fake under test. */
export function composio(): ComposioClient {
  active ??= new RealComposio();
  return active;
}

/** Tests only: swap the client the app talks through. `null` restores the real one. */
export function setComposioClient(client: ComposioClient | null) {
  active = client;
}
