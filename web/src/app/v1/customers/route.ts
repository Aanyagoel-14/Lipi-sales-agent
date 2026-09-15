import { json, route } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { customerOut } from "../shapes";

export const GET = route(async () => {
  const workspaceId = await resolveWorkspaceId();
  const rows = await prisma.customer.findMany({ where: { workspaceId }, orderBy: { lifetimeValue: "desc" } });
  return json({ customers: rows.map(customerOut) });
});
