import { execSync } from "node:child_process";
import { testDatabaseUrl } from "./database-url";

/**
 * Tests run against their own database, never the development one. Migrations
 * are applied once for the whole run rather than per file.
 */
export default function setup() {
  const url = testDatabaseUrl;
  process.env.DATABASE_URL = url;

  execSync("npx prisma migrate deploy", {
    stdio: "pipe",
    env: { ...process.env, DATABASE_URL: url },
  });
}
