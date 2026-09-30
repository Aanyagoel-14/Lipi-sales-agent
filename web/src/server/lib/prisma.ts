import { PrismaPg } from "@prisma/adapter-pg";
import { env } from "../env";
import { PrismaClient } from "@/generated/prisma/client";

/**
 * One client for the process. Prisma 7 takes the connection through a driver
 * adapter rather than a URL in the schema.
 */
export const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});

/**
 * The client Prisma hands to a `$transaction` callback — the full client
 * minus the methods it will not let a transaction call. The plain `prisma`
 * above satisfies it too, so a helper typed this way reads either one.
 */
export type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
