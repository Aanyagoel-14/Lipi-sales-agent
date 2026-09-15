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
