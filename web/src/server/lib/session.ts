import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { env } from "../env";
import { prisma } from "./prisma";
import { HttpError } from "./http";

export const SESSION_COOKIE = "lipi_session";
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The wizard's record of which workspace the browser is looking at. It
 * belongs to whoever was signed in when it was written, so it goes whenever
 * the session does: left behind, it names the previous user's workspace, the
 * membership check in `resolveWorkspaceId` refuses it with a 403, and every
 * dashboard read fails for the new user.
 */
const WORKSPACE_COOKIES = ["lipi_workspace_id", "lipi_workspace"];

/**
 * Opaque server-side sessions. The cookie carries a random id and nothing
 * else, so it asserts no claims a client could tamper with, and revoking a
 * session is a row delete rather than a token blacklist.
 *
 * Now that the API is served from the app's own origin the cookie is
 * first-party, so `sameSite: lax` is a real defence rather than a formality.
 */
export async function createSession(userId: string) {
  const id = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + THIRTY_DAYS_MS);

  await prisma.session.create({ data: { id, userId, expiresAt } });

  const jar = await cookies();
  for (const name of WORKSPACE_COOKIES) jar.delete(name);
  jar.set(SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    expires: expiresAt,
    path: "/",
  });
}

export async function destroySession() {
  const jar = await cookies();
  const id = jar.get(SESSION_COOKIE)?.value;
  if (id) await prisma.session.deleteMany({ where: { id } });
  jar.delete(SESSION_COOKIE);
  for (const name of WORKSPACE_COOKIES) jar.delete(name);
}

export type Authed = {
  userId: string;
  email: string;
  name: string;
  workspaceIds: string[];
};

/** Returns the signed-in user, or null. Expired sessions are cleaned up on sight. */
export async function currentUser(): Promise<Authed | null> {
  const id = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!id) return null;

  const session = await prisma.session.findUnique({
    where: { id },
    include: { user: { include: { memberships: { select: { workspaceId: true } } } } },
  });
  if (!session) return null;

  if (session.expiresAt < new Date()) {
    await prisma.session.delete({ where: { id } }).catch(() => {});
    return null;
  }

  return {
    userId: session.user.id,
    email: session.user.email,
    name: session.user.name,
    workspaceIds: session.user.memberships.map((m) => m.workspaceId),
  };
}

/**
 * Whether the request carries a session cookie at all — not whether it is a
 * live one. Used to catch a request that presents both credentials, which is
 * a caller's bug rather than a choice for this app to resolve.
 */
export async function hasSessionCookie(): Promise<boolean> {
  return Boolean((await cookies()).get(SESSION_COOKIE)?.value);
}

export async function requireUser(): Promise<Authed> {
  const user = await currentUser();
  if (!user) throw new HttpError(401, "Sign in to continue");
  return user;
}
