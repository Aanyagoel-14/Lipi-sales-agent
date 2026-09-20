import { beforeAll, beforeEach } from "vitest";
import { testDatabaseUrl } from "./database-url";
import { afterSettled } from "./next/server";

// Must be set before anything imports env.ts, which reads it at module load.
process.env.DATABASE_URL = testDatabaseUrl;
process.env.APP_SECRET ??= "test-secret-not-used-in-production-0123456789";
// Lipi's Meta app, for the suite. The inbound route verifies every body
// against these two and nothing else, so the webhook tests sign with the
// first and answer Meta's challenge with the second.
process.env.META_APP_SECRET ??= "test-meta-app-secret";
process.env.META_VERIFY_TOKEN ??= "test-meta-verify-token";
// Lipi's X app, likewise: the route verifies every Account Activity body
// against the consumer secret and answers X's challenge with it, and a
// tenant's DMs are subscribed to the webhook this id names.
process.env.X_API_SECRET ??= "test-x-api-secret";
process.env.X_WEBHOOK_ID ??= "test-x-webhook-id";
// Lipi's Shopify app, likewise: the install route refuses without these two,
// and the webhook route verifies every body against the secret.
process.env.SHOPIFY_API_KEY ??= "test-shopify-api-key";
process.env.SHOPIFY_API_SECRET ??= "test-shopify-api-secret";
(process.env as Record<string, string>).NODE_ENV = "test";
// The suite must never reach OpenRouter. A developer's real key in .env would
// otherwise make model-backed paths hit the network: slow, billable, and
// non-deterministic. Tests that want the model path set this back and stub
// `fetch` themselves. Cleared on the parsed object rather than on
// `process.env`, because env.ts loads dotenv and would read the file again.
const { env } = await import("@/server/env");
env.OPENROUTER_API_KEY = undefined;
// Nor Composio. Everything the connector track does — credentials, sends,
// triggers — goes through `composio()`, so swapping the client is enough to
// keep the whole track off the network. The fake is reset before every test
// so a script or call log never leaks between them.
const { setComposioClient } = await import("@/server/lib/composio");
const { fakeComposio } = await import("./fakes/composio");
setComposioClient(fakeComposio);
// Nor a real Shopify store. Same seam, same reason.
const { setShopifyClient } = await import("@/server/lib/shopify");
const { fakeShopify } = await import("./fakes/shopify");
setShopifyClient(fakeShopify);
// Nor a customer's own server. Outbound webhooks are the one path that POSTs
// to a URL an operator typed, so the poster is swapped for the whole suite
// rather than only in the file that tests it.
const { setWebhookPoster } = await import("@/server/lib/webhook-endpoint");
const { fakeEndpoint } = await import("./fakes/webhook-endpoint");
setWebhookPoster(fakeEndpoint.poster);

beforeAll(() => {
  if (!process.env.DATABASE_URL?.includes("lipi_test")) {
    throw new Error("Refusing to run tests against a database that is not lipi_test");
  }
});

beforeEach(async () => {
  // The test that just ended may have asserted on the response alone and left
  // its `after()` work running. Letting that finish before anything is reset
  // keeps its writes out of the next test's database and its sends out of the
  // next test's call log.
  await afterSettled();
  fakeComposio.reset();
  fakeShopify.reset();
  fakeEndpoint.reset();
});
