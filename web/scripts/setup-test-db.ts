import { execFileSync } from "node:child_process";
import { Client } from "pg";
import { testDatabaseUrl } from "../test/database-url";

/**
 * Creates the suite's database if it is absent and brings it up to the current
 * migration, run from `web/`:
 *
 *   npm run db:test:setup
 *
 * Idempotent: running it twice creates nothing the second time and applies no
 * migration, so it is safe in a Makefile, a CI job or a shell history.
 *
 * The URL comes from `test/database-url.ts`, the same module `npm test` reads,
 * so the two cannot disagree about which database is being set up. Nothing
 * here loads dotenv, for the same reason: the suite computes its URL before
 * `env.ts` reads `.env`, so a `TEST_DATABASE_URL` in `.env` that this script
 * honoured would point it at a database the tests never touch.
 */
const url = new URL(testDatabaseUrl);
const database = decodeURIComponent(url.pathname.replace(/^\//, ""));

// The same guard `test/setup.ts` holds, one step earlier. That one refuses to
// *read* a database that is not a test database; this one would CREATE one and
// run migrations over it, so a mistyped URL pointed at lipi_dev has to stop
// here rather than at the first test.
if (!database.includes("lipi_test")) {
  console.error(
    `Refusing to set up "${database}": the test database's name must contain lipi_test. ` +
      `Set TEST_DATABASE_URL to the test database, not the development one.`,
  );
  process.exit(1);
}

/** The same server, reached through the database every cluster has. */
const maintenanceUrl = new URL(url);
maintenanceUrl.pathname = "/postgres";

async function ensureDatabase(): Promise<"created" | "present"> {
  const client = new Client({ connectionString: maintenanceUrl.toString() });
  await client.connect();
  try {
    const { rowCount } = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [database]);
    if (rowCount === 1) return "present";

    // CREATE DATABASE takes no parameters, so the name goes in as a quoted
    // identifier. It is the operator's own URL, but doubling any quote in it
    // keeps a name with one in it from becoming two statements.
    await client.query(`CREATE DATABASE "${database.replace(/"/g, '""')}"`);
    return "created";
  } finally {
    await client.end();
  }
}

async function main() {
  const state = await ensureDatabase();
  console.log(state === "created" ? `Created database ${database}` : `Database ${database} already exists`);

  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url.toString() },
  });

  console.log(`${database} is ready on ${url.host}. npm test will use it.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
