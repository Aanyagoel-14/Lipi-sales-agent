import { json, route } from "@/server/lib/http";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { skillCatalogue } from "@/server/agents/registry";

/**
 * `GET /v1/agents/skills` — the modular skills an agent can be assembled from
 * (PRD §2 Step 01).
 *
 * Data only. The catalogue carries no `run` and no schema object, so nothing
 * executable is ever serialised to a browser.
 */
export const GET = route(async () => {
  await resolveWorkspaceId();
  return json({ skills: skillCatalogue() });
});
