import { z } from "zod";

/**
 * Server-side configuration. Next loads `.env` itself, so nothing is read from
 * disk here — this only validates what arrived.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required. Copy .env.example to .env."),
  // Optional. Without it, intent extraction falls back to deterministic rules.
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: z.string().default("deepseek/deepseek-v4-flash"),
  // The model the operator's own twin chat talks through. Separate from
  // OPENROUTER_MODEL because the two jobs want different things: extraction
  // wants a strict schema filler, this wants a reasoner over a long briefing.
  // They are also allowed to differ in cost. Chat is a handful of calls a day
  // from one operator; extraction runs on every inbound customer message and
  // decides whether stock gets reserved, so it is the one worth paying for.
  OPENROUTER_CHAT_MODEL: z.string().default("nvidia/nemotron-3-super-120b-a12b:free"),
  // Encrypts channel credentials at rest. Rotating it invalidates them.
  APP_SECRET: z.string().min(16, "APP_SECRET must be at least 16 characters"),
  // The app's own public origin. Webhook URLs handed to providers and push
  // URLs handed to ERPs are built from it, so it has to be publicly reachable
  // and has to match where the app is actually served.
  PUBLIC_URL: z.string().default("http://localhost:3000"),

  // ------------------------------------------------------------ Composio --
  // Composio holds every provider credential and runs every outbound send
  // from the connector track onward. All of it is optional: the app has to
  // boot for the webchat-only path with none of these set. A channel whose
  // auth config id is absent is reported by the catalog as unavailable and
  // refused at connect with a message that names the missing key.
  COMPOSIO_API_KEY: z.string().optional(),
  // Signs every webhook Composio delivers. Printed once by
  // `npm run composio:subscribe`; there is no way to read it back.
  COMPOSIO_WEBHOOK_SECRET: z.string().optional(),
  // One auth config (`ac_…`) per channel, per environment.
  COMPOSIO_AUTH_CONFIG_WHATSAPP: z.string().optional(),
  COMPOSIO_AUTH_CONFIG_INSTAGRAM: z.string().optional(),
  COMPOSIO_AUTH_CONFIG_FACEBOOK: z.string().optional(),
  COMPOSIO_AUTH_CONFIG_TELEGRAM: z.string().optional(),
  COMPOSIO_AUTH_CONFIG_X: z.string().optional(),
  COMPOSIO_AUTH_CONFIG_GMAIL: z.string().optional(),
  // Lipi's own Meta app: one App Secret and one verify token for the whole
  // deployment, set once in the Meta app against `/webhooks/meta`. Meta
  // signs every inbound body with the *subscribing* app's secret, so these
  // are what WhatsApp, Instagram and Messenger inbound is verified against —
  // there is no per-tenant equivalent and never was.
  META_APP_SECRET: z.string().optional(),
  META_VERIFY_TOKEN: z.string().optional(),

  // ------------------------------------------------------------------- X --
  // Lipi's own X app, the same shape as the Meta one. X signs every Account
  // Activity delivery with the app's *consumer secret* and proves ownership
  // of the callback with a challenge signed by the same key, so this is what
  // `/webhooks/x` verifies against — there is no per-tenant equivalent. The
  // webhook itself is registered once per deployment (`POST /2/webhooks`)
  // and its id is what each tenant's activity is subscribed to.
  X_API_SECRET: z.string().optional(),
  X_WEBHOOK_ID: z.string().optional(),

  // ------------------------------------------------------------- Shopify --
  // Lipi's own Shopify app, one per deployment. The API key identifies it on
  // the consent screen; the secret both signs the OAuth callback and every
  // webhook body, the way META_APP_SECRET does for Meta. Optional, because a
  // deployment that offers no Shopify install has no use for either — and
  // absent means the install route refuses rather than half-works.
  SHOPIFY_API_KEY: z.string().optional(),
  SHOPIFY_API_SECRET: z.string().optional(),
  // What the operator is asked to consent to. Kept in configuration rather
  // than in code: adding a scope changes what the consent screen says, and
  // that is a deployment's decision to make and to re-request.
  SHOPIFY_SCOPES: z.string().default("read_products,read_inventory,read_orders"),
  // Pinned, never "latest": a floating version means Shopify can change the
  // shape of a payload the twin trusts without anything here changing.
  SHOPIFY_API_VERSION: z.string().default("2025-01"),
}).superRefine((value, ctx) => {
  // Half a Shopify app is worse than none: an install that starts and cannot
  // finish, or a webhook that can never be verified.
  const shopify = ["SHOPIFY_API_KEY", "SHOPIFY_API_SECRET"] as const;
  if (shopify.some((key) => value[key]) && !shopify.every((key) => value[key])) {
    ctx.addIssue({
      code: "custom",
      path: [shopify.find((key) => !value[key])!],
      message: "SHOPIFY_API_KEY and SHOPIFY_API_SECRET are only useful together",
    });
  }

  // A Meta channel that can be connected but whose webhooks can never be
  // verified is a channel that silently receives nothing. Rather than let a
  // deployment discover that from an empty inbox, it is a boot failure:
  // either give the deployment its Meta app credentials, or take the auth
  // config ids out and stop offering the channel.
  const metaChannels = ["COMPOSIO_AUTH_CONFIG_WHATSAPP", "COMPOSIO_AUTH_CONFIG_INSTAGRAM", "COMPOSIO_AUTH_CONFIG_FACEBOOK"] as const;
  const offered = metaChannels.filter((key) => value[key]);
  if (!offered.length) return;

  for (const key of ["META_APP_SECRET", "META_VERIFY_TOKEN"] as const) {
    if (value[key]) continue;
    ctx.addIssue({
      code: "custom",
      path: [key],
      message: `${key} is required when a Meta channel is offered (${offered.join(", ")}); inbound cannot be verified without it`,
    });
  }
}).superRefine((value, ctx) => {
  // The same rule for X, for the same reason: without the app's consumer
  // secret no delivery can be verified and the CRC challenge cannot be
  // answered, and without the webhook id no tenant can be subscribed to it.
  if (!value.COMPOSIO_AUTH_CONFIG_X) return;

  for (const key of ["X_API_SECRET", "X_WEBHOOK_ID"] as const) {
    if (value[key]) continue;
    ctx.addIssue({
      code: "custom",
      path: [key],
      message: `${key} is required when X is offered (COMPOSIO_AUTH_CONFIG_X is set); DMs cannot be received without it`,
    });
  }
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // Throwing rather than exiting: inside Next this runs on a request, and
  // killing the process would take the whole server down over one bad value.
  throw new Error(`Invalid environment: ${JSON.stringify(z.flattenError(parsed.error).fieldErrors)}`);
}

export const env = parsed.data;
