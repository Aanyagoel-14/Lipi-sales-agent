import "dotenv/config";

/**
 * One-off project setup against Composio, run from `web/`:
 *
 *   npm run composio:subscribe                 create (or update) the project's webhook
 *                                              subscription and print its secret ONCE
 *   npm run composio:subscribe -- --rotate     rotate the secret and print the new one
 *   npm run composio:subscribe -- --versions   print each toolkit's live version next
 *                                              to the pin in the channel registry
 *   npm run composio:subscribe -- --link <ac_…>
 *                                              issue one Connect Link against an auth
 *                                              config and print the URL, to see what
 *                                              the hosted page asks for
 *   npm run composio:subscribe -- --auth-configs
 *                                              create the four channel auth configs this
 *                                              project does not have yet, and print their
 *                                              ids for web/.env. Safe to re-run: it skips
 *                                              a toolkit that already has one.
 *
 * Refuses to run without COMPOSIO_API_KEY. Talks to the REST API with `fetch`
 * rather than the SDK, so `src/server/lib/composio.ts` stays the SDK's only
 * importer. Never run by the test suite: the suite only checks the guard.
 */

const BASE = "https://backend.composio.dev/api/v3.1";
const EVENTS = ["composio.trigger.message", "composio.connected_account.expired", "composio.trigger.disabled"];

const apiKey = process.env.COMPOSIO_API_KEY;
if (!apiKey) {
  console.error("COMPOSIO_API_KEY is not set. Create an API key in the Composio project's settings and put it in web/.env first.");
  process.exit(1);
}

const publicUrl = process.env.PUBLIC_URL ?? "http://localhost:3000";
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const flagValue = (name: string) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};

async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "x-api-key": apiKey!, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  return { status: res.status, json: json as T };
}

type Subscription = { id: string; webhook_url?: string; version?: string; enabled_events?: string[]; secret?: string };

async function subscribe() {
  if (!publicUrl.startsWith("https://")) {
    console.warn(`PUBLIC_URL is ${publicUrl}; Composio only delivers to HTTPS. Use a tunnel or the deployed origin.`);
  }
  const webhookUrl = `${publicUrl.replace(/\/$/, "")}/webhooks/composio`;
  const created = await api<Subscription & { error?: unknown }>("POST", "/webhook_subscriptions", {
    webhook_url: webhookUrl,
    enabled_events: EVENTS,
    version: "V3",
  });

  if (created.status === 409) {
    const existing = await api<{ items?: Subscription[] } | Subscription[]>("GET", "/webhook_subscriptions");
    const list = Array.isArray(existing.json) ? existing.json : existing.json.items ?? [];
    console.log("The project already has a webhook subscription (one per project):");
    for (const sub of list) console.log(`  ${sub.id}  ${sub.webhook_url ?? ""}  ${sub.version ?? ""}  [${(sub.enabled_events ?? []).join(", ")}]`);
    console.log("Its secret cannot be read back. Re-run with --rotate to get a new one, and check the URL, V3 and the three events in the dashboard.");
    return;
  }
  if (created.status >= 300) {
    console.error(`Composio refused the subscription (${created.status}):`, JSON.stringify(created.json));
    process.exit(1);
  }

  const sub = created.json;
  console.log(`Webhook subscription ${sub.id} → ${sub.webhook_url ?? webhookUrl} (${sub.version ?? "V3"})`);
  printSecret(sub.secret);
}

async function rotate() {
  const existing = await api<{ items?: Subscription[] } | Subscription[]>("GET", "/webhook_subscriptions");
  const list = Array.isArray(existing.json) ? existing.json : existing.json.items ?? [];
  const sub = list[0];
  if (!sub) {
    console.error("No webhook subscription to rotate. Run without --rotate first.");
    process.exit(1);
  }
  const rotated = await api<Subscription>("POST", `/webhook_subscriptions/${sub.id}/rotate_secret`);
  if (rotated.status >= 300) {
    console.error(`Rotation failed (${rotated.status}):`, JSON.stringify(rotated.json));
    process.exit(1);
  }
  console.log(`Rotated the secret of ${sub.id}. The old one stops verifying once you deploy the new value.`);
  printSecret(rotated.json.secret);
}

function printSecret(secret: string | undefined) {
  if (!secret) {
    console.log("Composio did not return a secret in this response; rotate it from the dashboard and copy it from there.");
    return;
  }
  console.log("");
  console.log("Paste this into web/.env now — it is shown once and cannot be read back:");
  console.log(`  COMPOSIO_WEBHOOK_SECRET=${secret}`);
  console.log("");
}

async function versions() {
  // Read the pins from the registry without importing app modules that need
  // DATABASE_URL: the registry itself is import-safe, env.ts validates lazily.
  const { channelSpecs } = await import("../src/server/channels/registry");
  for (const spec of channelSpecs) {
    const res = await api<{ meta?: { version?: string; [k: string]: unknown }; auth_config_details?: unknown }>(
      "GET",
      `/toolkits/${spec.toolkit}`,
    );
    const live = res.json?.meta?.version;
    const mark = live === undefined ? "?" : live === spec.toolkitVersion ? "=" : "≠";
    console.log(`${spec.toolkit.padEnd(10)} pinned ${spec.toolkitVersion}  live ${live ?? `(no meta.version; status ${res.status})`}  ${mark}`);
    if (live === undefined && res.json?.meta) console.log("   meta:", JSON.stringify(res.json.meta).slice(0, 300));
    if (spec.toolkit === "telegram") {
      // Whether the hosted Connect Link page can collect the bot token is
      // decided by this block: look for `connected_account_initiation` fields.
      console.log("   auth_config_details:", JSON.stringify(res.json?.auth_config_details ?? null).slice(0, 600));
    }
  }
}

