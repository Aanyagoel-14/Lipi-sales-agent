import { json, route } from "@/server/lib/http";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { testStripe } from "@/server/payments/stripe";

/** Proves the connection still works, by the same read call the connect step used. */
export const POST = route(async () => {
  const workspaceId = await resolveWorkspaceId();
  const result = await testStripe(workspaceId);
  return json(result, result.ok ? 200 : 400);
});
