import { json, route } from "@/server/lib/http";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { ageing, resolveInvoices, resolvePayments } from "@/server/services/billing";

export const GET = route(async () => {
  const workspaceId = await resolveWorkspaceId();
  const [buckets, invoices, payments] = await Promise.all([
    ageing(workspaceId),
    resolveInvoices(workspaceId),
    resolvePayments(workspaceId),
  ]);
  return json({ ageing: buckets, invoices, payments });
});