/**
 * The four auth configs, in the form each toolkit actually accepts (read from
 * `GET /toolkits/{slug}` on 2026-09-19).
 *
 * Telegram is API_KEY: the bot token is supplied per connection, so the config
 * itself carries no credentials. The other three are OAuth2. Gmail on
 * Composio-managed auth is fine for production. **WhatsApp and Instagram on
 * managed auth are development only** — Meta signs inbound webhooks with the
 * subscribing app's secret, so a managed config can never produce inbound Lipi
 * can verify. Replace both with custom configs on Lipi's own Meta app before
 * those channels go live (see docs/runbooks/meta-app.md).
 */
const AUTH_CONFIGS = [
  { toolkit: "telegram", env: "COMPOSIO_AUTH_CONFIG_TELEGRAM", body: { type: "use_custom_auth", authScheme: "API_KEY", credentials: {}, name: "lipi-telegram" } },
  { toolkit: "gmail", env: "COMPOSIO_AUTH_CONFIG_GMAIL", body: { type: "use_composio_managed_auth", name: "lipi-gmail" } },
  { toolkit: "whatsapp", env: "COMPOSIO_AUTH_CONFIG_WHATSAPP", body: { type: "use_composio_managed_auth", name: "lipi-whatsapp-DEV-ONLY" } },
  { toolkit: "instagram", env: "COMPOSIO_AUTH_CONFIG_INSTAGRAM", body: { type: "use_composio_managed_auth", name: "lipi-instagram-DEV-ONLY" } },
] as const;

type AuthConfig = { id?: string; name?: string; toolkit?: { slug?: string }; auth_scheme?: string; is_composio_managed?: boolean };

/** Every auth config in the project, keyed by toolkit slug. */
async function existingAuthConfigs(): Promise<Map<string, AuthConfig>> {
  const res = await api<{ items?: AuthConfig[] }>("GET", "/auth_configs");
  const have = new Map<string, AuthConfig>();
  for (const item of res.json?.items ?? []) {
    const slug = item.toolkit?.slug?.toLowerCase();
    if (slug && !have.has(slug)) have.set(slug, item);
  }
  return have;
}

async function authConfigs() {
  let have = await existingAuthConfigs();

  for (const spec of AUTH_CONFIGS) {
    if (have.has(spec.toolkit)) continue;
    const created = await api<unknown>("POST", "/auth_configs", {
      toolkit: { slug: spec.toolkit },
      auth_config: spec.body,
    });
    if (created.status >= 300) {
      console.error(`${spec.toolkit.padEnd(10)} FAILED (${created.status}): ${JSON.stringify(created.json).slice(0, 300)}`);
    }
  }

  // The create response's shape varies; the list is the source of truth.
  have = await existingAuthConfigs();

  const lines: string[] = [];
  for (const spec of AUTH_CONFIGS) {
    const config = have.get(spec.toolkit);
    if (!config?.id) {
      console.log(`${spec.toolkit.padEnd(10)} missing — create it in the dashboard`);
      continue;
    }
    const managed = config.is_composio_managed ? "composio-managed" : "custom";
    console.log(`${spec.toolkit.padEnd(10)} ${config.id}  ${config.auth_scheme ?? ""}  ${managed}  ${config.name ?? ""}`);
    lines.push(`${spec.env}=${config.id}`);
  }

  if (lines.length) {
    console.log("");
    console.log("Put these in web/.env:");
    for (const line of lines) console.log(`  ${line}`);
  }
  const meta = AUTH_CONFIGS.filter((s) => s.toolkit === "whatsapp" || s.toolkit === "instagram")
    .filter((s) => have.get(s.toolkit)?.is_composio_managed);
  if (meta.length) {
    console.log("");
    console.log(`DEVELOPMENT ONLY: ${meta.map((m) => m.toolkit).join(" and ")} are Composio-managed.`);
    console.log("Inbound Meta webhooks cannot be verified through a managed app — replace with custom");
    console.log("configs on Lipi's own Meta app before going live. See docs/runbooks/meta-app.md.");
  }
}

async function link(authConfigId: string) {
  const res = await api<{ redirect_url?: string; connected_account_id?: string; expires_at?: string }>(
    "POST",
    "/connected_accounts/link",
    { auth_config_id: authConfigId, user_id: "smoke-test", callback_url: `${publicUrl}/v1/channels/callback` },
  );
  if (res.status >= 300) {
    console.error(`Link failed (${res.status}):`, JSON.stringify(res.json));
    process.exit(1);
  }
  console.log(`Connected account ${res.json.connected_account_id} (INITIATED; expires ${res.json.expires_at ?? "in ~10 min"})`);
  console.log(`Open: ${res.json.redirect_url}`);
  console.log("Delete the smoke-test account from the dashboard afterwards.");
}

async function main() {
  const linkTarget = flagValue("--link");
  if (flag("--versions")) await versions();
  else if (flag("--auth-configs")) await authConfigs();
  else if (flag("--rotate")) await rotate();
  else if (linkTarget) await link(linkTarget);
  else await subscribe();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
