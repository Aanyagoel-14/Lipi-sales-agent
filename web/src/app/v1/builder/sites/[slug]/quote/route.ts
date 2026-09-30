import { corsPreflight, corsRoute } from "@/server/lib/cors";
import { body, json } from "@/server/lib/http";
import { quoteFromSite, quoteRequestSchema } from "@/server/sites/generate";

/**
 * `POST /v1/builder/sites/{slug}/quote` — the price a generated site quotes.
 *
 * Public and CORS-enabled, like the webchat widget's own endpoints: a
 * generated site is served to strangers and the calculator on it has to work
 * for them. Nothing here reads a credential and nothing here writes; it
 * evaluates one stored expression against the numbers a visitor typed.
 *
 * The formula itself never leaves the server. A visitor's browser has no
 * business holding the business's pricing maths, and shipping it would let
 * anybody read the margin out of the page source.
 */
export const POST = corsRoute<{ slug: string }>(async (req, { slug }) => {
  const input = await body(req, quoteRequestSchema, "Invalid quote request");
  const { amountMinorUnits } = await quoteFromSite(slug, input.variables);
  return json({ amountMinorUnits });
});

export const OPTIONS = corsPreflight;
