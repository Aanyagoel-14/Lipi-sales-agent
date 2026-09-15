import { userInfo } from "node:os";

/**
 * Postgres needs the role in the URL, so it is derived from the OS user the
 * way psql does implicitly. Override with TEST_DATABASE_URL where that is not
 * how the database is reached.
 */
export const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ?? `postgresql://${userInfo().username}@localhost:5432/lipi_test`;
