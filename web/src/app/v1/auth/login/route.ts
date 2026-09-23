import { throttleAuth } from "@/server/lib/auth-throttle";
import { body, HttpError, json, route } from "@/server/lib/http";
import { verifyPassword } from "@/server/lib/passwords";
import { prisma } from "@/server/lib/prisma";
import { createSession } from "@/server/lib/session";
import { credentials } from "../schemas";

export const POST = route(async (req) => {
  const data = await body(req, credentials, "Check the form");

  // Before the password is hashed or the database is read: a refused attempt
  // must cost a map lookup, not an Argon2 hash.
  throttleAuth(req, data.email);

  const user = await prisma.user.findUnique({
    where: { email: data.email },
    include: { memberships: { select: { workspaceId: true } } },
  });

  // Same message either way: distinguishing them tells an attacker which
  // emails have accounts.
  const ok = user && (await verifyPassword(data.password, user.passwordHash));
  if (!ok) throw new HttpError(401, "That email and password do not match");

  await createSession(user.id);
  return json({
    user: { id: user.id, email: user.email, name: user.name },
    workspaceIds: user.memberships.map((m) => m.workspaceId),
  });
});
