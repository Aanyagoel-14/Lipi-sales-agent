import { body, HttpError, json, route } from "@/server/lib/http";
import { hashPassword } from "@/server/lib/passwords";
import { prisma } from "@/server/lib/prisma";
import { createSession } from "@/server/lib/session";
import { signupSchema } from "../schemas";

export const POST = route(async (req) => {
  const data = await body(req, signupSchema, "Check the form");

  const existing = await prisma.user.findUnique({ where: { email: data.email } });
  if (existing) throw new HttpError(409, "That email already has an account");

  const user = await prisma.user.create({
    data: {
      email: data.email,
      name: data.name,
      passwordHash: await hashPassword(data.password),
    },
  });

  await createSession(user.id);
  return json({ user: { id: user.id, email: user.email, name: user.name }, workspaceIds: [] }, 201);
});
