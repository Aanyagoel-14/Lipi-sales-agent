import { json, route } from "@/server/lib/http";
import { requireUser } from "@/server/lib/session";

/** Proves the session is real before any mutation runs behind it. */
export const GET = route(async () => json({ user: await requireUser() }));
