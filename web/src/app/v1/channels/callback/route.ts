import { finishConnection } from "@/server/channels/connect";
import { HttpError, route, searchParams } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";

/**
 * Where Composio's hosted consent page sends the browser back to.
 *
 * It arrives with `?status=success|failed&connected_account_id=ca_…`. The
 * status is ignored as evidence: it is a query parameter on a URL the operator
 * could edit, and it says what the page believed at redirect time rather than
 * what the account is. `finishConnection` re-reads the account from Composio
 * and proves it with a real tool call instead.
 *
 * The account id is trusted only as far as "which of this workspace's rows is
 * this about" — the row is looked up inside the workspace, and the account's
 * own `user_id` is checked against it again before anything is written.
 */
export const GET = route(async (req) => {
  const workspaceId = await resolveWorkspaceId();

  const accountId = searchParams(req).get("connected_account_id");
  if (!accountId) throw new HttpError(400, "That callback did not name a connection");

  const row = await prisma.channelConnection.findFirst({
    where: { workspaceId, composioAccountId: accountId },
  });
  if (!row) throw new HttpError(404, "No connection in progress for that account");

  const finished = await finishConnection(row);

  // 303 so the browser follows with GET, and back to the card the operator
  // started from — which now shows the truth, connected or not.
  return new Response(null, {
    status: 303,
    headers: { location: `/dashboard/channels?channel=${finished.channel}` },
  });
});
