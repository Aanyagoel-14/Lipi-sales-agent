import { body, json, route } from "@/server/lib/http";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { ingest } from "@/server/services/ingest";
import { inboundSchema } from "./schema";

/**
 * The single entry point for inbound messages.
 *
 * Channel webhooks normalise into this shape and post here, so adding a
 * channel never touches the twins or the agents.
 */
export const POST = route(async (req) => {
  const data = await body(req, inboundSchema, "Invalid message");
  const workspaceId = await resolveWorkspaceId();
  return json(await ingest({ ...data, workspaceId }), 201);
});
