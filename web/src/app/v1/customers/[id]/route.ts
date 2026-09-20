import { HttpError, json, route } from "@/server/lib/http";
import { preflight } from "@/server/lib/origins";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { customerOut } from "../../shapes";

/** One customer twin. What an integration renders on its own account page. */
export const GET = route<{ id: string }>(async (_req, { id }) => {
  const workspaceId = await resolveWorkspaceId();
  const customer = await prisma.customer.findFirst({ where: { id, workspaceId } });
  // 404 rather than 403 for a customer in another workspace: the two are
  // indistinguishable to a caller, which is the point — an id that answers
  // differently confirms the row exists somewhere.
  if (!customer) throw new HttpError(404, "Customer not found");

  return json({ customer: customerOut(customer) });
});

export const OPTIONS = route<{ id: string }>(preflight);
