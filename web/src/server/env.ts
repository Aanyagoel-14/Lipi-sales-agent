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
  COMPOSIO_AUTH_CONFIG_TELEGRAM: z.string().optional(),
  COMPOSIO_AUTH_CONFIG_GMAIL: z.string().optional(),
  // Lipi's own Meta app. Meta signs inbound webhooks with the subscribing
  // app's secret, so inbound WhatsApp and Instagram cannot be verified with
  // anything else. Both stay optional until the Meta webhook route exists.
  META_APP_SECRET: z.string().optional(),
  META_VERIFY_TOKEN: z.string().optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // Throwing rather than exiting: inside Next this runs on a request, and
  // killing the process would take the whole server down over one bad value.
  throw new Error(`Invalid environment: ${JSON.stringify(z.flattenError(parsed.error).fieldErrors)}`);
}

export const env = parsed.data;
