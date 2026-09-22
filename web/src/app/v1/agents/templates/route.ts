import { json, route } from "@/server/lib/http";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { agentTemplates } from "@/server/agents/templates";
import { parseGuardrails } from "@/server/agents/guardrails";

/**
 * `GET /v1/agents/templates` — step 1 of the builder (PRD §2 Step 01).
 *
 * Guardrails are returned fully defaulted rather than as the partial each
 * template declares, so the builder renders the ceilings an operator would
 * actually get rather than the handful the template bothered to state.
 */
export const GET = route(async () => {
  await resolveWorkspaceId();
  return json({
    templates: agentTemplates.map((template) => ({
      key: template.key,
      label: template.label,
      description: template.description,
      skills: template.skills,
      guardrails: parseGuardrails(template.guardrails),
    })),
  });
});
