import { json, route } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { currentUser } from "@/server/lib/session";

export const GET = route(async () => {
  const user = await currentUser();
  if (!user) return json({ user: null });

  const workspaces = await prisma.workspace.findMany({
    where: { id: { in: user.workspaceIds } },
    select: { id: true, name: true, vertical: true, onboardedAt: true },
    orderBy: { createdAt: "asc" },
  });

  return json({ user: { id: user.userId, email: user.email, name: user.name }, workspaces });
});
