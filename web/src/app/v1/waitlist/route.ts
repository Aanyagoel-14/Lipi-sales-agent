import { z } from "zod";
import { body, json, route } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";

const bodySchema = z.object({
  email: z.email(),
  company: z.string().trim().max(120).optional(),
});

export const POST = route(async (req) => {
  const data = await body(req, bodySchema, "Invalid request body");

  const email = data.email.toLowerCase();
  const existing = await prisma.waitlistEntry.findUnique({ where: { email } });
  if (existing) return json({ ok: true, alreadyRegistered: true });

  await prisma.waitlistEntry.create({ data: { email, company: data.company ?? null } });
  return json({ ok: true, alreadyRegistered: false }, 201);
});
