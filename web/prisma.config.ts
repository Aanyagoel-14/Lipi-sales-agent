import "dotenv/config";
import { defineConfig } from "prisma/config";

/**
 * `DATABASE_URL` is deliberately optional here.
 *
 * Only migrate and introspect need a datasource; `prisma generate` reads the
 * schema and nothing else. Declaring the URL unconditionally made it required
 * at install time, which fails on any host that builds before the runtime
 * environment exists — a deploy would die in `postinstall` rather than at the
 * first query. The migrate commands still fail loudly when it is missing,
 * which is the moment it actually matters.
 */
const url = process.env.DATABASE_URL;

export default defineConfig({
  schema: "prisma/schema.prisma",
  ...(url ? { datasource: { url } } : {}),
  migrations: {
    seed: "tsx prisma/seed.ts",
  },
});
