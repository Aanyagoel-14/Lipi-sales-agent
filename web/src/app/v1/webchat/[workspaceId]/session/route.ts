import { corsPreflight, corsRoute } from "@/server/lib/cors";
import { HttpError, body, json } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { upsertSession } from "@/server/services/webchat";
import { sessionSchema } from "../../schemas";

export const OPTIONS = corsPreflight;

/**
 * Called on every page load the widget is on — not when the visitor opens
 * the chat panel, because a load is the only moment the ad platform's own
 * query parameters are still in the address bar, and most ad traffic never
 * clicks. So `touch` is captured here and nowhere else (see attribution.ts),
 * written on the first load and left alone by every later one.
 * No session cookie: the workspace id is public (it is meant to be pasted
 * into a `<script>` tag on the operator's own site), and every write here
 * is scoped to a `visitorId` the caller itself provides.
 */
export const POST = corsRoute<{ workspaceId: string }>(async (req, { workspaceId }) => {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } });
  if (!workspace) throw new HttpError(404, "Unknown workspace");

  const data = await body(req, sessionSchema, "Check the session payload");
  const result = await upsertSession({ workspaceId, visitorId: data.visitorId, touch: data.touch });

  return json(result, 201);
});
