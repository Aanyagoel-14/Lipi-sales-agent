import { catalog } from "@/server/channels/registry";
import { json, route } from "@/server/lib/http";
import { requireUser } from "@/server/lib/session";

/**
 * What this deployment can connect at all, independent of any workspace.
 *
 * `GET /v1/channels` carries the same entries merged with the workspace's own
 * rows and is what the UI reads. This one answers the different question an
 * operator or a support engineer asks first — "is Instagram even set up
 * here?" — without a workspace in the picture. Behind the session because the
 * answer names which integrations exist and which environment keys are empty.
 */
export const GET = route(async () => {
  await requireUser();
  return json({ channels: catalog() });
});
