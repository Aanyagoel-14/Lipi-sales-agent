import type {
  AccountStatus,
  ComposioAccount,
  ComposioClient,
  ComposioEvent,
  ExecuteResult,
  ProxyMethod,
  ProxyResult,
  WebhookHeaders,
} from "@/server/lib/composio";
import { verifyComposioWebhook } from "@/server/lib/composio";
import { createHmac } from "node:crypto";

type ExecuteArgs = { userId: string; connectedAccountId: string; arguments: Record<string, unknown> };
type ExecuteScript = ExecuteResult | ((args: ExecuteArgs) => ExecuteResult);
type ProxyArgs = { connectedAccountId: string; method: ProxyMethod; endpoint: string; body?: unknown };
type ProxyScript = ProxyResult | ((args: ProxyArgs) => ProxyResult);

/**
 * Stands in for Composio under test. Every method records what it was asked
 * and answers from a script, so a test can say "when WHATSAPP_SEND_MESSAGE
 * runs, fail with this error" and then assert what the app did about it.
 *
 * Five lines of API:
 *   fake.accounts.set(id, { status, userId, toolkit })   an account `getAccount` will find
 *   fake.authConfigs.set(authConfigId, toolkit)          what `link` records for that config
 *   fake.execute.respond(slug, result | fn)              script a tool's outcome
 *   fake.proxy.respond(endpoint, result | fn)            script a proxied call
 *   fake.calls.execute / .link / …                       what happened, in order
 * `fake.sign(event)` produces a correctly signed V3 delivery for the webhook route.
 */
export class FakeComposio implements ComposioClient {
  webhookSecret = "test-composio-webhook-secret";
  accounts = new Map<string, ComposioAccount>();
  authConfigs = new Map<string, string>();
  triggers = new Set<string>();
  calls = {
    link: [] as { userId: string; authConfigId: string; callbackUrl: string; alias?: string }[],
    initiateApiKey: [] as { userId: string; authConfigId: string; apiKey: string; field: string }[],
    getAccount: [] as string[],
    deleteAccount: [] as string[],
    execute: [] as ({ slug: string } & ExecuteArgs)[],
    proxy: [] as ProxyArgs[],
    upsertTrigger: [] as { slug: string; userId: string; connectedAccountId: string; config: Record<string, unknown> }[],
    deleteTrigger: [] as string[],
  };
  private executeScripts = new Map<string, ExecuteScript>();
  private proxyScripts = new Map<string, ProxyScript>();
  private sequence = 0;

  reset() {
    this.webhookSecret = "test-composio-webhook-secret";
    this.accounts.clear();
    this.authConfigs.clear();
    this.triggers.clear();
    this.executeScripts.clear();
    this.proxyScripts.clear();
    for (const list of Object.values(this.calls)) list.length = 0;
    this.sequence = 0;
  }

  private nextId(prefix: string) {
    this.sequence += 1;
    return `${prefix}_fake_${this.sequence}`;
  }

  async link(userId: string, authConfigId: string, options: { callbackUrl: string; alias?: string }) {
    this.calls.link.push({ userId, authConfigId, ...options });
    const connectedAccountId = this.nextId("ca");
    this.accounts.set(connectedAccountId, {
      id: connectedAccountId,
      status: "INITIATED",
      statusReason: null,
      userId,
      toolkit: this.authConfigs.get(authConfigId) ?? "unknown",
    });
    return { redirectUrl: `https://connect.composio.test/link/${connectedAccountId}`, connectedAccountId };
  }

  async initiateApiKey(userId: string, authConfigId: string, apiKey: string, field = "generic_api_key") {
    this.calls.initiateApiKey.push({ userId, authConfigId, apiKey, field });
    const connectedAccountId = this.nextId("ca");
    const status: AccountStatus = "ACTIVE";
    this.accounts.set(connectedAccountId, {
      id: connectedAccountId,
      status,
      statusReason: null,
      userId,
      toolkit: this.authConfigs.get(authConfigId) ?? "unknown",
    });
    return { connectedAccountId, status };
  }

  async getAccount(id: string) {
    this.calls.getAccount.push(id);
    const account = this.accounts.get(id);
    if (!account) throw new Error(`Connected account ${id} not found`);
    return { ...account };
  }

  async deleteAccount(id: string) {
    this.calls.deleteAccount.push(id);
    this.accounts.delete(id);
  }

  execute = Object.assign(
    async (slug: string, args: ExecuteArgs): Promise<ExecuteResult> => {
      this.calls.execute.push({ slug, ...args });
      const script = this.executeScripts.get(slug);
      if (!script) return { successful: true, data: {}, error: null };
      return typeof script === "function" ? script(args) : script;
    },
    { respond: (slug: string, script: ExecuteScript) => void this.executeScripts.set(slug, script) },
  );

  proxy = Object.assign(
    async (args: ProxyArgs): Promise<ProxyResult> => {
      this.calls.proxy.push(args);
      const script = this.proxyScripts.get(args.endpoint);
      if (!script) return { status: 200, data: { ok: true } };
      return typeof script === "function" ? script(args) : script;
    },
    { respond: (endpoint: string, script: ProxyScript) => void this.proxyScripts.set(endpoint, script) },
  );

  async upsertTrigger(slug: string, args: { userId: string; connectedAccountId: string; config: Record<string, unknown> }) {
    this.calls.upsertTrigger.push({ slug, ...args });
    const triggerId = this.nextId("ti");
    this.triggers.add(triggerId);
    return triggerId;
  }

  async deleteTrigger(triggerId: string) {
    this.calls.deleteTrigger.push(triggerId);
    this.triggers.delete(triggerId);
  }

  verifyWebhook(rawBody: string, headers: WebhookHeaders): ComposioEvent {
    return verifyComposioWebhook(rawBody, headers, this.webhookSecret);
  }

  /** A V3 delivery signed with the fake's secret, ready to post at the webhook route. */
  sign(event: Partial<ComposioEvent> & { type: string }, options: { at?: Date; webhookId?: string } = {}) {
    const body = JSON.stringify({
      id: options.webhookId ?? this.nextId("msg"),
      timestamp: (options.at ?? new Date()).toISOString(),
      metadata: {},
      data: {},
      ...event,
    });
    const id = options.webhookId ?? (JSON.parse(body) as { id: string }).id;
    const timestamp = String(Math.floor((options.at ?? new Date()).getTime() / 1000));
    const signature = createHmac("sha256", this.webhookSecret).update(`${id}.${timestamp}.${body}`).digest("base64");
    return {
      body,
      headers: {
        "content-type": "application/json",
        "webhook-id": id,
        "webhook-timestamp": timestamp,
        "webhook-signature": `v1,${signature}`,
        "x-composio-webhook-version": "V3",
        "x-composio-delivery-attempt": "1",
      },
    };
  }
}

export const fakeComposio = new FakeComposio();
