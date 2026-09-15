import { json, route } from "@/server/lib/http";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { buildBriefing } from "@/server/services/briefing";

/** What the twin currently knows, so the operator can see its grounding. */
export const GET = route(async () => json(await buildBriefing(await resolveWorkspaceId())));
