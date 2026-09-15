import { json, route } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { eventId } from "../../events";

/** Marks setup finished. Until this runs, /onboarding resumes where it left off. */
export const POST = route(async () => {
  const workspaceId = await resolveWorkspaceId();
  const workspace = await prisma.workspace.update({
    where: { id: workspaceId },
    data: { onboardedAt: new Date() },
  });

  await prisma.twinEvent.create({
    data: {
      id: eventId(), workspaceId, occurredAt: new Date(),
      type: "workspace.ready", twin: "knowledge",
      payload: `vertical=${workspace.vertical} policy=${workspace.approvalPolicy}`,
    },
  });

  return json({ workspace });
});
