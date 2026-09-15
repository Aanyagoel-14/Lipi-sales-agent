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
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // Throwing rather than exiting: inside Next this runs on a request, and
  // killing the process would take the whole server down over one bad value.
  throw new Error(`Invalid environment: ${JSON.stringify(z.flattenError(parsed.error).fieldErrors)}`);
}

export const env = parsed.data;
