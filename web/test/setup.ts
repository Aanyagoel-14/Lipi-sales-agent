import { beforeAll, beforeEach } from "vitest";
import { testDatabaseUrl } from "./database-url";

// Must be set before anything imports env.ts, which reads it at module load.
process.env.DATABASE_URL = testDatabaseUrl;
process.env.APP_SECRET ??= "test-secret-not-used-in-production-0123456789";
// Lipi's Meta app, for the suite. The inbound route verifies every body
// against these two and nothing else, so the webhook tests sign with the
// first and answer Meta's challenge with the second.
process.env.META_APP_SECRET ??= "test-meta-app-secret";
process.env.META_VERIFY_TOKEN ??= "test-meta-verify-token";
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

beforeAll(() => {
  if (!process.env.DATABASE_URL?.includes("lipi_test")) {
    throw new Error("Refusing to run tests against a database that is not lipi_test");
  }
});

beforeEach(() => fakeComposio.reset());
