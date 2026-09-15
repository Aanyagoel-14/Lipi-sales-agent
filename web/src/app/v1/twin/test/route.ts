import { body, json, route } from "@/server/lib/http";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { ingest } from "@/server/services/ingest";
import { inboundSchema } from "../../messages/schema";

/** Runs the production reasoning path and rolls every write back afterwards. */
export const POST = route(async (req) => {
  const data = await body(req, inboundSchema, "Invalid test message");
  const workspaceId = await resolveWorkspaceId();
  return json(await ingest({ ...data, workspaceId }, { dryRun: true }));
});
