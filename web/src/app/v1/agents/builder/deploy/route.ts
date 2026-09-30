import { body, json, route } from "@/server/lib/http";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { deployAgent, deployRequestSchema } from "@/server/agents/deploy";

/**
 * `POST /v1/agents/builder/deploy` — PRD §8.1.
 *
 * The request body is the one the PRD prints, verbatim and in its own
 * snake_case. An upsert on the agent's name, so publishing twice edits the
 * agent rather than growing a second one.
 */
export const POST = route(async (req) => {
  const workspaceId = await resolveWorkspaceId();
  const input = await body(req, deployRequestSchema, "Invalid agent deployment");
  const agent = await deployAgent(workspaceId, input);
  return json({ agent }, 201);
});
